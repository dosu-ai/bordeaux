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
import { envTeam, type Team } from '../worker/team.ts'
import { bytes } from '../worker/limits.ts'
import { registry } from '../worker/registry.ts'
import { fromWire, type WireIdentity } from './identity.ts'
import type { Collected, DeadLetter, Failure, Health } from './engine.ts'
import type { Redaction } from './redact.ts'
import type { Author } from '../upstream/contract/schemas.ts'

/** What a run that's still going when the runner moves on resolves to. */
const SLOW = Symbol('slow')
import type { BordeauxEnv } from '../worker/env.ts'
import { Reloader, type CallerVersion } from './reload.ts'
export type { CallerVersion } from './reload.ts'

/**
 * How long one run of the board's own code (a watcher, a delivery, a platform event) holds up
 * the next before the runner moves on. The run isn't stopped: it keeps its lease, and its
 * outcome is recorded when it settles. `BORDEAUX_RUN_TIMEOUT_MS` changes it, for tests.
 */
const RUN_MS = 60_000

export type WireError = { status: number; code: string; message: string; hint?: string }
export type Envelope = { ok: true; value: unknown } | { ok: false; error: WireError }

/** The methods this board answers itself; the rest answer 501. */
const KEPT = ['channels', 'createChannel', 'actors', 'channelMessages', 'threads', 'message', 'posted', 'post', 'edit', 'delete', 'react', 'label', 'events', 'schemas', 'schema', 'createSchema', 'upload', 'uploadStart', 'uploadFinish', 'attachment', 'schedule', 'schedules', 'cancelSchedule', 'tasks', 'createTask', 'createTasks', 'createdTasks', 'claimReadyTask', 'claimTask', 'renewTask', 'releaseTask', 'completeTask', 'failTask', 'blockTask', 'unblockTask', 'reopenTask', 'assignTask', 'setTaskNeeds', 'cancelTask', 'watchers', 'register', 'matches', 'ack', 'synced', 'linked', 'syncImport', 'syncReceipt', 'syncThread', 'syncFind', 'syncCopies', 'inboxPush', 'inboxNext', 'inboxAck', 'inbox', 'typing', 'readSource', 'joinSource'] as const
type Kept = (typeof KEPT)[number]

/**
 * What a hosted team over its data limit can't do (spec 09, "Limits"): everything that adds to the
 * board, but deleting a message and canceling a schedule, which stop more coming.
 */
const WRITES = new Set(['createChannel', 'post', 'edit', 'react', 'label', 'schedule', 'createSchema', 'upload', 'uploadStart', 'uploadFinish', 'createTask', 'createTasks', 'claimReadyTask', 'claimTask', 'renewTask', 'releaseTask', 'completeTask', 'failTask', 'blockTask', 'unblockTask', 'reopenTask', 'assignTask', 'setTaskNeeds', 'cancelTask', 'register', 'syncImport', 'syncReceipt', 'syncThread', 'inboxPush', 'joinSource'])

/** How often a hosted board tells its team's directory what it stores, at most. */
const REPORT_MS = 60_000
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
  /** Resets this instance once a newer Worker version calls it and it's idle (spec 08, "Deploys"). */
  private readonly reloader: Reloader
  /** A hosted board's last report to its team's directory, and the team's totals it answered. */
  private usage = { at: 0, data: 0, files: 0 }

  constructor(ctx: DurableObjectState, env: BordeauxEnv) {
    super(ctx, env)
    this.engine = new BoardEngine(ctx.storage, {
      bucket: env.FILES ?? null,
      prefix: ctx.id.toString(),
      // board() for this board, in this isolate: its own sync's entries, links, and typing.
      binding: () => {
        const { team, name } = this.boardRef()
        if (!team) return null
        boardOf(this.env, team, name)
        return bindingOf(team.id, name)
      },
    })
    this.reloader = new Reloader(ctx, () => this.env.CF_VERSION_METADATA, () => this.engine.hurry())
    // Nothing runs until the tables have what the log has.
    void ctx.blockConcurrencyWhile(() => this.engine.ready)
  }

  /** The grants and the access session's head, for board()'s policy and the Worker's grant writes. */
  async accessState() {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.accessState()
    })
  }

  async appendAccess(ifIndex: number, events: { type: string; payload: unknown }[]): Promise<Envelope> {
    return this.reloader.spell(async () => {
      try {
        return { ok: true, value: await this.engine.appendAccess(ifIndex, events) }
      } catch (error) {
        return { ok: false, error: toWireError(error) }
      }
    })
  }

  /** The syncs registered here, for the Worker's discovery to list. */
  async registeredSync() {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.registeredSync()
    })
  }

  /** Where the Worker streams a direct upload's bytes: the key in R2, and how many it may take. */
  async uploadTarget(id: string, secret: string): Promise<Envelope> {
    return this.reloader.spell(async () => {
      try {
        return { ok: true, value: await this.engine.uploadTarget(id, secret) }
      } catch (error) {
        return { ok: false, error: toWireError(error) }
      }
    })
  }

  /**
   * The board this DO is, as the Worker names it (null for the default board), and its team, as
   * the Worker last handed it over: what its alarm sends through. A self-hosted team is the env's,
   * read fresh, so it isn't kept.
   */
  private named(board: string | null | undefined, team: Team | undefined) {
    for (const [key, value] of [['board', board], ['team', team?.id === 'default' ? undefined : team]] as const) {
      if (value === undefined) continue
      const data = JSON.stringify(value)
      if (this.ctx.storage.sql.exec('select 1 from bx_state where key = ? and data = ?', key, data).toArray().length === 0)
        this.ctx.storage.sql.exec('insert into bx_state (key, data) values (?, ?) on conflict (key) do update set data = excluded.data', key, data)
    }
  }

  /** This DO's board and team: a DO no Worker has named a team to is the deployment's own team's. */
  private boardRef(): { team: Team | null; name: string | null } {
    const rows = this.ctx.storage.sql.exec<{ key: string; data: string }>("select key, data from bx_state where key in ('board', 'team')").toArray()
    const found = Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.data) as unknown]))
    // A hosted board no Worker has called yet has no team to act for.
    const team = (found.team as Team | undefined) ?? (this.env.BORDEAUX_HOSTED_URL ? null : envTeam(this.env))
    return { team, name: (found.board as string | null | undefined) ?? null }
  }

  /** Whether the team is active, as the registry said in the last 5 minutes: self-hosted, always. */
  private active = { until: 0, ok: true }

  /**
   * Whether this board may send anything out now: a suspended or uninstalled hosted team's
   * schedules and wakes wait (spec 09), as its requests are refused at the Worker.
   */
  private async teamActive(): Promise<boolean> {
    const { team } = this.boardRef()
    if (!team || team.id === 'default') return true
    if (this.active.until > Date.now()) return this.active.ok
    const record = await registry(this.env).byId(team.id)
    this.active = { until: Date.now() + 5 * 60_000, ok: record?.state === 'active' }
    return this.active.ok
  }

  /** Runs every timer that's due: a schedule's send (spec 05). A send that fails is tried again later. */
  async alarm() {
    return this.reloader.spell(() => this.alarmed())
  }

  private async alarmed() {
    await this.engine.ready
    for (const timer of this.engine.takeDue(Date.now())) {
      try {
        // A task's lease running out sends nothing; what would wait until the team is back.
        if (timer.kind !== 'lease.due' && !(await this.teamActive())) {
          this.engine.later(timer, Date.now() + 5 * 60_000)
          continue
        }
        if (timer.kind === 'lease.due') await this.engine.leaseDue(timer.payload, timer.name)
        else if (timer.kind === 'wake') await this.wake(timer)
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
    const { team, name } = this.boardRef()
    if (!team) return
    boardOf(this.env, team, name)
    const binding = bindingOf(team.id, name)
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
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.failures()
    })
  }

  // --- What the board's TailDO follows: a reload hurries `tailFollow`, so it never waits long on one. ---

  /** The log's head and who's who as of it: where a TailDO starts. */
  async tailStart() {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.tailStart()
    })
  }

  /**
   * The board's events after `after`, or the first within `waitMs`: a TailDO's one long-poll. It
   * says which version the board runs, so a TailDO on older code reloads too.
   */
  async tailFollow(after: number, waitMs: number) {
    return this.reloader.spell(async () => {
      await this.engine.ready
      const events = await this.engine.follow(after, waitMs)
      const own = this.env.CF_VERSION_METADATA
      return { events, version: own ? { id: own.id, timestamp: own.timestamp } : undefined }
    })
  }

  /** The board's events in [gte, lte], 500 at most. */
  async tailHistory(gte: number, lte: number) {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.history(gte, lte)
    })
  }

  /** Messages as they were at `index`. */
  async tailMessagesAt(ids: number[], index: number) {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.messagesAt(ids, index)
    })
  }

  /**
   * The board's bookkeeping at a glance: queues, dead letters, the latest failure, timers, and
   * the Worker version this instance runs. It carries no caller version, so it never reloads it.
   */
  async health(): Promise<Health & { version: string | null }> {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return { ...this.engine.health(), version: this.env.CF_VERSION_METADATA?.id ?? null }
    })
  }

  /** Runs retention now (`bdx gc`, and the Worker's daily cron). */
  async gc(): Promise<Collected> {
    await this.engine.ready
    return this.reloader.spell(() => this.engine.gc())
  }

  /** What the board's queues gave up on after their last try, newest first. */
  async deadLetters(): Promise<DeadLetter[]> {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.deadLetters()
    })
  }

  /** Scrubs a message out of the board (spec 02, "Redaction"; `bdx redact`). */
  async redact(by: Author, id: string, reason: string): Promise<Envelope> {
    return this.reloader.spell(async () => {
      try {
        await this.engine.ready
        return { ok: true, value: await this.engine.redact(by, id, reason) }
      } catch (error) {
        return { ok: false, error: toWireError(error) }
      }
    })
  }

  /** Every redaction on this board, oldest first. */
  async redactions(): Promise<Redaction[]> {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.redactions()
    })
  }

  /** Puts a dead letter back on its queue: false when there's no such one. */
  async replayDead(id: string): Promise<boolean> {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.replayDead(id)
    })
  }

  /**
   * Wakes a registrant that has matches (spec 04, Δ wake by URL): `POST <url>/wake`, saying which
   * watchers the board holds for it. One wake covers every match since; a failed one is tried again.
   */
  private async wake(timer: Extract<Timer, { kind: 'wake' }>) {
    const target = this.engine.wakeTarget(timer.payload.owner)
    if (!target) return
    // A hosted team's wakes past its limit wait: one wake covers every match until it goes.
    const { team } = this.boardRef()
    if (team?.limits && this.env.WAKE_LIMITER && !(await this.env.WAKE_LIMITER.limit({ key: team.id })).success) return this.engine.later(timer, Date.now() + 10_000)
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
    const { team, name } = this.boardRef()
    if (!team) throw new Error('the board has no team to send as')
    boardOf(this.env, team, name)
    const binding = bindingOf(team.id, name)
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

  /** The board's whole log as JSON lines, a page at a time (`bdx export`). */
  async exportPage(after: { session: string; index: number } | null) {
    return this.reloader.spell(async () => {
      await this.engine.ready
      return this.engine.exportPage(after)
    })
  }

  /** An export, into this board while it's empty (`bdx import`). */
  async importLines(lines: string[]): Promise<Envelope> {
    return this.reloader.spell(async () => {
      try {
        return { ok: true, value: await this.engine.importLines(lines) }
      } catch (error) {
        return { ok: false, error: toWireError(error) }
      }
    })
  }

  async call(method: string, wire: WireIdentity, input: unknown, board?: string | null, version?: CallerVersion, team?: Team): Promise<Envelope> {
    this.reloader.newer(version)
    return this.reloader.spell(() => this.answer(method, wire, input, board, team))
  }

  private async answer(method: string, wire: WireIdentity, input: unknown, board?: string | null, team?: Team): Promise<Envelope> {
    try {
      this.named(board, team)
      if (!isKept(method)) throw notKeptHere(method)
      const caller = fromWire(wire)
      const limits = (team ?? this.boardRef().team)?.limits
      if (limits) this.withinLimits(limits, method, caller.principal.id, input)
      // `tasks` is the task list's method; the engine names it apart from its task store.
      const run = (method === 'tasks' ? this.engine.tasksList : this.engine[method]) as (caller: ReturnType<typeof fromWire>, input: unknown) => Promise<unknown>
      const value = await run.call(this.engine, caller, input)
      if (limits && WRITES.has(method)) await this.report(method, input)
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: toWireError(error) }
    }
  }

  /** A hosted team's limits on a call, as this board last heard its team's totals (spec 09, "Limits"). */
  private withinLimits(limits: NonNullable<Team['limits']>, method: string, owner: string, input: unknown) {
    if (WRITES.has(method) && this.usage.data > limits.dataBytes)
      throw new HttpError(413, 'limit_data', `this team's boards hold ${bytes(this.usage.data)}, over its ${bytes(limits.dataBytes)}: reading and bdx export still work`)
    const size = method === 'upload' ? (input as { data: Uint8Array }).data.byteLength : method === 'uploadStart' ? (input as { size: number }).size : 0
    if (size > 0 && this.usage.files + size > limits.fileBytes)
      throw new HttpError(413, 'limit_files', `this team's files would be over its ${bytes(limits.fileBytes)}: it has ${bytes(this.usage.files)}`)
    if (method === 'register' && this.engine.watcherCount(owner) + Object.keys((input as { watch: object }).watch).length > limits.watchers)
      throw new HttpError(403, 'limit_watchers', `a board holds at most ${limits.watchers} registered watchers`)
  }

  /**
   * After a hosted board's write: what it stores, and its files' bytes, to its team's directory, at
   * most once a minute; the team's totals come back. A file counts at once, so a burst of uploads
   * can't wait out the minute.
   */
  private async report(method: string, input: unknown) {
    if (method === 'upload') this.usage.files += (input as { data: Uint8Array }).data.byteLength
    if (method === 'uploadStart') this.usage.files += (input as { size: number }).size
    if (Date.now() - this.usage.at < REPORT_MS) return
    this.usage.at = Date.now()
    const { team, name } = this.boardRef()
    if (!team) return
    try {
      const totals = await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName(team.id)).usage(name ?? '', this.ctx.storage.sql.databaseSize, this.engine.fileBytes())
      this.usage = { at: this.usage.at, ...totals }
    } catch (error) {
      console.error('[bordeaux] the board could not report its usage:', (error as Error)?.message ?? error)
    }
  }
}
