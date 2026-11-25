// The board, kept in one Durable Object. A port of upstream's engine (src/server/a2.ts for the
// protocol methods, src/server/writes.ts for the write rules) at the pinned commit, on the DO's log
// and upstream's own tables (src/upstream/store/sql.ts), with its views and feed vendored as they are.
//
// What's different from upstream: the DO is the log's only writer, so a write looks at the board and
// appends in one critical section (`exclusive`) instead of a conditional append that retries when
// the head moves, and the tables apply each write before it answers instead of through a consumer.
import { HttpError, type Identity, type MessageView, type Protocol, type ScheduleView } from '@vercel/board'
import type { Access, Permission } from '@vercel/board/access'
import { derivedId, isKeyIdOf } from '../upstream/client/ids.ts'
import { ALONG_MAX, BOARD_SESSION, type BoardEvent } from '../upstream/contract/events.ts'
import { foldMessages, type ActorsState, type Channel, type Message, type MessagesState } from '../upstream/contract/folds.ts'
import { extractMentions, isEmail, replaceMentions } from '../upstream/contract/mentions.ts'
import { own } from '../upstream/contract/own.ts'
import { platformProfile } from '../upstream/contract/profiles.ts'
import { ATTACHMENTS_PER_MESSAGE_MAX, EDITED_HOLD, MESSAGE_TEXT_MAX, type Attachment, type Author } from '../upstream/contract/schemas.ts'
import { actorSeen, ownedActor } from '../upstream/server/actors.ts'
import { wroteAs } from '../upstream/server/auth.ts'
import { badRequest, duplicateId, forbidden, notFound, textTooLong } from '../upstream/server/errors.ts'
import { indexOf, lastFeed, linkedIds, pollFeed, readableFilter, ref, toMessageFilter, verifiedRecord, view, viaOfRecord, type Reader } from '../upstream/server/feed.ts'
import type { BoardSession } from '../upstream/server/a2.ts'
import type { BoardReads } from '../upstream/server/reads.ts'
import { sqlTables } from '../upstream/store/sql.ts'
import type { MessageFilter, MessageTables, ThreadPosition } from '../upstream/store/types.ts'
import { createTables, doDb } from './db.ts'
import { createLogTables, DuplicateEventError, Log, registerSession, type NewEvent } from './log.ts'
import { ACCESS_SESSION, accessEvents, foldAccess, startingAccess, type AccessState } from './access.ts'
import { attachmentNotFound, createFileTables, Files } from './files.ts'
import { createdBy, emptySchedules, foldSchedules, nextSend, scheduleEvents, scheduleView, SCHEDULES_SESSION, storedPrincipal, timing, type Schedule, type SchedulesState } from './schedules.ts'
import { emptySchemas, findSchema, foldSchemas, listSchemas, registering, schemaEvents, schemaView, SCHEMAS_SESSION, type SchemasState } from './schemas.ts'

registerSession(ACCESS_SESSION, accessEvents)
registerSession(SCHEMAS_SESSION, schemaEvents)
registerSession(SCHEDULES_SESSION, scheduleEvents)

/** A timer the DO's alarm runs: a schedule's send due at `at`, or the end of a task's lease. */
export type Timer =
  | { name: string; dueAt: number; kind: 'schedule.due'; payload: { id: number; n: number; at: number }; attempt: number }
  | { name: string; dueAt: number; kind: 'lease.due'; payload: { id: number; epoch: number; at: number }; attempt: number }
  | { name: string; dueAt: number; kind: 'wake'; payload: { owner: string }; attempt: number }
  | { name: string; dueAt: number; kind: 'run'; payload: Record<string, never>; attempt: number }

/** A schedule's text as its creator sees it where it can't read (upstream a2.ts `blindSchedule`). */
const blindSchedule = (schedule: ScheduleView, access: Access, ownActor: string): ScheduleView =>
  access.readable(schedule.channel) ? schedule : { ...schedule, text: blindText(schedule.text, ownActor) }
import { createViewTables, Views } from './views.ts'
import { seenFor, type Along, type AlongEach, type WriteContext } from './writes.ts'
import { createTasks, LEASE_MIN_S, taskLimits } from './tasks.ts'
import type { BoardBinding } from '@vercel/board'
import { FULL_ACCESS } from '../upstream/server/access.ts'
import { viaOf } from '../upstream/server/actors.ts'
import { authenticates } from '../upstream/server/auth.ts'
import { importedHandle, shownName, userIdOf } from '../upstream/contract/profiles.ts'
import { platformAvatar } from '../upstream/contract/schemas.ts'
import type { ExternalAuthor, Link, Origin } from '../upstream/contract/external.ts'
import type { Actor, ExternalCopy } from '../upstream/contract/folds.ts'
import { INBOX_EVENT_ID_MAX } from '../upstream/api/routes.ts'
import type { SyncEntrySpec } from '../upstream/server/watchers-hash.ts'
import { pullInbox } from './watchers.ts'
import { ack as ackMatch, emptyQueue, foldQueue, leaseAll, matchesFor, OWN, pull, viewOf, watchersHash, type QueueState, type Registration, type RegistryState } from './watchers.ts'
import { compileWatcher } from '../upstream/server/watch-spec.ts'
import { RemoteWatcherId } from '../upstream/contract/schemas.ts'
import { TASK_BATCH_MAX } from '../upstream/contract/schemas.ts'

type Caller = Identity & { request: boolean; schedule?: { id: number; n: number }; via?: string }

/** How an import writes (upstream writes.ts): as the platform user, from its sync key, checked by the sync that brought it. */
type ImportOpts = { from?: string | null; trusted?: boolean; asAuthor?: boolean; introduces?: Actor[] }
/** What a post an import makes carries beside a post's own (upstream writes.ts `PostInput`). */
type PostExtra = { origin?: Origin | null; from?: string | null; importedBy?: string; links?: Link[]; introduces?: Actor[] }

/** board()'s own sync, as opposed to a sync elsewhere that uses this board (upstream a2.ts `ownSync`). */
const ownSync = (caller: Caller) => caller.via === 'engine'

/** The `actor.seen` of each platform user an import's text mentions that the board hasn't met (upstream writes.ts `metBy`). */
function metBy(introduces: readonly Actor[] | undefined, actors: ActorsState, author: string) {
  const met = new Set([author])
  return (introduces ?? []).flatMap((actor) => {
    if (met.has(actor.id) || own(actors.byId, actor.id)) return []
    met.add(actor.id)
    const seen = actorSeen(actor, actors)
    return seen ? [seen] : []
  })
}

/** A platform user, writing through sync (upstream a2.ts `externalIdentity`). */
function externalIdentity(author: ExternalAuthor, through: Identity['principal'] | null, platform: string): Caller {
  const id = through === null ? author.id : `${through.id}+${author.id}`
  const host = through?.facts?.issuer === 'host' ? { facts: through.facts } : {}
  const principal = { id: through?.id ?? author.id, kind: 'external' as const, handle: author.handle, access: FULL_ACCESS, expiresAt: null, ...host }
  return {
    request: false,
    principal,
    author: { actor: id, principal: principal.id, profile: through === null ? null : author.id },
    actor: {
      id,
      kind: 'external',
      handle: through === null ? author.handle : importedHandle(viaOf(through).name, author.handle, userIdOf(author.id)),
      name: author.name,
      avatar: platformAvatar(author.avatar),
      ...(through === null ? {} : { via: viaOf(through) }),
      platform,
      ...(through !== null && !through.id.startsWith('board:') ? { verified: true as const } : {}),
    } as Identity['actor'],
  }
}

const hexOf = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, '0')).join('')
type In<M extends keyof Protocol> = Protocol[M]['input']
type Out<M extends keyof Protocol> = Protocol[M]['output']

const CHANNELS_LIMIT_DEFAULT = 100
const THREADS_LIMIT_DEFAULT = 50

/** A cursor or message ref in a request, as this board's log index (upstream a2.ts). */
function cursorAt(value: string): number {
  const index = indexOf(value)
  if (index === null) throw badRequest(`${value} isn't a cursor or a message ID on this board`, 'invalid_cursor')
  return index
}

/** A `/threads` page's `older`: where its oldest thread stands, its latest message's index then its root's. */
const olderRef = (position: ThreadPosition) => `${position.at}.${position.id}`

function olderAt(value: string): ThreadPosition {
  const match = /^(\d{1,15})\.(\d{1,15})$/.exec(value)
  if (!match) throw badRequest(`${value} isn't a page of threads on this board`, 'invalid_cursor')
  return { at: Number(match[1]), id: Number(match[2]) }
}

/** The message a ref names, as its log index, or a 404. */
function messageAt(value: string): number {
  const index = indexOf(value)
  if (index === null || index === 0) throw notFound(`message not found: #${value}`, 'message_not_found')
  return index
}

/** A reply's `after`, as the index of a message; one that isn't one is 0, which names no message. */
const afterAt = (value: string | undefined): number | undefined => (value === undefined ? undefined : (indexOf(value) ?? 0))

/** `idempotentId`'s shape: the IDs the board derives for its own writes, which no request posts with. */
const DERIVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const PHRASE: Record<Permission, (channel: string) => string> = {
  read: (channel) => `read ${channel}`,
  post: (channel) => `post in ${channel}`,
  react: (channel) => `react in ${channel}`,
  label: (channel) => `label in ${channel}`,
  sync: (channel) => `sync in ${channel}`,
  manage: (channel) => `manage ${channel}`,
}

/** `permission` in `channel`, or a 403; what the caller can't read answers `hidden` instead (upstream access.ts `authorize`). */
function authorize(access: Access, permission: Permission, channel: string, hidden?: () => Error) {
  if (hidden && !access.readable(channel)) throw hidden()
  if (!access.can(permission, channel)) throw forbidden(`this token can't ${PHRASE[permission](channel)}`)
}

const messageNotFound = (id: number) => () => notFound(`message not found: #${id}`, 'message_not_found')

/** The actors with a write's author as the board now records them (upstream writes.ts `knownWith`). */
const knownWith = (actors: ActorsState, identity: Identity, seen: ReturnType<typeof seenFor>): ActorsState =>
  seen
    ? { ...actors, byId: { ...actors.byId, [identity.actor.id]: { ...identity.actor, ...(seen.payload.host ? { host: true as const } : {}), ...(seen.payload.verified ? { verified: true as const } : {}) } } }
    : actors

/** Whether `identity` wrote `message`, to change it as its author (upstream writes.ts `authored`). */
const authored = (message: Message, identity: Identity) =>
  message.by.principal === identity.principal.id && (platformProfile(identity.author.profile) === null || message.by.actor === identity.author.actor)

const sameAuthor = (a: Author, b: Author) => a.actor === b.actor && a.principal === b.principal && a.profile === b.profile

/** A message's text for its writer where it can't read: each exact mention but of itself shows as `@…`. */
const blindText = (text: string, ownActor: string) => replaceMentions(text, (token) => (token.kind === 'actor' && token.actor !== ownActor ? '@…' : null))

/** A post's view for its writer: one that can't read the channel gets back the text it sent. */
const shownTo = (shown: MessageView, access: Access, sent: string): MessageView => (!access.readable(shown.channel) ? { ...shown, text: sent } : shown)

/** Why a task is held once its root was edited by someone who doesn't own it. */
const EDITED = 'its text was edited by someone who does not own the task'

/** The hold an edit of a task's root brings, by anyone but its owner (upstream writes.ts `heldByEdit`). */
function heldByEdit(root: Message | undefined, editor: Identity): NewEvent[] {
  const task = root?.task
  const owner = task !== undefined && wroteAs(editor, { principal: task.owner, actor: task.by }) && editor.principal.kind !== 'external'
  if (!root || root.deleted || !task || owner) return []
  if (task.state !== 'waiting' && task.state !== 'ready' && task.state !== 'claimed') return []
  return [{ type: 'task.blocked', payload: { id: root.id, thread: root.thread, kind: EDITED_HOLD, reason: EDITED, by: editor.author } }]
}

/** The cancel a delete of a task's root brings, unless it completed or was canceled (upstream writes.ts). */
function canceledByDelete(root: Message | undefined, deleter: Identity): NewEvent[] {
  const task = root?.task
  if (!root || !task || task.state === 'completed' || task.state === 'canceled') return []
  return [{ type: 'task.canceled', payload: { id: root.id, thread: root.thread, reason: 'deleted', by: deleter.author } }]
}

/** Refuses an edit or a delete at `revision` when the message changed since (upstream writes.ts `atRevision`). */
function atRevision(message: Message | undefined, id: number, revision: number) {
  const now = message ? (message.revision ?? message.id) : null
  if (now !== revision)
    throw new HttpError(409, 'revision_conflict', message?.deleted ? `#${id} was deleted since revision ${revision}` : `#${id} was edited since revision ${revision}: it's at ${now}`)
}

export const notKeptHere = (what: string) => new HttpError(501, 'not_implemented', `this bordeaux board doesn't keep ${what} yet`)

export class BoardEngine {
  readonly log: Log
  private views: Views
  readonly tables: MessageTables
  private lock: Promise<unknown> = Promise.resolve()
  /** The grants, folded from session `access`, kept beside the log in `bx_state`. */
  private access: AccessState
  /** The schema registry, folded from session `schemas`, the same way. */
  private schemaState: SchemasState
  /** The schedules, folded from session `schedules`. */
  private scheduleState: SchedulesState
  /** Registered watchers, by owner (upstream's registry). */
  private registry: RegistryState
  /** Whether matching is running now: one run at a time, from the stored position. */
  private matching: Promise<void> | null = null
  /** Resolves once the tables have every event the log has. */
  readonly ready: Promise<void>
  private readonly files: Files
  /** board()'s binding, built in this isolate: its own sync's entries, links, and typing. */
  private readonly binding: () => BoardBinding | null
  /** Tasks, as upstream's tasks.ts keeps them (src/engine/tasks.ts). */
  private readonly tasks: ReturnType<typeof createTasks>

  constructor(
    private readonly storage: DurableObjectStorage,
    options: { bucket?: R2Bucket | null; prefix?: string; binding?: () => BoardBinding | null } = {},
  ) {
    this.binding = options.binding ?? (() => null)
    createLogTables(storage)
    createFileTables(storage)
    this.files = new Files(storage, options.bucket ?? null, options.prefix ?? 'local')
    createViewTables(storage)
    createTables(storage)
    this.log = new Log(storage)
    this.views = new Views(storage)
    this.tables = sqlTables(doDb(storage))
    storage.sql.exec('create table if not exists bx_state (key text primary key, data text not null)')
    this.access = this.loadState('access', startingAccess)
    this.schemaState = this.loadState('schemas', emptySchemas)
    this.scheduleState = this.loadState('schedules', emptySchedules)
    this.registry = this.loadState('registry', () => ({ byOwner: {} }) as RegistryState)
    storage.sql.exec('create table if not exists bx_queues (owner text primary key, data text not null)')
    storage.sql.exec('create table if not exists bx_timers (name text primary key, due_at integer not null, kind text not null, payload text not null, attempt integer not null default 1)')
    this.ready = this.catchUp()
    const writes: WriteContext = {
      session: { state: (async (reducer: { name: string }) => ({ state: reducer.name === 'board.actors' ? this.views.actors : this.views.channels, index: this.log.head() })) as WriteContext['session']['state'] },
      reads: {
        tables: this.tables,
        message: (id) => this.tables.message(id),
        position: () => this.tables.position(),
        roots: (filter, page) => this.tables.roots(filter, page),
        reader: (access, messages) => this.reads.reader(access, messages),
      },
      exclusive: (write) => this.exclusive(write),
      append: (events) => this.append(events),
    }
    this.tasks = createTasks({ arm: (name, at, payload) => this.arm(name, at, { kind: 'lease.due', payload }) })
    this.tasks.bind({ writes })
  }

  /** A side session's fold, as `bx_state` keeps it, or where it starts. */
  private loadState<T>(key: string, start: () => T): T {
    const [row] = this.storage.sql.exec<{ data: string }>('select data from bx_state where key = ?', key).toArray()
    return row ? (JSON.parse(row.data) as T) : start()
  }

  /** Appends to a side session and writes its fold beside the log, in one transaction. */
  private appendSide<T>(session: string, events: readonly NewEvent[], state: T, fold: (state: T, event: BoardEvent) => void) {
    return this.log.append(session, events, (landed) => {
      for (const row of landed) fold(state, row)
      this.storage.sql.exec('insert into bx_state (key, data) values (?, ?) on conflict (key) do update set data = excluded.data', session, JSON.stringify(state))
    })
  }

  /** The grants as they are, and the access session's head, which a grant write is conditioned on. */
  accessState(): { state: AccessState; index: number } {
    return { state: this.access, index: this.log.head(ACCESS_SESSION) }
  }

  /**
   * Appends grant events only while the access session's head is still `ifIndex`: the Worker judged
   * them on that state (upstream's `ifLastIndex`). `moved` when another write landed first.
   */
  appendAccess(ifIndex: number, events: readonly NewEvent[]): Promise<{ moved: true } | { indexes: number[] }> {
    return this.exclusive(async () => {
      if (this.log.head(ACCESS_SESSION) !== ifIndex) return { moved: true as const }
      try {
        const rows = this.appendSide(ACCESS_SESSION, events, this.access, (state, row) => foldAccess(state, row as never))
        return { indexes: rows.map((row) => row.index) }
      } catch (error) {
        this.access = this.loadState('access', startingAccess)
        throw error
      }
    })
  }

  /** The tables apply what the log has past their position: after a restart that cut a write short. */
  private async catchUp() {
    for (let position = await this.tables.position(); ; ) {
      const events = this.log.history({ gte: position + 1, lte: position + 500 })
      if (events.length === 0) return
      for (const event of events) await this.tables.apply(event)
      position = events.at(-1)!.index
    }
  }

  /** Runs `write` after every write before it: a look at the board and the append it decides are one step. */
  private exclusive<T>(write: () => Promise<T>): Promise<T> {
    const run = this.lock.then(write, write)
    this.lock = run.catch(() => {})
    return run
  }

  /** Appends to the board's session, folding who's who and the channels in the same transaction, then applies the tables. */
  private async append(events: readonly NewEvent[]): Promise<BoardEvent[]> {
    // Matching starts at the first write it could see: the head before this one, once.
    this.storage.sql.exec("insert into bx_state (key, data) values ('watch-position', ?) on conflict (key) do nothing", String(this.log.head()))
    let rows: BoardEvent[]
    try {
      rows = this.log.append(BOARD_SESSION, events, (landed) => this.views.fold(landed))
    } catch (error) {
      // The transaction rolled back: so do the folds it made in memory.
      this.views = new Views(this.storage)
      throw error
    }
    for (const row of rows) if (!(await this.tables.applyNext(row))) await this.catchUp()
    // Registered watchers, and the board's own, match it before the write answers. With none, the
    // position moves with the log: a watcher added later starts from then, not from the board's start.
    if (Object.keys(this.registry.byOwner).length > 0 || this.ownRegistration()) await this.match()
    else if (rows.length > 0) this.storage.sql.exec("update bx_state set data = ? where key = 'watch-position'", String(rows.at(-1)!.index))
    return rows
  }

  /** A registrant's queue, as `bx_queues` keeps it. */
  private queueOf(owner: string): QueueState {
    const [row] = this.storage.sql.exec<{ data: string }>('select data from bx_queues where owner = ?', owner).toArray()
    return row ? (JSON.parse(row.data) as QueueState) : emptyQueue()
  }

  private saveQueue(owner: string, state: QueueState) {
    this.storage.sql.exec('insert into bx_queues (owner, data) values (?, ?) on conflict (owner) do update set data = excluded.data', owner, JSON.stringify(state))
  }

  /** Matches what the log has past the stored position against every registration, a page at a time (upstream's `board-watch` consumer). */
  match(): Promise<void> {
    if (this.matching) return this.matching
    // Cleared once it's done, and only then: a run with nothing to do settles before it's even assigned.
    const run = this.matchAll()
    this.matching = run
    const done = () => {
      if (this.matching === run) this.matching = null
    }
    run.then(done, done)
    return run
  }

  /**
   * The board's own watchers and sync, as a registration the DO matches for itself: board()'s
   * subscriptions in this isolate (the deployment's `bordeaux.config.ts`). Null when it has none.
   */
  private ownRegistration(): Registration | null {
    const binding = this.binding()
    if (!binding) return null
    const watch = Object.fromEntries(Object.entries(binding.subscriptions).flatMap(([id, sub]) => (sub.kind === 'tail' ? [[id, { tail: sub.tail }]] : [])))
    const sync = binding.subscriptions['@sync'] ? [...binding.sync] : []
    if (Object.keys(watch).length === 0 && sync.length === 0) return null
    return { owner: OWN, url: null, watch, sync, hash: '', principal: { id: OWN, kind: 'deployment', handle: 'board' }, can: FULL_ACCESS.summary(), own: true }
  }

  /** The board's own work that's due: each lane's oldest item, leased to the runner (the DO's alarm). */
  leaseOwn(limit: number) {
    return this.exclusive(async () => {
      const state = this.queueOf(OWN)
      const { events, leased } = leaseAll(state, { limit, now: Date.now() })
      for (const event of events) foldQueue(state, event)
      if (events.length > 0) this.saveQueue(OWN, state)
      return leased
    })
  }

  /** How the board's own run of an item went; one that failed is tried again later, up to 10 times (as A2 retries a consumer). */
  ackOwn(id: string, lease: string, error?: string) {
    return this.exclusive(async () => {
      const state = this.queueOf(OWN)
      try {
        for (const event of ackMatch(state, id, { lease, ...(error !== undefined ? { error } : {}) }, Date.now(), 10)) foldQueue(state, event)
      } catch {
        // Its lease ran out while it ran, and the next run has it.
      }
      this.saveQueue(OWN, state)
      // An item waiting out a retry, or a lease that ran out, comes back then.
      const later = Object.values(state.pending).map((item) => item.retryAt ?? item.lease?.until ?? Date.now()).sort((a, b) => a - b)[0]
      if (later !== undefined) this.arm(`run-${later}`, later, { kind: 'run', payload: {} })
    })
  }

  /** Matches what the log has past the stored position, a page at a time, until it has all of it. */
  private async matchAll(): Promise<void> {
    for (;;) {
      const from = this.loadState<number>('watch-position', () => this.log.head())
      const events = this.log.history({ gte: from + 1, lte: from + 200 })
      if (events.length === 0) return
      const own = this.ownRegistration()
      const registrations = [...Object.values(this.registry.byOwner), ...(own ? [own] : [])]
      const woken = new Set<string>()
      for (const event of events) {
        for (const [owner, matched] of await matchesFor(event, registrations, this.reads, this.views.actors, async (thread) => (await this.tables.byEventId(thread)) ?? undefined)) {
          const state = this.queueOf(owner)
          for (const one of matched) foldQueue(state, one)
          this.saveQueue(owner, state)
          woken.add(owner)
        }
      }
      this.storage.sql.exec("insert into bx_state (key, data) values ('watch-position', ?) on conflict (key) do update set data = excluded.data", String(events.at(-1)!.index))
      for (const owner of woken) if (this.registry.byOwner[owner]?.url) this.arm(`wake-${owner}`, Date.now(), { kind: 'wake', payload: { owner } })
      if (woken.has(OWN)) this.arm('run', Date.now(), { kind: 'run', payload: {} })
    }
  }

  /**
   * Whether `access` may have a file: one its principal uploaded, or one a message it can read
   * carries. A deleted message drops its files, so it no longer counts (upstream a2.ts).
   */
  private async attachmentReadable(principal: Identity['principal'], id: string, uploadedBy: string | null): Promise<boolean> {
    if (principal.access.readsAll || uploadedBy === principal.id) return true
    return (await this.tables.withAttachment(id)).some((message) => principal.access.readable(message.channel))
  }

  /** Files a write carries, as the board stored them: each one the caller may have, or 404 as if it didn't exist. */
  private async attachmentsFor(principal: Identity['principal'], ids: readonly string[] | undefined) {
    return Promise.all(
      [...new Set(ids ?? [])].map(async (id) => {
        const found = this.files.read(id)
        if (!found || !(await this.attachmentReadable(principal, id, found.uploadedBy))) throw attachmentNotFound(id)
        return found.attachment
      }),
    )
  }

  /** The reader of views whose links point to `linked`, for a reader that can't read every channel. */
  private async readerOf(access: Access, linked: readonly number[]): Promise<Reader> {
    if (access.readsAll) return { access, channelOf: () => undefined }
    const ids = [...new Set(linked)].filter((id) => id > 0)
    const found = ids.length === 0 ? new Map<number, Message>() : await this.tables.messagesAt(ids, await this.tables.position())
    return { access, channelOf: (id) => found.get(id)?.channel }
  }

  private readonly reads: BoardReads = {
    messagesAt: (ids, index) => this.tables.messagesAt(ids, index),
    reader: (access, messages) => this.readerOf(access, [...messages].flatMap((message) => linkedIds(message.links))),
  }

  /** The feed's view of the log (upstream's A2 session, as src/upstream/server/a2.ts shapes it). */
  private readonly session: BoardSession = {
    state: async (reducer) => ({ state: reducer.name === 'board.actors' ? this.views.actors : this.views.channels, index: this.log.head() }),
    history: async (range) => this.log.history(range),
    stream: (options) => this.log.stream(options),
  }

  /** `filter`, narrowed to the channels `access` reads among those the board has, and the index that reflects. */
  private readable(filter: MessageFilter, access: Access): { filter: MessageFilter; through: number } {
    if (access.readsAll) return { filter, through: Number.POSITIVE_INFINITY }
    return { filter: readableFilter(filter, Object.keys(this.views.channels), access), through: this.log.head() }
  }

  /** Who wrote, was mentioned by actor ID, or reacted in the channels `access` reads (upstream a2.ts `actorsIn`). */
  private async actorsIn(access: Access): Promise<Set<string>> {
    const ids = new Set<string>()
    const { filter } = this.readable({}, access)
    if (filter.channels?.length === 0) return ids
    for (let before: number | undefined; ; ) {
      const { messages } = await this.tables.messages(filter, { limit: 500, ...(before !== undefined ? { before } : {}) })
      for (const message of messages) {
        ids.add(message.by.actor)
        for (const token of extractMentions(message.text)) if (token.kind === 'actor' && !isEmail(token.actor)) ids.add(token.actor)
        for (const reactors of Object.values(message.reactions)) for (const id of reactors) ids.add(id)
      }
      if (messages.length < 500) return ids
      before = messages[0]!.id
    }
  }

  /** A message the caller may act on with `permission`; one it can't read answers 404 (upstream writes.ts). */
  private async authorizeMessage(access: Access, permission: Permission, id: number): Promise<Message> {
    const message = await this.tables.message(id)
    if (!message) throw messageNotFound(id)()
    authorize(access, permission, message.channel, messageNotFound(id))
    return message
  }

  /** Your own message, to edit or delete (upstream writes.ts `authorizeOwn`). */
  private async authorizeOwn(identity: Identity, id: number, verb: 'edit' | 'delete'): Promise<Message> {
    const { principal } = identity
    const message = await this.tables.message(id)
    if (!message) throw messageNotFound(id)()
    const readable = principal.access.readable(message.channel)
    if (!wroteAs(identity, message.by) || (!readable && !message.blind)) {
      if (!readable) throw messageNotFound(id)()
      throw forbidden(`only the author can ${verb} a message`)
    }
    authorize(principal.access, 'post', message.channel)
    return message
  }

  /** A post that landed, as its author may have it back; null for anyone else (upstream writes.ts `landedFor`). */
  private async landedFor(identity: Identity, landed: Message): Promise<MessageView | null> {
    if (!sameAuthor(landed.by, identity.author)) return null
    const { access } = identity.principal
    if (access.readable(landed.channel)) return view(landed, this.views.actors, await this.reads.reader(access, [landed]))
    if (!landed.blind) return null
    const events = this.log.history({ gte: landed.id, lte: landed.id + ALONG_MAX })
    const along = (events[0] as BoardEvent<'message.posted'>).payload.along ?? 0
    const folded: MessagesState = { byId: {}, replies: {} }
    for (const event of events.slice(0, 1 + along)) foldMessages(folded, event)
    const posted = folded.byId[landed.id]!
    return { ...view(posted, this.views.actors, await this.reads.reader(access, [posted])), text: blindText(posted.text, identity.actor.id) }
  }

  /** The post a caller's own ID already landed, as its retry gets it back (upstream writes.ts `replayOf`). */
  private async replayOf(identity: Identity, id: string | undefined, place: { channel: string; re: number | null; replyTo: number | null }, sent: string): Promise<MessageView | null> {
    if (id === undefined) return null
    const landed = await this.tables.byEventId(id)
    if (!landed) return null
    if (landed.channel !== place.channel || landed.re !== place.re || landed.replyTo !== place.replyTo) throw duplicateId()
    const shown = await this.landedFor(identity, landed)
    if (!shown) throw duplicateId()
    return shownTo(shown, identity.principal.access, sent)
  }

  // --- The protocol methods: one per route, as upstream's a2.ts has them. ---

  async channels(caller: Caller, { prefix, after, limit = CHANNELS_LIMIT_DEFAULT }: In<'channels'>): Promise<Out<'channels'>> {
    const { access } = caller.principal
    const listed = Object.values(this.views.channels)
      .filter((channel) => access.readable(channel.path) && (prefix === undefined || channel.path.startsWith(prefix)) && (after === undefined || channel.path > after))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const channels = listed.slice(0, limit)
    return { channels, cursor: ref(this.log.head()), next: listed.length > limit ? channels.at(-1)!.path : null }
  }

  /** A channel made before anything posts to it, or the one that's there (upstream writes.ts `writeChannel`). */
  createChannel(caller: Caller, { path }: In<'createChannel'>): Promise<Out<'createChannel'>> {
    const { access } = caller.principal
    authorize(access, 'read', path)
    authorize(access, 'post', path)
    return this.exclusive(async () => {
      const found = own(this.views.channels, path)
      if (found) return { channel: found, created: false }
      const seen = seenFor(caller, this.views.actors)
      await this.append([...(seen ? [seen] : []), { type: 'channel.created', payload: { channel: path, by: caller.author } }])
      return { channel: { path, lastIndex: 0, messages: 0, threads: 0 } satisfies Channel, created: true }
    })
  }

  async actors(caller: Caller, { id: only }: In<'actors'>): Promise<Out<'actors'>> {
    const { principal, actor } = caller
    const state = this.views.actors
    let seen: ((id: string) => boolean) | null = null
    if (!principal.access.readsAll) {
      const ids = await this.actorsIn(principal.access)
      ids.add(actor.id)
      seen = (id) => ids.has(id)
    }
    const wanted = only ? new Set(only) : null
    const actors = (wanted ? [...wanted].flatMap((id) => (Object.hasOwn(state.byId, id) ? [state.byId[id]!] : [])) : Object.values(state.byId))
      .filter((a) => seen === null || seen(a.id))
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .map((found) => {
        const { host: _host, via: _via, ...a } = found
        const via = viaOfRecord(found)
        return { ...a, ...(via ? { via } : {}), ...(verifiedRecord(found) ? { verified: true as const } : {}) }
      })
    return { actors, cursor: ref(this.log.head()) }
  }

  async channelMessages(caller: Caller, query: In<'channelMessages'>): Promise<Out<'channelMessages'>> {
    const { access } = caller.principal
    const { filter, through } = this.readable({ channel: { path: query.channel, subtree: false } }, access)
    const limit = query.limit ?? 50
    const { messages, position } =
      filter.channels?.length === 0
        ? { messages: [] as Message[], position: await this.tables.position() }
        : await this.tables.messages(filter, { ...(query.after !== undefined ? { after: cursorAt(query.after) } : {}), limit })
    const reader = await this.reads.reader(access, messages)
    // A page after a cursor that its limit cut short stops at its last message; any other has all there is.
    const stopped = query.after !== undefined && messages.length === limit ? messages.at(-1)!.id : position
    return { messages: messages.map((m) => view(m, this.views.actors, reader)), cursor: ref(Math.min(stopped, through)) }
  }

  async threads(caller: Caller, query: In<'threads'>): Promise<Out<'threads'>> {
    const { principal, actor } = caller
    const actors = this.views.actors
    const { filter, through } = this.readable(toMessageFilter(query, { me: { id: actor.id, handle: actor.handle }, actors, access: principal.access }), principal.access)
    const page = {
      ...(query.after !== undefined ? { after: cursorAt(query.after) } : {}),
      ...(query.before !== undefined ? { before: olderAt(query.before) } : {}),
      limit: query.limit ?? THREADS_LIMIT_DEFAULT,
    }
    const { threads, position, older } =
      filter.channels?.length === 0
        ? { threads: [], position: await this.tables.position(), ...(page.after === undefined ? { older: null } : {}) }
        : await this.tables.threads(filter, page)
    const reader = await this.reads.reader(principal.access, threads.flatMap((t) => (t.last ? [t.root, t.last] : [t.root])))
    return {
      threads: threads.map((t) => ({ message: view(t.root, actors, reader), replies: t.replies, last: t.last && view(t.last, actors, reader) })),
      cursor: ref(Math.min(position, through)),
      ...(older !== undefined ? { older: older && olderRef(older) } : {}),
    }
  }

  async message(caller: Caller, { id, after, limit }: In<'message'>): Promise<Out<'message'>> {
    const { access } = caller.principal
    const at = messageAt(id)
    const message = await this.tables.message(at)
    if (!message || !access.readable(message.channel)) throw notFound(`message not found: #${at}`, 'message_not_found')
    const cursor = await this.tables.position()
    const messages = await this.tables.thread(message.re ?? message.id)
    const [root, ...all] = messages
    const from = after === undefined ? 0 : messages.findIndex((each) => each.id === messageAt(after))
    if (from === -1) throw new HttpError(400, 'invalid_request', `after: ${after} isn't a message of this thread`)
    const rest = all.slice(from)
    const replies = limit === undefined ? rest : after === undefined ? rest.slice(-limit) : rest.slice(0, limit)
    const reader = await this.reads.reader(access, messages)
    return {
      message: view(root!, this.views.actors, reader),
      replies: replies.map((reply) => view(reply, this.views.actors, reader)),
      cursor: ref(cursor),
      // The pending schedules that reply in this thread.
      schedules: this.listSchedules({ root: root!.id }),
    }
  }

  async posted(caller: Caller, { id }: In<'posted'>): Promise<Out<'posted'>> {
    const landed = await this.tables.byEventId(id)
    const shown = landed ? await this.landedFor(caller, landed) : null
    if (!shown) throw notFound(`no post of yours has id ${id}`, 'post_not_found')
    return { message: shown }
  }

  /** A post; with `along`, a new thread's root with what makes it a task, in one append (upstream writes.ts `writePost`). */
  async post(caller: Caller, parsed: In<'post'>, along?: Along, extra: PostExtra = {}): Promise<Out<'post'>> {
    const { principal } = caller
    const { access } = principal
    if (parsed.text.length > MESSAGE_TEXT_MAX) throw textTooLong()
    if ((parsed.attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) throw badRequest(`attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
    if (parsed.sync?.length) throw notKeptHere('sync')
    const re = parsed.re === undefined ? undefined : messageAt(parsed.re)
    const labeled = Object.keys(parsed.labels ?? {}).length > 0

    // authorizePost: a root lands where it says; a reply in its root's channel, which it must read.
    let target: Message | undefined
    let channel: string
    if (re !== undefined) {
      target = await this.authorizeMessage(access, 'read', re)
      channel = target.channel
    } else {
      if (!parsed.channel) throw badRequest('a post needs a channel')
      channel = parsed.channel
    }
    authorize(access, 'post', channel)
    if (labeled) authorize(access, 'label', channel)

    // ownId: an ID that's someone else's to post with.
    const { id: given } = parsed
    if (caller.request && given !== undefined) {
      if (DERIVED_ID.test(given)) throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
      if (given.startsWith('key:') && !isKeyIdOf(given, principal.id)) throw badRequest(`id: key:… IDs derive from a client's key, and this token's are key:${principal.id}:…`)
      if (given.startsWith('sync:')) throw badRequest('id: sync:… IDs are what sync imports, under the principal that imports them')
    }

    const attachments = await this.attachmentsFor(principal, parsed.attachments)

    // writePost: where it lands, from what the board looked up.
    const sent = parsed.text
    const id = given ?? (re === undefined ? crypto.randomUUID() : undefined)
    const after = afterAt(parsed.after)
    let root: number | null = null
    let replyTo: number | null = null
    let thread: string
    if (target) {
      root = target.re ?? target.id
      replyTo = target.id === root ? null : target.id
      thread = target.thread
    } else {
      if (after !== undefined) throw badRequest('`after` is for replies', 'invalid_after')
      thread = id!
    }
    const place = { channel, re: root, replyTo }

    return this.exclusive(async () => {
      // A retry of a write that landed: what's on the board stands, whatever its `after` says now.
      const replayed = await this.replayOf(caller, given, place, sent)
      if (replayed) return { message: replayed }
      if (after !== undefined) {
        const named = await this.tables.message(after)
        if (named?.thread !== thread) throw badRequest(`after names no message in #${root}'s thread`, 'invalid_after')
        // nothingAfter: the reply lands only while `after` is still the thread's newest.
        const { messages: [newer] } = await this.tables.messages({ re: root! }, { after, limit: 1 })
        if (newer) throw new HttpError(409, 'newer_message', `#${newer.id} came after #${after}`)
      }
      const seen = seenFor(caller, this.views.actors)
      const known = knownWith(this.views.actors, caller, seen)
      // What comes with a new thread's root: its ID and thread key are known before it's written.
      const came = along ? (await along()).events({ id: this.log.head() + 1 + (seen ? 1 : 0), thread }) : []
      const met = metBy(extra.introduces, this.views.actors, caller.actor.id)
      const rows = await this.append([
        ...(seen ? [seen] : []),
        ...met,
        {
          type: 'message.posted',
          ...(id ? { id } : {}),
          payload: {
            channel,
            text: parsed.text,
            re: root,
            replyTo,
            thread,
            labels: parsed.labels ?? {},
            noSync: parsed.noSync ?? false,
            by: caller.author,
            origin: extra.origin ?? null,
            from: extra.from ?? null,
            ...(attachments.length ? { attachments } : {}),
            ...(extra.links?.length ? { links: extra.links } : {}),
            ...(extra.importedBy !== undefined ? { importedBy: extra.importedBy } : {}),
            ...(caller.schedule ? { schedule: caller.schedule } : {}),
            ...(access.readable(channel) ? {} : { blind: true as const }),
            // How many came with it, so a replay tells its own append from what was written since.
            ...(came.length > 0 ? { along: came.length } : {}),
          },
        },
        ...came,
      ])
      const posted = rows.find((row) => row.type === 'message.posted')!
      const folded: MessagesState = { byId: {}, replies: {} }
      for (const row of rows) foldMessages(folded, row)
      const message = folded.byId[posted.index]!
      return { message: shownTo(view(message, known, await this.reads.reader(access, [message])), access, sent) }
    })
  }

  /** A message an import changes, already checked against the sync that brought it. */
  private async found(id: number): Promise<Message> {
    const message = await this.tables.message(id)
    if (!message) throw messageNotFound(id)()
    return message
  }

  async edit(caller: Caller, { id, text, revision }: In<'edit'>, opts: ImportOpts = {}): Promise<Out<'edit'>> {
    if (text.length > MESSAGE_TEXT_MAX) throw textTooLong()
    const at = messageAt(id)
    return this.exclusive(async () => {
      const message = opts.trusted ? await this.found(at) : await this.authorizeOwn(caller, at, 'edit')
      if (opts.asAuthor !== false && !authored(message, caller)) throw forbidden('only the author can edit a message')
      if (message.deleted) {
        if (revision !== undefined && revision !== (message.revision ?? message.id)) throw new HttpError(409, 'revision_conflict', `#${message.id} was deleted since revision ${revision}`)
        throw badRequest('message was deleted', 'message_deleted')
      }
      if (revision !== undefined) atRevision(message, message.id, revision)
      const seen = seenFor(caller, this.views.actors)
      await this.append([
        ...(seen ? [seen] : []),
        ...metBy(opts.introduces, this.views.actors, caller.actor.id),
        { type: 'message.edited', payload: { id: message.id, thread: message.thread, text, by: caller.author, from: opts.from ?? null } },
        // A root may be a task: an edit by anyone but its owner holds it.
        ...(message.re === null ? heldByEdit(message, caller) : []),
      ])
      return { ok: true as const }
    })
  }

  async delete(caller: Caller, { id, revision }: In<'delete'>, opts: ImportOpts = {}): Promise<Out<'delete'>> {
    const at = messageAt(id)
    return this.exclusive(async () => {
      const message = opts.trusted ? await this.found(at) : await this.authorizeOwn(caller, at, 'delete')
      if (opts.asAuthor !== false && !authored(message, caller)) throw forbidden('only the author can delete a message')
      // A tombstone changes no more: deleting it again is nothing, unless the caller read it before.
      if (message.deleted) {
        if (revision !== undefined && revision !== (message.revision ?? message.id)) throw new HttpError(409, 'revision_conflict', `#${message.id} was deleted since revision ${revision}`)
        return { ok: true as const }
      }
      if (revision !== undefined) atRevision(message, message.id, revision)
      await this.append([
        // A root that's a task is canceled first, while it still wears its labels.
        ...(message.re === null ? canceledByDelete(message, caller) : []),
        { type: 'message.deleted', payload: { id: message.id, thread: message.thread, by: caller.author, from: opts.from ?? null } },
      ])
      return { ok: true as const }
    })
  }

  async react(caller: Caller, { id, emoji, remove }: In<'react'>, opts: ImportOpts = {}): Promise<Out<'react'>> {
    const at = messageAt(id)
    return this.exclusive(async () => {
      const message = opts.trusted ? await this.found(at) : await this.authorizeMessage(caller.principal.access, 'react', at)
      if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
      const seen = seenFor(caller, this.views.actors)
      await this.append([
        ...(seen ? [seen] : []),
        { type: remove ? 'reaction.removed' : 'reaction.added', payload: { id: message.id, thread: message.thread, emoji, by: caller.author, from: opts.from ?? null } },
      ])
      return { ok: true as const }
    })
  }

  async label(caller: Caller, { id, set, unset, if: expected }: In<'label'>, opts: ImportOpts = {}): Promise<Out<'label'>> {
    const at = messageAt(id)
    return this.exclusive(async () => {
      const message = opts.trusted ? await this.found(at) : await this.authorizeMessage(caller.principal.access, 'label', at)
      if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
      // labelsAre: each label is as the write says, now.
      for (const key of Object.keys(expected ?? {}).sort()) {
        const now = own(message.labels, key)
        const wanted = expected![key]
        if (now === wanted || (now === undefined && wanted === null)) continue
        throw new HttpError(409, 'label_conflict', wanted === null ? `${key} is set` : now === undefined ? `${key} isn't set` : `${key} isn't ${wanted}`)
      }
      const seen = seenFor(caller, this.views.actors)
      await this.append([
        ...(seen ? [seen] : []),
        { type: 'labels.changed', payload: { id: message.id, thread: message.thread, set: set ?? {}, unset: unset ?? [], by: caller.author } },
      ])
      return { ok: true as const }
    })
  }

  // --- Schedules (upstream a2.ts schedule, schedules, cancelSchedule, and schedules.ts) ---

  /** The schedules `visible` lets the caller see, as a query narrows them (upstream schedules.ts `list`). */
  private listSchedules(query: { all?: boolean; root?: number; channel?: string; by?: string }, visible: (schedule: Schedule) => boolean = () => true): ScheduleView[] {
    return Object.values(this.scheduleState.byId)
      .filter(visible)
      .filter((s) => (query.all ? true : s.next !== null))
      .filter((s) => (query.root === undefined ? true : s.re === query.root))
      .filter((s) => (query.channel === undefined ? true : s.channel === query.channel))
      .filter((s) => (query.by === undefined ? true : s.as.actor.id === query.by || s.as.actor.handle.toLowerCase() === query.by.toLowerCase()))
      .sort((a, b) => a.id - b.id)
      .map((s) => scheduleView(s, this.views.actors))
  }

  private appendSchedules(events: NewEvent[]) {
    try {
      return this.appendSide(SCHEDULES_SESSION, events, this.scheduleState, (state, row) => foldSchedules(state, row as never))
    } catch (error) {
      this.scheduleState = this.loadState('schedules', emptySchedules)
      throw error
    }
  }

  /** Arms a timer, once for its name, and sets the alarm to the earliest. */
  private arm(name: string, dueAt: number, what: Pick<Timer, 'kind' | 'payload'>, attempt = 1) {
    this.storage.sql.exec('insert or ignore into bx_timers (name, due_at, kind, payload, attempt) values (?, ?, ?, ?, ?)', name, dueAt, what.kind, JSON.stringify(what.payload), attempt)
    void this.rearm()
  }

  /** Sets the alarm to the earliest timer, or clears it when there's none. */
  async rearm() {
    const [row] = this.storage.sql.exec<{ due: number | null }>('select min(due_at) as due from bx_timers').toArray()
    if (row?.due === null || row?.due === undefined) await this.storage.deleteAlarm()
    else await this.storage.setAlarm(Number(row.due))
  }

  /** The timers due by `now`, taken off the table: the alarm runs each. */
  takeDue(now: number): Timer[] {
    const rows = this.storage.sql.exec<{ name: string; due_at: number; kind: string; payload: string; attempt: number }>('select * from bx_timers where due_at <= ? order by due_at', now).toArray()
    for (const row of rows) this.storage.sql.exec('delete from bx_timers where name = ?', row.name)
    return rows.map((row) => ({ name: row.name, dueAt: Number(row.due_at), kind: row.kind, payload: JSON.parse(row.payload), attempt: Number(row.attempt) }) as Timer)
  }

  /** A timer that failed, armed again a little later, up to 10 tries (as A2 retries a consumer). */
  retry(timer: Timer) {
    if (timer.attempt >= 10) {
      console.error(`[bordeaux] gave up on ${timer.name} after ${timer.attempt} tries`)
      return
    }
    this.arm(`${timer.name}#${timer.attempt + 1}`, Date.now() + Math.min(1000 * 2 ** timer.attempt, 3_600_000), timer, timer.attempt + 1)
  }

  async schedule(caller: Caller, parsed: In<'schedule'>): Promise<Out<'schedule'>> {
    if (parsed.text.length > MESSAGE_TEXT_MAX) throw textTooLong()
    const { principal } = caller
    const re = parsed.re === undefined ? undefined : messageAt(parsed.re)
    // Checked now, where the caller sees it, and again at every send (upstream authorizePost).
    let channel = parsed.channel
    let root: number | null = null
    if (re !== undefined) {
      const target = await this.authorizeMessage(principal.access, 'read', re)
      if (target.deleted) throw notFound(`message not found: #${re}`, 'message_not_found')
      root = target.re ?? target.id
      channel = target.channel
    }
    if (!channel) throw badRequest('a schedule needs a channel or a message to reply to')
    authorize(principal.access, 'post', channel)
    if (Object.keys(parsed.labels ?? {}).length > 0) authorize(principal.access, 'label', channel)
    const attachments = await this.attachmentsFor(principal, parsed.attachments)
    const when = timing(parsed, Date.now())
    return this.exclusive(async () => {
      const [row] = this.appendSchedules([
        {
          type: 'schedule.created',
          payload: {
            channel,
            re: root,
            text: parsed.text,
            labels: parsed.labels ?? {},
            noSync: parsed.noSync ?? false,
            ...(attachments.length ? { attachments } : {}),
            ...when,
            as: { author: caller.author, principal: storedPrincipal(principal), actor: caller.actor },
            ...(principal.access.readable(channel!) ? {} : { blind: true as const }),
          },
        },
      ])
      const created = this.scheduleState.byId[row!.index]!
      if (created.next !== null) this.arm(`first-${created.id}-${created.sent}`, created.next, { kind: 'schedule.due', payload: { id: created.id, n: created.sent, at: created.next } })
      return { schedule: scheduleView(created, this.views.actors) }
    })
  }

  async schedules(caller: Caller, query: In<'schedules'>): Promise<Out<'schedules'>> {
    const { principal, actor } = caller
    let root: number | undefined
    if (query.re !== undefined) {
      const at = messageAt(query.re)
      root = (await this.authorizeMessage(principal.access, 'read', at)).re ?? at
    }
    const visible = (schedule: Schedule) => principal.access.readable(schedule.channel) || createdBy(schedule, caller)
    const by = query.by === 'me' ? actor.id : query.by
    const listed = this.listSchedules({ ...query, ...(by !== undefined ? { by } : {}), ...(root !== undefined ? { root } : {}) }, visible)
    return { schedules: listed.map((schedule) => blindSchedule(schedule, principal.access, actor.id)) }
  }

  /** Its creator may cancel it while they can post there, and so may `manage` in its channel (upstream schedules.ts `cancel`). */
  async cancelSchedule(caller: Caller, { id: given }: In<'cancelSchedule'>): Promise<Out<'cancelSchedule'>> {
    const bare = given.replace(/^s{1,2}/, '')
    const id = indexOf(bare)
    const missing = () => notFound(`schedule not found: s${bare}`, 'schedule_not_found')
    if (id === null || id === 0) throw missing()
    return this.exclusive(async () => {
      const schedule = this.scheduleState.byId[id]
      if (!schedule) throw missing()
      if (!createdBy(schedule, caller)) authorize(caller.principal.access, 'manage', schedule.channel, missing)
      const canceled = schedule.next !== null
      if (canceled) this.appendSchedules([{ type: 'schedule.canceled', payload: { id, by: caller.author, reason: 'canceled' } }])
      const view = scheduleView(this.scheduleState.byId[id]!, this.views.actors)
      return { schedule: blindSchedule(view, caller.principal.access, caller.actor.id), canceled }
    })
  }

  /**
   * What a due timer does now (upstream schedules.ts `due`): nothing for one canceled, done, or
   * stale; a cancel when its thread is gone; or the schedule to send as its creator.
   */
  async dueSend({ id, n, at }: { id: number; n: number; at: number }): Promise<{ skip: true } | { schedule: Schedule }> {
    const schedule = this.scheduleState.byId[id]
    if (!schedule || schedule.next !== at || schedule.sent !== n) return { skip: true }
    if (schedule.re !== null) {
      const root = await this.tables.message(schedule.re)
      if (!root || root.deleted) {
        this.endSchedule(id, 'thread_deleted')
        return { skip: true }
      }
    }
    return { schedule }
  }

  /** A send that went out: recorded once, and the next one armed. */
  fired(id: number, n: number, at: number, message: number) {
    const schedule = this.scheduleState.byId[id]
    if (!schedule || schedule.sent !== n) return
    const next = nextSend(schedule, n, at, Date.now())
    this.appendSchedules([{ type: 'schedule.fired', payload: { id, n, message, next } }])
    if (next !== null) this.arm(`next-${id}-${n + 1}`, next, { kind: 'schedule.due', payload: { id, n: n + 1, at: next } })
  }

  /** A schedule the board ends itself: its thread is gone, its creator can't post there now, or the middleware dropped it. */
  endSchedule(id: number, reason: 'thread_deleted' | 'dropped' | 'revoked') {
    const by = { actor: 'board:schedule', principal: 'board:schedule', profile: null }
    if (this.scheduleState.byId[id]?.next !== null) this.appendSchedules([{ type: 'schedule.canceled', payload: { id, by, reason } }])
  }

  // --- Sync's records (upstream a2.ts synced, linked, syncImport … inbox). A caller with `sync`
  // in a channel speaks for platform users there. ---

  /** The caller, when it may sync somewhere; `records`: what keeps sync's records, which no narrowed caller does (upstream `needSync`). */
  private needSync(caller: Caller, what: string, records = false) {
    if (!caller.principal.access.anywhere('sync')) throw forbidden(`this token can't ${what}: it needs sync`)
    if (records && caller.principal.scope !== undefined) throw forbidden(`this token is narrowed with x-board-can, so it can't ${what}: that's its project's sync's job`)
  }

  /** This board's own sync's entries: board()'s, as the config in this isolate has them. */
  private ownEntries(): readonly SyncEntrySpec[] {
    return this.binding()?.sync ?? []
  }

  /** The sync entries a caller imports through: this board's own, or what a sync elsewhere registered (upstream `entriesOf`). */
  private entriesOf(caller: Caller, principal: string): readonly SyncEntrySpec[] {
    if (ownSync(caller)) return this.ownEntries()
    const own = this.ownEntries()
    return (this.registry.byOwner[principal]?.sync ?? []).filter((entry) => !own.some((mine) => mine.key === entry.key))
  }

  /** Whether an ID is someone this board signs in that `authenticates` can't tell by its shape (upstream `signedIn`). */
  private signedIn(id: string): boolean {
    const owners = this.registry.byOwner
    const plus = id.indexOf('+')
    if (owners[id] || (plus > 0 && owners[id.slice(0, plus)])) return true
    return [id, plus > 0 ? id.slice(0, plus) : null].some((known) => {
      const actor = known === null ? undefined : own(this.views.actors.byId, known)
      return actor !== undefined && (actor.kind !== 'external' || actor.host === true)
    })
  }

  /** Whether a caller may write as each of `users`, and each one's platform (upstream `speaksFor`). */
  private speaksFor(caller: Caller, principal: string, users: readonly { id: string }[], from: string | null): string[] {
    for (const { id } of users) if (authenticates(id) || this.signedIn(id)) throw forbidden(`${id} is someone this board signs in, not a platform user: sync can't write as them`)
    const entries = this.entriesOf(caller, principal)
    const keys = from === null ? entries : entries.filter((entry) => entry.key === from)
    if (from !== null && keys.length === 0) throw forbidden(`this token doesn't sync ${from} here: its board registers its sync entries`)
    return users.map(({ id }) => {
      const entry = keys.find(({ key }) => id.startsWith(`${key}:`))
      if (!entry) throw forbidden(`${id} isn't a user of ${keys.length ? keys.map(({ key }) => key).join(' or ') : 'a sync key this token has'}: their ID starts with its key`)
      return entry.platform
    })
  }

  /** An import's client ID as the board keeps it: a sync elsewhere's, under its own principal (upstream `importId`). */
  private async importId(caller: Caller, principal: string, id: string) {
    return ownSync(caller) ? id : `sync:${principal}:${(await hexOf(`board-sync\u001f${id}`)).slice(0, 32)}`
  }

  /** Refuses a platform origin an import can't have (upstream `claimable`). */
  private async claimable(origin: Origin, from: string | null, thread: string | null) {
    if (from === null) throw badRequest('an import with an origin names the sync key it came through: pass `from`')
    for (const location of [origin.channel, origin.thread, origin.subthread])
      if (location !== undefined && location !== null && !location.startsWith(`${from}:`)) throw badRequest(`an import's platform locations belong to its sync key: ${location} isn't ${from}'s`)
    if (origin.subthread != null && !origin.subthread.startsWith(`${origin.thread}:`)) throw badRequest(`an import's subthread is in its thread: ${origin.subthread} isn't in ${origin.thread}`)
    const owner = await this.tables.threadOf(origin.thread)
    if (owner !== null && owner !== thread) throw new HttpError(409, 'already_synced', `${origin.thread} is already synced with another thread`)
    if (owner === null && thread !== null) throw new HttpError(409, 'not_synced', `${origin.thread} isn't synced with this thread`)
    const exact = origin.subthread ?? origin.thread
    if ((await this.tables.messageOf(exact, origin.message)) !== null) throw new HttpError(409, 'already_synced', `${origin.message} in ${exact} is already on the board`)
  }

  /** The sync entry an import says it came through: one its caller syncs, or a 403 (upstream `checkSource`). */
  private checkSource(caller: Caller, principal: string, source: { key: string } | undefined) {
    if (source && !this.entriesOf(caller, principal).some((entry) => entry.key === source.key)) throw forbidden(`this token doesn't sync ${source.key} here: its board registers its sync entries`)
  }

  /** The board message an import changes: a platform message, or the root of a platform thread's (upstream `locate`). */
  private async locate(origin: { thread: string; message?: string | undefined }): Promise<number | null> {
    if (origin.message !== undefined) return this.tables.messageOf(origin.thread, origin.message)
    const thread = await this.tables.threadOf(origin.thread)
    return thread === null ? null : ((await this.tables.syncOf(thread))?.root ?? null)
  }

  /** An import's links, as the board keeps them (upstream `linksOf`). */
  private async linksOf(principal: Identity['principal'], links: readonly (Omit<Link, 'message'> & { message: string | null })[] | undefined): Promise<Link[] | undefined> {
    if (!links) return undefined
    return Promise.all(
      links.map(async ({ message: given, ...link }): Promise<Link> => {
        const id = given === null ? null : indexOf(given)
        const found = id === null || id === 0 ? null : await this.tables.message(id)
        if (!found || found.deleted || !principal.access.readable(found.channel)) return { ...link, message: null } as Link
        const author = own(this.views.actors.byId, found.by.actor)
        const snapshot = { author: author ? shownName({ name: author.name, via: viaOfRecord(author) }) : found.by.actor, text: found.text, createdAt: found.createdAt, files: found.attachments.map((file) => ({ name: file.name, url: null })) }
        return { url: link.url, message: found.id, snapshot, unavailable: null } as Link
      }),
    )
  }

  async syncImport(caller: Caller, body: In<'syncImport'>): Promise<Out<'syncImport'>> {
    this.needSync(caller, 'import', true)
    const { principal } = caller
    const mentioned = body.op === 'post' || body.op === 'edit' ? (body.mentioned ?? []) : []
    const [platform, ...platforms] = this.speaksFor(caller, principal.id, [body.author, ...mentioned], body.from) as [string, ...string[]]
    const author = externalIdentity(body.author, ownSync(caller) ? null : principal, platform)
    const may = (channel: string) => principal.access.can('sync', channel)
    const keys = ownSync(caller) ? [] : this.entriesOf(caller, principal.id).map(({ key }) => key)
    // A mention of one of its keys' users is of the platform user as this import names them.
    const asNamed = (text: string) => {
      if (keys.length === 0) return text
      const named = replaceMentions(text, (token) => (token.kind === 'actor' && keys.some((key) => token.actor.startsWith(`${key}:`)) ? `@[${principal.id}+${token.actor}]` : null))
      return named.length > MESSAGE_TEXT_MAX ? text : named
    }
    const introduces = mentioned.map((user, at) => externalIdentity(user, ownSync(caller) ? null : principal, platforms[at]!).actor as Actor)
    if (body.op === 'post') {
      if ((body.channel === undefined) === (body.re === undefined)) throw badRequest('an import needs `channel`; a reply needs `re`')
      let root: Message | null = null
      let channel = body.channel
      if (body.re !== undefined) {
        root = await this.tables.message(messageAt(body.re))
        if (!root || !principal.access.readable(root.channel)) throw notFound(`message not found: #${body.re}`, 'message_not_found')
        channel = root.channel
      }
      if (!may(channel!)) throw forbidden(`this token can't sync in ${channel}, so it can't import there`)
      const id = body.id === undefined ? undefined : await this.importId(caller, principal.id, body.id)
      const attachments = await this.attachmentsFor(principal, body.attachments)
      const commit = async () => {
        const parsed = { ...(body.channel !== undefined ? { channel: body.channel } : { re: body.re }), text: asNamed(body.text), labels: body.labels ?? {}, noSync: body.noSync, id, after: body.after, attachments: attachments.map((file) => file.id) } as In<'post'>
        const { message } = await this.post(author, parsed, undefined, {
          origin: body.origin ?? null,
          from: body.from,
          ...(body.origin && !ownSync(caller) ? { importedBy: principal.id } : {}),
          ...(body.links ? { links: await this.linksOf(principal, body.links) } : {}),
          introduces,
        })
        return message.id
      }
      // A retry of one that landed: it stands.
      if (id !== undefined && (await this.tables.byEventId(id))) return { message: await commit() }
      if (body.origin) await this.claimable(body.origin, body.from, root?.thread ?? null)
      this.checkSource(caller, principal.id, body.source)
      return { message: await commit() }
    }
    if ((body.origin === undefined) === (body.message === undefined)) throw badRequest('a change names its message by `origin` or by `message`, one or the other')
    const at = body.origin !== undefined ? await this.locate(body.origin) : indexOf(body.message!)
    const found = at === null || at === 0 ? null : await this.tables.message(at)
    if (!found || !may(found.channel)) return { message: null }
    const ref_ = ref(found.id)
    // A platform's own edit or delete is what the platform did; one named by board ID is the author's, only of their own.
    const opts: ImportOpts = { trusted: true, from: body.from, asAuthor: body.origin === undefined, introduces }
    if (body.op === 'edit') {
      if (!found.deleted && !(opts.asAuthor && found.by.actor !== author.author.actor)) this.checkSource(caller, principal.id, body.source)
      await this.edit(author, { id: ref_, text: asNamed(body.text), revision: body.revision }, opts)
    } else if (body.op === 'delete') await this.delete(author, { id: ref_, revision: body.revision }, opts)
    else if (body.op === 'react') await this.react(author, { id: ref_, emoji: body.emoji, remove: body.remove ?? false }, opts)
    else if (body.op === 'labels') await this.label(author, { id: ref_, set: body.set, unset: body.unset, if: body.if }, opts)
    else {
      const links = (await this.linksOf(principal, body.links)) ?? []
      await this.exclusive(async () => {
        if (!found.deleted) await this.append([{ type: 'message.linked', payload: { id: found.id, thread: found.thread, links, by: author.author, from: body.from } }])
      })
    }
    return { message: ref_ }
  }

  /** Refuses a delivery receipt a caller's sync can't have made (upstream `deliverable`). */
  private async deliverable(caller: Caller, principal: string, message: Message, target: string, external?: { thread: string; message: string }) {
    const key = target.slice(0, target.indexOf(':'))
    if (!this.entriesOf(caller, principal).some((entry) => entry.key === key)) throw forbidden(`this token doesn't sync ${key} here: its board registers its sync entries`)
    if (!(await this.tables.syncOf(message.thread))?.targets.includes(target)) throw badRequest(`#${message.id}'s thread doesn't sync with ${target}`, 'not_a_target')
    if (!external) return
    if (!external.thread.startsWith(`${key}:`)) throw badRequest(`a delivery to ${target} lands under ${key}, not in ${external.thread}`)
    const owner = await this.tables.threadOf(external.thread)
    if (owner !== null && owner !== message.thread) throw new HttpError(409, 'already_synced', `${external.thread} is already synced with another thread`)
    const copy = await this.tables.messageOf(external.thread, external.message)
    if (copy !== null && copy !== message.id) throw new HttpError(409, 'already_synced', `${external.message} in ${external.thread} is another board message's`)
  }

  /** Appends a receipt's events once for `key`: a retry lands nothing more (upstream `receipt`). */
  private async receipt(key: string, events: NewEvent[]) {
    const ids = await Promise.all(events.map((_, at) => derivedId('board-receipt', key, String(at))))
    await this.exclusive(async () => {
      const fresh = events.flatMap((event, at) => (this.log.byId(ids[at]!) ? [] : [{ ...event, id: ids[at]! }]))
      if (fresh.length > 0) await this.append(fresh)
    })
  }

  async syncReceipt(caller: Caller, body: In<'syncReceipt'>): Promise<Out<'syncReceipt'>> {
    if (caller.principal.scope !== undefined) throw forbidden("this token is narrowed with x-board-can, so it can't record what it synced: that's its project's sync's job")
    const message = await this.authorizeMessage(caller.principal.access, 'sync', messageAt(body.message))
    if (body.kind === 'thread') {
      // writeAttach: a thread's new target, once, and never a platform thread another board thread has.
      const target = body.target
      const kind = body.targetKind
      const id = await derivedId('board', message.thread, 'sync', target)
      const attached = await this.exclusive(async () => {
        if ((await this.tables.syncOf(message.thread))?.targets.includes(target)) return false
        if (kind === 'thread') {
          const owner = await this.tables.threadOf(target)
          if (owner !== null && owner !== message.thread) {
            const synced = await this.tables.syncOf(owner)
            throw new HttpError(409, 'already_synced', `${target} is already synced with ${synced && caller.principal.access.readable(synced.channel) ? `#${synced.root}` : 'another thread'}`)
          }
        }
        await this.append([{ type: 'thread.synced', id, payload: { thread: message.thread, target, kind, cause: body.cause, by: caller.author } }])
        return true
      })
      return { ok: true, attached } as Out<'syncReceipt'>
    }
    await this.deliverable(caller, caller.principal.id, message, body.target, body.kind === 'message' ? body.external : undefined)
    const about = { id: message.id, thread: message.thread, target: body.target }
    const by = ownSync(caller) ? {} : { syncedBy: caller.principal.id }
    if (body.kind === 'message')
      await this.receipt(`receipt:${message.id}:${body.target}`, [
        { type: 'message.synced', payload: { ...about, external: body.external, ...by } },
        ...(body.files !== undefined ? [{ type: 'message.files_synced', payload: { ...about, files: body.files, ...by } }] : []),
      ])
    else if (body.kind === 'files') await this.receipt(`files:${message.id}:${body.target}`, [{ type: 'message.files_synced', payload: { ...about, files: body.files, ...by } }])
    else await this.receipt(`failed:${message.id}:${body.target}`, [{ type: 'message.sync_failed', payload: { ...about, error: body.error } }])
    return { ok: true } as Out<'syncReceipt'>
  }

  async syncThread(caller: Caller, { thread }: In<'syncThread'>): Promise<Out<'syncThread'>> {
    this.needSync(caller, 'look up a sync')
    const synced = await this.tables.syncOf(thread)
    if (!synced || !caller.principal.access.can('sync', synced.channel)) throw notFound(`no thread ${thread} on this board`, 'thread_not_found')
    return { thread, root: ref(synced.root), channel: synced.channel, targets: [...synced.targets], external: { ...synced.external } }
  }

  async syncFind(caller: Caller, query: In<'syncFind'>): Promise<Out<'syncFind'>> {
    this.needSync(caller, 'look up a sync')
    const { access } = caller.principal
    let thread: string | null = null
    let message: string | null = null
    if (query.post !== undefined) {
      const landed = await this.tables.byEventId(await this.importId(caller, caller.principal.id, query.post))
      if (landed && access.can('sync', landed.channel)) message = ref(landed.id)
    }
    if (query.thread !== undefined) {
      const key = query.message === undefined ? await this.tables.threadOf(query.thread) : await this.tables.threadOf(query.thread)
      const synced = key === null ? null : await this.tables.syncOf(key)
      if (synced && access.can('sync', synced.channel)) thread = key
      if (query.message !== undefined) {
        const id = await this.tables.messageOf(query.thread, query.message)
        const found = id === null ? null : await this.tables.message(id)
        if (found && access.can('sync', found.channel)) message = ref(found.id)
      }
    }
    return { thread, message }
  }

  async syncCopies(caller: Caller, query: In<'syncCopies'>): Promise<Out<'syncCopies'>> {
    this.needSync(caller, 'look up a sync')
    const { access } = caller.principal
    const ids = [...new Set(query.message.map(indexOf).filter((id) => id !== null && id > 0))] as number[]
    const everywhere = access.everywhere('sync')
    const copies = await this.tables.copiesOf(ids)
    const messages = everywhere ? null : await this.tables.messagesAt(ids, await this.tables.position())
    // Only its own sync's copies: a sync changes what it posted, never another's under a key they share.
    const mine = (copy: ExternalCopy) => (ownSync(caller) ? copy.by === undefined : copy.by === caller.principal.id)
    const out: Record<string, Record<string, ExternalCopy>> = {}
    for (const id of ids) {
      const found = messages?.get(id)
      if (everywhere || (found && access.can('sync', found.channel)))
        out[ref(id)] = Object.fromEntries(Object.entries(copies.get(id) ?? {}).filter(([, copy]) => mine(copy)).map(([target, { by: _by, ...copy }]) => [target, copy]))
    }
    return { copies: out } as Out<'syncCopies'>
  }

  async synced(caller: Caller, { id }: In<'synced'>): Promise<Out<'synced'>> {
    const message = await this.tables.message(messageAt(id))
    if (!message || !caller.principal.access.readable(message.channel)) throw notFound(`message not found: #${id}`, 'message_not_found')
    const [thread, copies] = await Promise.all([this.tables.syncOf(message.thread), this.tables.copiesOf([message.id])])
    const mine = copies.get(message.id) ?? {}
    const binding = this.binding()
    const targets = await Promise.all(
      (thread?.targets ?? []).map(async (target) => {
        const key = target.slice(0, target.indexOf(':'))
        const external = (thread && Object.hasOwn(thread.external, target) ? thread.external[target] : undefined) ?? null
        const copy = (Object.hasOwn(mine, target) ? mine[target] : external !== null && Object.hasOwn(mine, external) ? mine[external] : undefined) ?? null
        return {
          target,
          key,
          thread: copy?.thread ?? external,
          message: copy?.message ?? null,
          url: copy && binding ? await binding.linkOf(key, copy.thread, copy.message) : null,
          undelivered: Object.hasOwn(message.undelivered, target) ? message.undelivered[target]! : null,
        }
      }),
    )
    return { targets } as Out<'synced'>
  }

  async linked(caller: Caller, { url }: In<'linked'>): Promise<Out<'linked'>> {
    // The platform is never asked: a link nothing here knows, and one the caller can't read, are the same 404.
    const missing = () => notFound('no message on this board for that link', 'message_not_found')
    const read = this.binding()?.locate(url) ?? []
    if (read.length === 0) throw missing()
    const registered = Object.values(this.registry.byOwner).flatMap((registration) => registration.sync ?? [])
    const keysOf = (platform: string) => new Set([...this.ownEntries(), ...registered].filter((entry) => entry.platform === platform).map((entry) => entry.key))
    let found: number | null = null
    for (const { platform, thread, message } of read) {
      for (const key of keysOf(platform)) {
        if (message !== null) found = await this.tables.messageOf(`${key}:${thread}`, message)
        else {
          const at = await this.tables.threadOf(`${key}:${thread}`)
          found = at === null ? null : ((await this.tables.syncOf(at))?.root ?? null)
        }
        if (found) break
      }
      if (found) break
    }
    if (found === null) throw missing()
    try {
      return await this.message(caller, { id: ref(found) } as In<'message'>)
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw missing()
      throw error
    }
  }

  async inboxPush(caller: Caller, { key, events }: In<'inboxPush'>): Promise<Out<'inboxPush'>> {
    this.needSync(caller, 'push to an inbox', true)
    for (const { id } of events) if (id.length > INBOX_EVENT_ID_MAX) throw badRequest(`an inbox event ID is ${INBOX_EVENT_ID_MAX} characters at most, got ${id.length}`)
    for (const { event } of events)
      for (const location of [event.channel, event.thread, 'subthread' in event ? event.subthread : null])
        if (location !== null && !location.startsWith(`${key}:`)) throw badRequest(`an inbox's platform locations belong to its sync key: ${location} isn't ${key}'s`)
    if (ownSync(caller)) {
      // This board's own sync: its inbox, run by the board itself, one platform thread at a time.
      const pushed = await Promise.all(events.map(async ({ id, event, raw }) => ({ type: 'watch.matched' as const, id: await derivedId('board-inbox', key, id), payload: { thread: event.thread, inbox: key, event: { sync: key, event, raw } } })))
      await this.exclusive(async () => {
        const state = this.queueOf(OWN)
        for (const one of pushed) foldQueue(state, one)
        this.saveQueue(OWN, state)
        this.arm('run', Date.now(), { kind: 'run', payload: {} })
      })
      return { ok: true } as Out<'inboxPush'>
    }
    // A sync elsewhere: its own queue, for it to pull back. A platform's retry lands once.
    const matched = await Promise.all(events.map(async ({ id, event, raw }) => ({ type: 'watch.matched' as const, id: await derivedId('board-inbox', key, id), payload: { thread: event.thread, inbox: key, event: { sync: key, event, raw } } })))
    await this.exclusive(async () => {
      const state = this.queueOf(caller.principal.id)
      for (const one of matched) foldQueue(state, one)
      this.saveQueue(caller.principal.id, state)
    })
    return { ok: true } as Out<'inboxPush'>
  }

  async inboxNext(caller: Caller, { key, limit }: In<'inboxNext'>): Promise<Out<'inboxNext'>> {
    if (ownSync(caller)) return { items: [] } as Out<'inboxNext'>
    this.needSync(caller, 'pull from an inbox', true)
    return this.exclusive(async () => {
      const state = this.queueOf(caller.principal.id)
      const { events, leased } = pullInbox(state, key, { access: caller.principal.access, limit: limit ?? 10, now: Date.now() })
      for (const event of events) foldQueue(state, event)
      if (events.length > 0) this.saveQueue(caller.principal.id, state)
      return {
        items: leased.map(({ id, thread, lease, attempt, event }) => {
          const item = event as { event: unknown; raw: unknown }
          return { id, key, thread, lease, attempt, event: item.event, raw: item.raw }
        }),
      } as Out<'inboxNext'>
    })
  }

  async inboxAck(caller: Caller, { id, lease, error }: In<'inboxAck'>): Promise<Out<'inboxAck'>> {
    this.needSync(caller, 'ack an inbox event', true)
    return this.exclusive(async () => {
      const state = this.queueOf(caller.principal.id)
      let acked: ReturnType<typeof ackMatch>
      try {
        acked = ackMatch(state, id, { lease, error }, Date.now())
      } catch (thrown) {
        if (thrown instanceof HttpError && thrown.code === 'no_match') throw notFound(`no inbox event ${id} is waiting for this token`, 'no_item')
        throw thrown
      }
      for (const event of acked) foldQueue(state, event)
      this.saveQueue(caller.principal.id, state)
      return { ok: true } as Out<'inboxAck'>
    })
  }

  /** Raw platform payloads a sync pushed and hasn't finished with (Δ: upstream also lists those finished). */
  async inbox(caller: Caller, { key, channel, limit }: In<'inbox'>): Promise<Out<'inbox'>> {
    this.needSync(caller, 'read an inbox', true)
    const pushers = new Set([caller.principal.id, ...(caller.principal.access.everywhere('sync') ? Object.keys(this.registry.byOwner) : [])])
    const entries: { id: string; channel: string; createdAt: string; sync: string; event: { channel: string }; raw: unknown }[] = []
    for (const pusher of pushers)
      for (const pending of Object.values(this.queueOf(pusher).pending)) {
        const pushed = pending.event as { sync?: string; event?: { channel: string }; raw?: unknown }
        if (pending.queue !== `@inbox:${key}` || !pushed.event) continue
        if (channel !== undefined && pushed.event.channel !== channel) continue
        entries.push({ id: pending.id, channel: pushed.event.channel, createdAt: new Date().toISOString(), sync: key, event: pushed.event, raw: pushed.raw })
      }
    return { events: entries.slice(0, limit ?? 50) } as unknown as Out<'inbox'>
  }

  async typing(caller: Caller, { id, status }: In<'typing'>): Promise<Out<'typing'>> {
    const found = await this.tables.message(messageAt(id))
    if (!found || found.deleted || !caller.principal.access.readable(found.channel)) throw notFound(`message not found: #${id}`, 'message_not_found')
    if (!caller.principal.access.can('post', found.channel)) throw forbidden(`this token can't post in ${found.channel}`)
    const binding = this.binding()
    if (!binding) return { targets: [] } as Out<'typing'>
    const { message, replies } = await this.message(caller, { id } as In<'message'>)
    return { targets: await binding.typing([message, ...replies], status) } as Out<'typing'>
  }

  async readSource(caller: Caller, { key, target, limit, after }: In<'readSource'>): Promise<Out<'readSource'>> {
    const binding = this.binding()
    if (!binding || !binding.sync.some((entry) => entry.key === key)) throw notFound(`this board doesn't run sync entry ${key}: read it where its sync runs`, 'not_synced_here')
    if (!caller.principal.access.everywhere('manage')) throw forbidden("this token can't read a source: it needs manage in every channel")
    if (caller.principal.scope !== undefined) throw forbidden("this token is narrowed with x-board-can, so it can't read a source")
    return binding.readSource(key, target, limit ?? 50, after ?? null)
  }

  async joinSource(caller: Caller, { key, target }: In<'joinSource'>): Promise<Out<'joinSource'>> {
    const binding = this.binding()
    if (!binding || !binding.sync.some((entry) => entry.key === key)) throw notFound(`this board doesn't run sync entry ${key}: join it where its sync runs`, 'not_synced_here')
    if (!caller.principal.access.everywhere('manage')) throw forbidden("this token can't join a source: it needs manage in every channel")
    if (caller.principal.scope !== undefined) throw forbidden("this token is narrowed with x-board-can, so it can't join a source")
    return binding.joinSource(key, target)
  }

  // --- Tasks (upstream a2.ts's task methods, on src/engine/tasks.ts) ---

  /** The IDs a batch made under `id` carries (upstream a2.ts `batchRoot` and `batchAsked`). */
  private batchRoot = (id: string, at: number) => derivedId('board-batch', id, String(at))
  private batchAsked = (id: string, request: string) => derivedId('board-batch-request', id, request)

  /** A batch a caller made under an `id`, found by the IDs its events carry (upstream writes.ts `landedBatch`). */
  private async landedBatch(identity: Identity, rootId: (at: number) => Promise<string>, asked: string | undefined): Promise<{ tasks: MessageView[] } | { not: 'made' | 'yours' | 'asked' }> {
    const first = await this.tables.byEventId(await rootId(0))
    if (!first) return { not: 'made' }
    const tasks: MessageView[] = []
    for (let at = 0, landed: Message | null = first; landed; landed = await this.tables.byEventId(await rootId(++at))) {
      const mine = await this.landedFor(identity, landed)
      if (!mine) return { not: 'yours' }
      tasks.push(mine)
    }
    if (asked !== undefined) {
      const [, made] = this.log.history({ gte: first.id, lte: first.id + 1 })
      if (made?.id !== asked) return { not: 'asked' }
    }
    return { tasks }
  }

  /**
   * Several new threads in `channel` in one append, each root with what `more` makes of it right
   * after it, all or none (upstream writes.ts `writeRoots`).
   */
  private writeRoots(caller: Caller, channel: string, roots: { id: string; text: string; labels?: Record<string, string> | undefined; noSync?: boolean | undefined; attachments?: Attachment[] }[], more: AlongEach, again?: { asked: string; landed: () => ReturnType<BoardEngine['landedBatch']> }): Promise<MessageView[]> {
    const { access } = caller.principal
    const blind = !access.readable(channel)
    return this.exclusive(async () => {
      const found = again ? await again.landed() : null
      if (found && 'not' in found && found.not !== 'made') throw duplicateId()
      if (found && 'tasks' in found) return found.tasks
      const seen = seenFor(caller, this.views.actors)
      const { counts, events: made } = await more()
      let next = this.log.head() + 1 + (seen ? 1 : 0)
      const placed = roots.map((root, at) => {
        const here = { id: next, thread: root.id }
        next += 1 + counts[at]!
        return here
      })
      const came = made(placed)
      // The event right after the first root says what the batch was asked for, by its ID.
      if (again && came[0]?.[0]) came[0][0] = { ...came[0][0], id: again.asked }
      const events: NewEvent[] = seen ? [seen] : []
      for (const [at, root] of roots.entries()) {
        if (came[at]!.length !== counts[at]) throw new Error(`a root's append carries the ${counts[at]} events it said, not ${came[at]!.length}`)
        events.push(
          {
            type: 'message.posted',
            id: root.id,
            payload: { channel, text: root.text, re: null, replyTo: null, thread: root.id, labels: root.labels ?? {}, noSync: root.noSync ?? false, by: caller.author, origin: null, from: null, ...(root.attachments?.length ? { attachments: root.attachments } : {}), ...(blind ? { blind: true as const } : {}), ...(came[at]!.length > 0 ? { along: came[at]!.length } : {}) },
          },
          ...came[at]!,
        )
      }
      const rows = await this.append(events)
      const folded: MessagesState = { byId: {}, replies: {} }
      for (const row of rows) foldMessages(folded, row)
      const known = knownWith(this.views.actors, caller, seen)
      const posted = rows.filter((row) => row.type === 'message.posted')
      return Promise.all(posted.map(async (row, at) => shownTo(view(folded.byId[row.index]!, known, await this.reads.reader(access, [folded.byId[row.index]!])), access, roots[at]!.text)))
    })
  }

  tasksList = (caller: Caller, query: In<'tasks'>) => this.tasks.list(caller, query)

  async createTask(caller: Caller, body: In<'createTask'>): Promise<Out<'createTask'>> {
    if (body.re === undefined) {
      if ((body.text ?? '').length > MESSAGE_TEXT_MAX) throw textTooLong()
      if ((body.attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) throw badRequest(`attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
    }
    taskLimits.needs(body.needs)
    taskLimits.lease(body.lease)
    const about = { needs: body.needs, for: body.for, claim: body.claim, lease: body.lease, token: body.token }
    if (body.re !== undefined) return this.tasks.adopt(caller, messageAt(body.re), about)
    const made = this.tasks.starting(caller, { channel: body.channel!, ...about })
    const { message: task } = await this.post(caller, { channel: body.channel, text: body.text ?? '', labels: body.labels, noSync: body.noSync, id: body.id, attachments: body.attachments } as In<'post'>, made.along)
    // A retry gets back the post that landed with its ID: one that was no task's is another write's.
    if (!task.task) throw duplicateId()
    const claim = await made.claimed(messageAt(task.id))
    return { task, ...(claim ? { claim } : {}) }
  }

  async createTasks(caller: Caller, body: In<'createTasks'>): Promise<Out<'createTasks'>> {
    taskLimits.batch(body.tasks)
    for (const [at, task] of body.tasks.entries()) {
      if (task.text.length > MESSAGE_TEXT_MAX) throw textTooLong()
      if ((task.attachments?.length ?? 0) > ATTACHMENTS_PER_MESSAGE_MAX) throw badRequest(`tasks.${at}.attachments: a message carries at most ${ATTACHMENTS_PER_MESSAGE_MAX}`)
    }
    const { principal } = caller
    authorize(principal.access, 'post', body.channel)
    if (body.tasks.some((task) => Object.keys(task.labels ?? {}).length > 0)) authorize(principal.access, 'label', body.channel)
    if (caller.request && body.id !== undefined && DERIVED_ID.test(body.id)) throw badRequest("id: UUIDv8s are the board's own, for the writes it makes itself")
    const made = this.tasks.startingMany(caller, body.tasks)
    const rootId = (at: number) => (body.id !== undefined ? this.batchRoot(body.id, at) : Promise.resolve(crypto.randomUUID()))
    const roots = await Promise.all(body.tasks.map(async (task, at) => ({ id: await rootId(at), text: task.text, labels: task.labels, noSync: task.noSync, attachments: await this.attachmentsFor(principal, task.attachments) })))
    const { id } = body
    const asked = id !== undefined ? await this.batchAsked(id, body.request ?? '') : undefined
    const again = id !== undefined && asked !== undefined ? { asked, landed: () => this.landedBatch(caller, (at) => this.batchRoot(id, at), asked) } : undefined
    return { tasks: await this.writeRoots(caller, body.channel, roots, made, again) }
  }

  async createdTasks(caller: Caller, { id, request }: In<'createdTasks'>): Promise<Out<'createdTasks'>> {
    const found = await this.landedBatch(caller, (at) => this.batchRoot(id, at), request !== undefined ? await this.batchAsked(id, request) : undefined)
    if ('tasks' in found) return found
    if (found.not === 'asked') throw duplicateId()
    throw notFound(`no batch of yours has id ${id}`, 'batch_not_found')
  }

  async claimReadyTask(caller: Caller, body: In<'claimReadyTask'>): Promise<Out<'claimReadyTask'>> {
    taskLimits.lease(body.lease)
    taskLimits.from(body.from)
    return this.tasks.claimReady(caller, body, AbortSignal.timeout(((body.wait ?? 0) + 30) * 1000))
  }

  async claimTask(caller: Caller, { id, lease, token }: In<'claimTask'>): Promise<Out<'claimTask'>> {
    taskLimits.lease(lease)
    return this.tasks.claim(caller, messageAt(id), lease, token)
  }

  async renewTask(caller: Caller, { id, epoch, token, lease }: In<'renewTask'>): Promise<Out<'renewTask'>> {
    taskLimits.lease(lease)
    return this.tasks.renew(caller, messageAt(id), { epoch, token }, lease)
  }

  releaseTask = (caller: Caller, { id, epoch, token }: In<'releaseTask'>) => this.tasks.settle(caller, messageAt(id), { epoch, token }, { type: 'task.released' })

  async completeTask(caller: Caller, { id, epoch, token, result }: In<'completeTask'>) {
    taskLimits.note('result', result)
    return this.tasks.settle(caller, messageAt(id), { epoch, token }, { type: 'task.completed', result: result ?? null })
  }

  async failTask(caller: Caller, { id, epoch, token, reason }: In<'failTask'>) {
    taskLimits.note('reason', reason)
    return this.tasks.settle(caller, messageAt(id), { epoch, token }, { type: 'task.failed', reason })
  }

  async blockTask(caller: Caller, { id, reason, kind, epoch, token }: In<'blockTask'>) {
    taskLimits.note('reason', reason)
    taskLimits.kind(kind)
    return this.tasks.block(caller, messageAt(id), { reason, kind, ...(epoch !== undefined && token !== undefined ? { proof: { epoch, token } } : {}) })
  }

  unblockTask = (caller: Caller, { id }: In<'unblockTask'>) => this.tasks.unblock(caller, messageAt(id))
  reopenTask = (caller: Caller, { id }: In<'reopenTask'>) => this.tasks.reopen(caller, messageAt(id))
  assignTask = (caller: Caller, { id, for: actor }: In<'assignTask'>) => this.tasks.assign(caller, messageAt(id), actor)

  async setTaskNeeds(caller: Caller, { id, needs }: In<'setTaskNeeds'>) {
    taskLimits.needs(needs)
    return this.tasks.needs(caller, messageAt(id), needs)
  }

  async cancelTask(caller: Caller, { id, reason }: In<'cancelTask'>) {
    taskLimits.note('reason', reason)
    return this.tasks.cancel(caller, messageAt(id), reason)
  }

  /** A claim's lease ran out: expire it, if it's still that claim (upstream's `board-leases`). */
  leaseDue(payload: { id: number; epoch: number; at: number }, name: string) {
    return this.tasks.due(payload, name)
  }

  // --- Files (upstream a2.ts upload, uploadStart, uploadFinish, attachment) ---

  /** Uploading needs `post` or `sync` somewhere: a file is no use until a post or an import carries it. */
  private mayUpload(caller: Caller) {
    if (!caller.principal.access.anywhere('post') && !caller.principal.access.anywhere('sync')) throw forbidden("this token can't post anywhere, so it can't upload")
  }

  async upload(caller: Caller, { data, name, type }: In<'upload'>): Promise<Out<'upload'>> {
    this.mayUpload(caller)
    return { attachment: await this.files.upload({ data, name: name ?? null, type: type ?? null, uploadedBy: caller.principal.id }) }
  }

  /** A direct upload's start: the Worker makes its URL from the ID and secret. */
  async uploadStart(caller: Caller, { name, type, size }: In<'uploadStart'>) {
    this.mayUpload(caller)
    const started = await this.files.start({ name: name ?? null, type: type ?? null, size, uploadedBy: caller.principal.id })
    return { id: started.id, secret: started.secret, headers: { 'content-type': started.type }, expiresAt: started.expiresAt }
  }

  /** Where the Worker puts a direct upload's bytes. */
  uploadTarget(id: string, secret: string) {
    return this.files.target(id, secret)
  }

  async uploadFinish(caller: Caller, { id }: In<'uploadFinish'>): Promise<Out<'uploadFinish'>> {
    return { attachment: await this.files.finish(id, caller.principal.id) }
  }

  async attachment(caller: Caller, { id }: In<'attachment'>): Promise<Out<'attachment'>> {
    const found = this.files.read(id)
    if (!found || !(await this.attachmentReadable(caller.principal, id, found.uploadedBy))) throw attachmentNotFound(id)
    return { attachment: found.attachment, data: await this.files.body(id) }
  }

  // --- Export and import (spec 07, `bx export` / `bx import`) ---

  /** A page of the log, every session's, as JSON lines: an export reads them all. */
  exportPage(after: { session: string; index: number } | null, limit = 1000): { lines: string[]; next: { session: string; index: number } | null } {
    const events = this.log.page(after, limit)
    const lines = events.map((event) => JSON.stringify({ session: event.session, index: event.index, id: event.id, type: event.type, payload: event.payload, createdAt: event.createdAt.toISOString() }))
    const last = events.at(-1)
    return { lines, next: events.length === limit && last ? { session: last.session, index: last.index } : null }
  }

  /**
   * Restores an export into an empty board, then works out everything kept beside the log from it
   * again: who's who and the channels, the grants, schemas, and schedules, the tables, and the
   * timers of the schedules still pending. Registered watchers start again from nothing.
   */
  importLines(lines: readonly string[]): Promise<{ events: number }> {
    return this.exclusive(async () => {
      if (!this.log.empty()) throw new HttpError(409, 'board_not_empty', 'a board takes an import only while it has nothing: import into a new board')
      const events = lines.filter((line) => line.trim() !== '').map((line, at) => {
        try {
          return JSON.parse(line) as { session: string; index: number; id: string; type: string; payload: unknown; createdAt: string }
        } catch {
          throw new HttpError(400, 'invalid_import', `line ${at + 1} isn't JSON`)
        }
      })
      this.storage.transactionSync(() => {
        for (const event of events) this.log.restore(event)
        for (const key of ['access', 'schemas', 'schedules', 'registry', 'watch-position']) this.storage.sql.exec('delete from bx_state where key = ?', key)
      })
      this.views = new Views(this.storage)
      this.access = startingAccess()
      this.schemaState = emptySchemas()
      this.scheduleState = emptySchedules()
      this.registry = { byOwner: {} }
      for (const session of [BOARD_SESSION, ACCESS_SESSION, SCHEMAS_SESSION, SCHEDULES_SESSION]) {
        for (let from = 1; ; ) {
          const page = this.log.history({ gte: from, lte: from + 499 }, session)
          if (page.length === 0) break
          this.storage.transactionSync(() => {
            if (session === BOARD_SESSION) this.views.fold(page)
            for (const row of page) {
              if (session === ACCESS_SESSION) foldAccess(this.access, row as never)
              if (session === SCHEMAS_SESSION) foldSchemas(this.schemaState, row as never)
              if (session === SCHEDULES_SESSION) foldSchedules(this.scheduleState, row as never)
            }
          })
          from = page.at(-1)!.index + 1
        }
      }
      for (const [key, state] of [['access', this.access], ['schemas', this.schemaState], ['schedules', this.scheduleState]] as const)
        this.storage.sql.exec('insert into bx_state (key, data) values (?, ?) on conflict (key) do update set data = excluded.data', key, JSON.stringify(state))
      await this.catchUp()
      for (const schedule of Object.values(this.scheduleState.byId))
        if (schedule.next !== null) this.arm(`import-${schedule.id}-${schedule.sent}`, schedule.next, { kind: 'schedule.due', payload: { id: schedule.id, n: schedule.sent, at: schedule.next } })
      return { events: events.length }
    })
  }

  // --- Registered watchers (upstream a2.ts watchers, register, matches, ack) ---

  /** A caller narrowed with x-board-can doesn't run its principal's watchers (upstream `ownWatchers`). */
  private ownWatchers(caller: Caller) {
    if (caller.principal.scope !== undefined) throw forbidden("this token is narrowed with x-board-can: registering and running watchers is its project's job")
  }

  async watchers(caller: Caller): Promise<Out<'watchers'>> {
    const all = Object.values(this.registry.byOwner).sort((a, b) => a.owner.localeCompare(b.owner)).map(viewOf)
    return { watchers: caller.principal.access.everywhere('manage') ? all : all.filter((found) => found.owner === caller.principal.id) }
  }

  async register(caller: Caller, body: In<'register'>): Promise<Out<'register'>> {
    // A path wakes a Vercel project's deployment, which only Vercel's board can.
    if (body.path) throw new HttpError(501, 'no_wake_by_path', 'this board wakes by URL, not by path: register a url, or pull your matches')
    const { principal } = caller
    this.ownWatchers(caller)
    if (!principal.access.anywhere('read')) throw forbidden("this token can't read anywhere, so a watcher it registers would see nothing")
    if ((body.sync?.length ?? 0) > 0 && !principal.access.anywhere('sync')) throw forbidden("this token can't register a sync: it needs sync somewhere")
    if (body.url !== undefined && body.url !== null && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(body.url)) throw badRequest('url: an https URL (http only on localhost), where the board wakes you', 'invalid_url')
    if (Object.keys(body.watch).length > 64) throw badRequest('a registration holds at most 64 watchers', 'too_many_watchers')
    for (const [id, spec] of Object.entries(body.watch)) {
      const name = RemoteWatcherId.safeParse(id)
      if (!name.success) throw badRequest(`watch ${id}: ${name.error.issues[0]!.message}`, 'bad_watcher')
      try {
        compileWatcher(id, spec)
      } catch (error) {
        throw badRequest((error as Error).message, 'bad_watcher')
      }
    }
    const sync = body.sync ?? []
    const view = { owner: principal.id, url: body.url ?? null, watch: Object.fromEntries(Object.entries(body.watch).map(([id, spec]) => [id, { tail: spec.tail }])), sync, hash: await watchersHash(body.watch, sync) }
    return this.exclusive(async () => {
      // Matching starts here for the first registration: what came before is no one's.
      if (Object.keys(this.registry.byOwner).length === 0) this.storage.sql.exec("insert into bx_state (key, data) values ('watch-position', ?) on conflict (key) do update set data = excluded.data", String(this.log.head()))
      this.registry.byOwner[principal.id] = { ...view, principal: { id: principal.id, kind: principal.kind, handle: principal.handle }, can: principal.access.summary() }
      this.storage.sql.exec("insert into bx_state (key, data) values ('registry', ?) on conflict (key) do update set data = excluded.data", JSON.stringify(this.registry))
      return view
    })
  }

  async matches(caller: Caller, query: In<'matches'>): Promise<Out<'matches'>> {
    const { principal } = caller
    this.ownWatchers(caller)
    if (!this.registry.byOwner[principal.id]) throw notFound('this token has no watchers registered here', 'no_registration')
    const deadline = Date.now() + (query.wait ?? 0) * 1000
    for (let pause = 100; ; pause = Math.min(pause * 2, 1000)) {
      await this.match()
      const found = await this.exclusive(async () => {
        const state = this.queueOf(principal.id)
        const { events, matches } = pull(state, { access: principal.access, limit: query.limit ?? 10, now: Date.now() })
        for (const event of events) foldQueue(state, event)
        if (events.length > 0) this.saveQueue(principal.id, state)
        return matches
      })
      if (found.length > 0 || Date.now() >= deadline) return { matches: found }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pause, Math.max(0, deadline - Date.now()))))
    }
  }

  async ack(caller: Caller, { id, ...body }: In<'ack'>): Promise<Out<'ack'>> {
    this.ownWatchers(caller)
    return this.exclusive(async () => {
      const state = this.queueOf(caller.principal.id)
      for (const event of ackMatch(state, id, body, Date.now())) foldQueue(state, event)
      this.saveQueue(caller.principal.id, state)
      return { ok: true as const }
    })
  }

  /** Where to wake a registrant, and the hash it checks its registration by; null when it has no URL now. */
  wakeTarget(owner: string): { url: string; hash: string } | null {
    const found = this.registry.byOwner[owner]
    return found?.url ? { url: found.url, hash: found.hash ?? '' } : null
  }

  // --- The schema registry (upstream src/server/schemas.ts). Anyone the board let in reads it. ---

  async schemas(): Promise<Out<'schemas'>> {
    return listSchemas(this.schemaState)
  }

  async schema(_caller: Caller, input: In<'schema'>): Promise<Out<'schema'>> {
    return findSchema(this.schemaState, input)
  }

  createSchema(caller: Caller, body: In<'createSchema'>): Promise<Out<'createSchema'>> {
    return this.exclusive(async () => {
      const decided = registering(this.schemaState, caller, body)
      if ('existing' in decided) return { schema: decided.existing, created: false }
      try {
        this.appendSide(SCHEMAS_SESSION, [decided.event], this.schemaState, (state, row) => foldSchemas(state, row as never))
      } catch (error) {
        this.schemaState = this.loadState('schemas', emptySchemas)
        throw error
      }
      return { schema: schemaView(this.schemaState, decided.id), created: true }
    })
  }

  async events(caller: Caller, query: In<'events'>): Promise<Out<'events'>> {
    const { principal, actor } = caller
    const after = query.after !== undefined ? cursorAt(query.after) : undefined
    const feed = {
      session: this.session,
      reads: this.reads,
      after,
      filters: query,
      all: query.all ?? false,
      me: { id: actor.id, handle: actor.handle },
      // The feed folds who's who as it goes: its own copy.
      actors: structuredClone(this.views.actors),
      access: principal.access,
    }
    const waitMs = (query.wait ?? 0) * 1000
    const signal = AbortSignal.timeout(waitMs + 30_000)
    const { events, cursor } = query.last !== undefined ? await lastFeed(feed, query.last, signal) : await pollFeed(feed, waitMs, signal)
    return { events, cursor: ref(cursor) }
  }

  /** The IDs a write derives for itself, as upstream's do (exported for tasks and schedules in M2). */
  static derivedId = derivedId
}

/** What a duplicate ID in a batch answers, as upstream's board does. */
export const isDuplicate = (error: unknown) => error instanceof DuplicateEventError
