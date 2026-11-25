// The board's log on a Durable Object's SQLite: one row per event, an index per session, atomic
// batches, and IDs that can't land twice. The DO is the log's only writer, so a write that reads
// and then appends without waiting on I/O in between is a conditional append without a retry.
import { HttpError } from '@vercel/board'
import { ZodError } from 'zod'
import { boardEvents, BOARD_SESSION, type BoardEvent } from '../upstream/contract/events.ts'

export { BOARD_SESSION }

/** An event to append: its type, payload, and an ID of its own when the writer gives one. */
export type NewEvent = { type: string; id?: string; payload: unknown }

type Row = { session: string; idx: number; id: string; type: string; payload: string; created_at: number }

const toEvent = (row: Row): BoardEvent =>
  ({ id: row.id, type: row.type, payload: JSON.parse(row.payload), index: Number(row.idx), sessionId: row.session, createdAt: new Date(Number(row.created_at)) }) as BoardEvent

/** What upstream's A2 throws for an ID already in the log, which board() answers 409 `duplicate_id`. */
export class DuplicateEventError extends Error {
  readonly code = 'DUPLICATE_EVENT_ID'
}

export function createLogTables(storage: DurableObjectStorage) {
  storage.sql.exec(`create table if not exists bx_log (
  session text not null,
  idx integer not null,
  id text not null unique,
  type text not null,
  payload text not null,
  created_at integer not null,
  primary key (session, idx)
)`)
}

type Schemas = Record<string, { parse(value: unknown): unknown }>

/** Each session's event schemas: the board's are upstream's contract. Others register theirs. */
const SCHEMAS: Record<string, Schemas> = { [BOARD_SESSION]: boardEvents as Schemas }
export const registerSession = (session: string, schemas: Schemas) => {
  SCHEMAS[session] = schemas
}

/** Checks an event's payload as its session's contract does, keeping what it parses to. */
function checked(session: string, event: NewEvent): unknown {
  const schema = SCHEMAS[session]?.[event.type]
  if (!schema) throw new Error(`no ${session} event type ${event.type}`)
  try {
    return schema.parse(event.payload)
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0]
      throw new HttpError(400, 'invalid_request', `${issue?.path.length ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'invalid event'}`)
    }
    throw error
  }
}

export class Log {
  private readonly waiters = new Set<() => void>()

  constructor(private readonly storage: DurableObjectStorage) {}

  /** The last index in `session`, 0 when it has none. */
  head(session = BOARD_SESSION): number {
    const [row] = this.storage.sql.exec<{ head: number | null }>('select max(idx) as head from bx_log where session = ?', session).toArray()
    return Number(row?.head ?? 0)
  }

  /**
   * Appends `events` to `session` in one transaction, after `alongside` runs in it with the rows
   * (the folds the DO keeps beside the log). Throws without writing anything when an ID is taken.
   */
  append(session: string, events: readonly NewEvent[], alongside?: (rows: BoardEvent[]) => void): BoardEvent[] {
    if (events.length === 0) return []
    const payloads = events.map((event) => checked(session, event))
    const ids = events.map((event) => event.id ?? crypto.randomUUID())
    if (new Set(ids).size !== ids.length) throw new DuplicateEventError('a batch names one ID twice')
    const rows = this.storage.transactionSync(() => {
      for (const id of ids)
        if (this.storage.sql.exec('select 1 from bx_log where id = ?', id).toArray().length > 0) throw new DuplicateEventError(`event ${id} is in the log already`)
      const start = this.head(session) + 1
      const at = Date.now()
      const rows = events.map((event, n) => toEvent({ session, idx: start + n, id: ids[n]!, type: event.type, payload: JSON.stringify(payloads[n]), created_at: at }))
      for (const row of rows)
        this.storage.sql.exec('insert into bx_log (session, idx, id, type, payload, created_at) values (?, ?, ?, ?, ?, ?)', session, row.index, row.id, row.type, JSON.stringify(row.payload), at)
      alongside?.(rows)
      return rows
    })
    for (const wake of [...this.waiters]) wake()
    return rows
  }

  /** Events of `session` with index in [gte, lte], in order. */
  history(range: { gte: number; lte: number }, session = BOARD_SESSION): BoardEvent[] {
    return this.storage.sql
      .exec<Row>('select * from bx_log where session = ? and idx >= ? and idx <= ? order by idx', session, range.gte, range.lte)
      .toArray()
      .map(toEvent)
  }

  /** The event an ID names, in any session. */
  byId(id: string): BoardEvent | null {
    const [row] = this.storage.sql.exec<Row>('select * from bx_log where id = ?', id).toArray()
    return row ? toEvent(row) : null
  }

  /** Resolves on the next append, or when `signal` aborts. */
  next(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        this.waiters.delete(wake)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      this.waiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
  }

  /** `session`'s events after `startAfter`, as they land. Returning the iterator stops a pending wait. */
  stream(options: { startAfter: number }, session = BOARD_SESSION): AsyncIterable<BoardEvent> {
    const log = this
    return {
      [Symbol.asyncIterator]() {
        let cursor = options.startAfter
        let buffered: BoardEvent[] = []
        const stop = new AbortController()
        return {
          async next(): Promise<IteratorResult<BoardEvent>> {
            while (!stop.signal.aborted) {
              if (buffered.length === 0) buffered = log.history({ gte: cursor + 1, lte: cursor + 200 }, session)
              const event = buffered.shift()
              if (event) {
                cursor = event.index
                return { value: event, done: false }
              }
              await log.next(stop.signal)
            }
            return { value: undefined, done: true }
          },
          async return(): Promise<IteratorResult<BoardEvent>> {
            stop.abort()
            return { value: undefined, done: true }
          },
        }
      },
    }
  }
}
