// One board per Durable Object (`idFromName("<team>/<board>")`). The Worker calls `call()` for each
// protocol method; errors come back as data, since RPC doesn't carry an HttpError's status and code.
import { DurableObject } from 'cloudflare:workers'
import { HttpError } from '@vercel/board'
import { ZodError } from 'zod'
import { BoardEngine, isDuplicate, notKeptHere, type Timer } from './engine.ts'
import { BoardError } from '@vercel/board'
import { derivedId } from '../upstream/client/ids.ts'
import { ref } from '../upstream/server/feed.ts'
import { indexOf } from '../upstream/server/feed.ts'
import { bindingOf } from '../worker/backend.ts'
import { boardOf } from '../worker/boards.ts'
import { fromWire, type WireIdentity } from './identity.ts'
import type { BordeauxEnv } from '../worker/env.ts'

export type WireError = { status: number; code: string; message: string; hint?: string }
export type Envelope = { ok: true; value: unknown } | { ok: false; error: WireError }

/** The methods this board answers itself; the rest answer 501 until their milestone. */
const KEPT = ['channels', 'createChannel', 'actors', 'channelMessages', 'threads', 'message', 'posted', 'post', 'edit', 'delete', 'react', 'label', 'events', 'schemas', 'schema', 'createSchema', 'upload', 'uploadStart', 'uploadFinish', 'attachment', 'schedule', 'schedules', 'cancelSchedule', 'tasks', 'createTask', 'createTasks', 'createdTasks', 'claimReadyTask', 'claimTask', 'renewTask', 'releaseTask', 'completeTask', 'failTask', 'blockTask', 'unblockTask', 'reopenTask', 'assignTask', 'setTaskNeeds', 'cancelTask', 'watchers', 'register', 'matches', 'ack'] as const
type Kept = (typeof KEPT)[number]
const isKept = (method: string): method is Kept => (KEPT as readonly string[]).includes(method)

export function toWireError(error: unknown): WireError {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message, ...(error.hint !== undefined ? { hint: error.hint } : {}) }
  if (isDuplicate(error)) return { status: 409, code: 'duplicate_id', message: 'that id was already used for a different write' }
  if (error instanceof ZodError) return { status: 400, code: 'invalid_request', message: error.issues[0]?.message ?? 'invalid request' }
  console.error('[bordeaux]', error)
  return { status: 500, code: 'internal', message: 'internal error' }
}

export class BoardDO extends DurableObject<BordeauxEnv> {
  private readonly engine: BoardEngine

  constructor(ctx: DurableObjectState, env: BordeauxEnv) {
    super(ctx, env)
    this.engine = new BoardEngine(ctx.storage, { bucket: env.FILES ?? null, prefix: ctx.id.toString() })
    // Nothing runs until the tables have what the log has.
    void ctx.blockConcurrencyWhile(() => this.engine.ready)
  }

  /** The grants and the access session's head, for board()'s policy and the Worker's grant writes. */
  async accessState() {
    await this.engine.ready
    return this.engine.accessState()
  }

  async appendAccess(ifIndex: number, events: { type: string; payload: unknown }[]): Promise<Envelope> {
    try {
      return { ok: true, value: await this.engine.appendAccess(ifIndex, events) }
    } catch (error) {
      return { ok: false, error: toWireError(error) }
    }
  }

  /** Where the Worker streams a direct upload's bytes: the key in R2, and how many it may take. */
  async uploadTarget(id: string, secret: string): Promise<Envelope> {
    try {
      return { ok: true, value: await this.engine.uploadTarget(id, secret) }
    } catch (error) {
      return { ok: false, error: toWireError(error) }
    }
  }

  /** The board this DO is, as the Worker names it (null for the default board): what its alarm sends through. */
  private named(board: string | null | undefined) {
    if (board === undefined) return
    const key = JSON.stringify(board)
    if (this.ctx.storage.sql.exec("select 1 from bx_state where key = 'board' and data = ?", key).toArray().length === 0)
      this.ctx.storage.sql.exec("insert into bx_state (key, data) values ('board', ?) on conflict (key) do update set data = excluded.data", key)
  }

  private boardName(): string | null {
    const [row] = this.ctx.storage.sql.exec<{ data: string }>("select data from bx_state where key = 'board'").toArray()
    return row ? (JSON.parse(row.data) as string | null) : null
  }

  /** Runs every timer that's due: a schedule's send (spec 05). A send that fails is tried again later. */
  async alarm() {
    await this.engine.ready
    for (const timer of this.engine.takeDue(Date.now())) {
      try {
        if (timer.kind === 'lease.due') await this.engine.leaseDue(timer.payload, timer.name)
        else if (timer.kind === 'wake') await this.wake(timer.payload.owner)
        else await this.send(timer)
      } catch (error) {
        console.error(`[bordeaux] ${timer.name} failed:`, (error as Error).message)
        this.engine.retry(timer)
      }
    }
    await this.engine.rearm()
  }

  /**
   * Wakes a registrant that has matches (spec 04, Δ wake by URL): `POST <url>/wake`, saying which
   * watchers the board holds for it. One wake covers every match since; a failed one is tried again.
   */
  private async wake(owner: string) {
    const target = this.engine.wakeTarget(owner)
    if (!target) return
    const response = await fetch(new URL('wake', target.url.endsWith('/') ? target.url : `${target.url}/`), { method: 'POST', headers: { 'x-board-watchers': target.hash } })
    if (!response.ok && response.status !== 202) throw new Error(`${target.url} answered ${response.status} to a wake`)
  }

  /**
   * A schedule's send, as its creator, through board(): its middleware sees it as any post, and the
   * creator's access is worked out again by board()'s policy now (upstream schedules.ts `due`).
   */
  private async send(timer: Extract<Timer, { kind: 'schedule.due' }>) {
    const { id, n, at } = timer.payload
    // A timer that fires this early just waits again.
    if (Date.now() < at - 1000) return this.engine.retry({ ...timer, attempt: 0 })
    const due = await this.engine.dueSend(timer.payload)
    if ('skip' in due) return
    const { schedule } = due
    const name = this.boardName()
    boardOf(this.env, name)
    const binding = bindingOf(name)
    if (!binding) throw new Error('the board has no binding to send through')
    const access = await binding.accessNow(schedule.as.principal)
    if (!access) return this.engine.endSchedule(id, 'revoked')
    const handle = binding.handle({ identity: { ...schedule.as, principal: { ...schedule.as.principal, access } }, origin: { via: { kind: 'schedule', id }, schedule: { id, n } } })
    // A retry after the post landed gets the same ID, so the board hands back the message it already posted.
    const input = {
      id: await derivedId('board-schedule', String(id), String(n)),
      text: schedule.text,
      labels: schedule.labels,
      noSync: schedule.noSync,
      ...(schedule.attachments.length ? { attachments: schedule.attachments.map((file) => file.id) } : {}),
    }
    try {
      const posted = schedule.re === null ? await handle.post(schedule.channel, input) : await handle.reply(ref(schedule.re), input)
      this.engine.fired(id, n, at, indexOf(posted.id)!)
    } catch (error) {
      const refused = error instanceof BoardError || error instanceof HttpError ? error : null
      if (refused?.code === 'dropped') return this.engine.endSchedule(id, 'dropped')
      if (refused && (refused.status === 403 || refused.status === 404)) return this.engine.endSchedule(id, 'revoked')
      throw error
    }
  }

  /** The board's whole log as JSON lines, a page at a time (`bx export`). */
  async exportPage(after: { session: string; index: number } | null) {
    await this.engine.ready
    return this.engine.exportPage(after)
  }

  /** An export, into this board while it's empty (`bx import`). */
  async importLines(lines: string[]): Promise<Envelope> {
    try {
      return { ok: true, value: await this.engine.importLines(lines) }
    } catch (error) {
      return { ok: false, error: toWireError(error) }
    }
  }

  async call(method: string, wire: WireIdentity, input: unknown, board?: string | null): Promise<Envelope> {
    try {
      this.named(board)
      if (!isKept(method)) throw notKeptHere(method)
      const caller = fromWire(wire)
      // `tasks` is the task list's method; the engine names it apart from its task store.
      const run = (method === 'tasks' ? this.engine.tasksList : this.engine[method]) as (caller: ReturnType<typeof fromWire>, input: unknown) => Promise<unknown>
      return { ok: true, value: await run.call(this.engine, caller, input) }
    } catch (error) {
      return { ok: false, error: toWireError(error) }
    }
  }
}
