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
import type { DeadLetter, Failure, Health } from './engine.ts'

/** What a run that's still going when the runner moves on resolves to. */
const SLOW = Symbol('slow')
import type { BordeauxEnv } from '../worker/env.ts'

/**
 * How long one run of the board's own code (a watcher, a delivery, a platform event) holds up
 * the next before the runner moves on. The run isn't stopped: it keeps its lease, and its
 * outcome is recorded when it settles. `BORDEAUX_RUN_TIMEOUT_MS` changes it, for tests.
 */
const RUN_MS = 60_000

export type WireError = { status: number; code: string; message: string; hint?: string }
export type Envelope = { ok: true; value: unknown } | { ok: false; error: WireError }

/** The methods this board answers itself; the rest answer 501 until their milestone. */
const KEPT = ['channels', 'createChannel', 'actors', 'channelMessages', 'threads', 'message', 'posted', 'post', 'edit', 'delete', 'react', 'label', 'events', 'schemas', 'schema', 'createSchema', 'upload', 'uploadStart', 'uploadFinish', 'attachment', 'schedule', 'schedules', 'cancelSchedule', 'tasks', 'createTask', 'createTasks', 'createdTasks', 'claimReadyTask', 'claimTask', 'renewTask', 'releaseTask', 'completeTask', 'failTask', 'blockTask', 'unblockTask', 'reopenTask', 'assignTask', 'setTaskNeeds', 'cancelTask', 'watchers', 'register', 'matches', 'ack', 'synced', 'linked', 'syncImport', 'syncReceipt', 'syncThread', 'syncFind', 'syncCopies', 'inboxPush', 'inboxNext', 'inboxAck', 'inbox', 'typing', 'readSource', 'joinSource'] as const
type Kept = (typeof KEPT)[number]
const isKept = (method: string): method is Kept => (KEPT as readonly string[]).includes(method)

export function toWireError(error: unknown): WireError {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message, ...(error.hint !== undefined ? { hint: error.hint } : {}) }
  if (isDuplicate(error)) return { status: 409, code: 'duplicate_id', message: 'that id was already used for a different write' }
  if (error instanceof ZodError) return { status: 400, code: 'invalid_request', message: error.issues[0]?.message ?? 'invalid request' }
  console.error('[bordeaux]', error)
  return { status: 500, code: 'internal', message: 'internal error' }
}

/** The Worker version a call comes from (`version_metadata`). */
export type CallerVersion = { id: string; timestamp: string }

export class BoardDO extends DurableObject<BordeauxEnv> {
  private readonly engine: BoardEngine
  /** Calls and alarms running now: a reload waits for none. */
  private busy = 0
  /** Set once a newer Worker version called: this instance resets when it's next idle. */
  private reloading = false

  constructor(ctx: DurableObjectState, env: BordeauxEnv) {
    super(ctx, env)
    this.engine = new BoardEngine(ctx.storage, {
      bucket: env.FILES ?? null,
      prefix: ctx.id.toString(),
      // board() for this board, in this isolate: its own sync's entries, links, and typing.
      binding: () => {
        const name = this.boardName()
        boardOf(this.env, name)
        return bindingOf(name)
      },
    })
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

  /** The syncs registered here, for the Worker's discovery to list. */
  async registeredSync() {
    await this.engine.ready
    return this.engine.registeredSync()
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
    return this.spell(() => this.alarmed())
  }

  private async alarmed() {
    await this.engine.ready
    for (const timer of this.engine.takeDue(Date.now())) {
      try {
        if (timer.kind === 'lease.due') await this.engine.leaseDue(timer.payload, timer.name)
        else if (timer.kind === 'wake') await this.wake(timer.payload.owner)
        else if (timer.kind === 'run') await this.runOwn()
        else await this.send(timer)
      } catch (error) {
        console.error(`[bordeaux] ${timer.name} failed:`, (error as Error).message)
        this.engine.retry(timer)
      }
    }
    await this.engine.rearm()
  }

  /**
   * Runs the board's own work that's due (spec 04 config watchers, spec 06 sync): each watcher's
   * match and each sync delivery through board()'s `run`, and each platform event through its
   * `receive`, one item per lane at a time. One that throws is tried again later.
   */
  private async runOwn() {
    const name = this.boardName()
    boardOf(this.env, name)
    const binding = bindingOf(name)
    if (!binding) return
    const until = Date.now() + 10 * 60_000
    const runMs = Number(this.env.BORDEAUX_RUN_TIMEOUT_MS) || RUN_MS
    while (Date.now() < until) {
      const items = await this.engine.leaseOwn(10)
      if (items.length === 0) return
      for (const item of items) {
        const meta = { trigger: item.id, attempt: item.attempt + 1 }
        const signal = AbortSignal.timeout(runMs)
        const ran = (item.queue.startsWith('@inbox:')
          ? binding.receive(item.queue.slice('@inbox:'.length), item.event as never, { id: item.id, attempt: item.attempt + 1, signal })
          : binding.run(item.queue, item.event as never, meta)
        ).then(
          () => undefined,
          (error: unknown) => error ?? new Error('failed'),
        )
        const outcome = await Promise.race([ran, new Promise<typeof SLOW>((resolve) => setTimeout(() => resolve(SLOW), runMs))])
        if (outcome === SLOW) {
          // Still running: it keeps its lease, so nothing runs it twice, and it's acked when it settles.
          this.ctx.waitUntil(ran.then((error) => this.finish(item, error)))
          continue
        }
        await this.finish(item, outcome)
      }
    }
  }

  /** Records how a run of the board's own code went: done, or an error it's tried again for. */
  private async finish(item: { id: string; queue: string; lease: string; attempt: number }, error: unknown) {
    if (error === undefined) return this.engine.ackOwn(item.id, item.lease)
    this.engine.noteFailure(item.queue, item.id, item.attempt + 1, error)
    await this.engine.ackOwn(item.id, item.lease, (((error as Error)?.message || String(error)) || 'failed').slice(0, 500))
  }

  /** The board's own runs, and matches, that failed lately, newest first, for an operator to read. */
  async ownFailures(): Promise<Failure[]> {
    await this.engine.ready
    return this.engine.failures()
  }

  /** The board's bookkeeping at a glance: queues, dead letters, the latest failure, timers. */
  async health(): Promise<Health> {
    await this.engine.ready
    return this.engine.health()
  }

  /** What the board's queues gave up on after their last try, newest first. */
  async deadLetters(): Promise<DeadLetter[]> {
    await this.engine.ready
    return this.engine.deadLetters()
  }

  /** Puts a dead letter back on its queue: false when there's no such one. */
  async replayDead(id: string): Promise<boolean> {
    await this.engine.ready
    return this.engine.replayDead(id)
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

  /**
   * Notes a call from a newer Worker version than this instance runs. Δ (upstream runs on
   * Vercel, where a deploy starts fresh functions): a DO keeps its code and env while it's in
   * use, and a board a client long-polls is always in use, so a deploy, or a new secret, never
   * reached it. This instance resets itself once it's idle, and its next request loads the new
   * version. It resets once per newer version, so a DO a gradual deployment keeps on the old
   * version doesn't reset over and over.
   */
  private newer(version: CallerVersion | undefined) {
    const own = this.env.CF_VERSION_METADATA
    if (!version || !own || this.reloading || version.id === own.id || !(version.timestamp > own.timestamp)) return
    const [row] = this.ctx.storage.sql.exec<{ data: string }>("select data from bx_state where key = 'reloaded-for'").toArray()
    if (row && JSON.parse(row.data) === version.id) return
    this.ctx.storage.sql.exec("insert into bx_state (key, data) values ('reloaded-for', ?) on conflict (key) do update set data = excluded.data", JSON.stringify(version.id))
    this.reloading = true
    // A long-poll keeps this instance busy for as long as it waits: they answer now instead.
    this.engine.hurry()
  }

  /** Runs `work` as one of this instance's busy spells; a reload that's waiting happens after the last. */
  private async spell<T>(work: () => Promise<T>): Promise<T> {
    this.busy++
    try {
      return await work()
    } finally {
      this.busy--
      // After this answer has gone: an abort ends every request still running here.
      if (this.reloading && this.busy === 0)
        setTimeout(() => {
          if (this.busy > 0) return
          console.log(`[bordeaux] a newer Worker version called: reloading`)
          this.ctx.abort('a newer Worker version is deployed')
        }, 0)
    }
  }

  async call(method: string, wire: WireIdentity, input: unknown, board?: string | null, version?: CallerVersion): Promise<Envelope> {
    this.newer(version)
    return this.spell(() => this.answer(method, wire, input, board))
  }

  private async answer(method: string, wire: WireIdentity, input: unknown, board?: string | null): Promise<Envelope> {
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
