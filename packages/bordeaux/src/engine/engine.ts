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

/** A schedule's text as its creator sees it where it can't read (upstream a2.ts `blindSchedule`). */
const blindSchedule = (schedule: ScheduleView, access: Access, ownActor: string): ScheduleView =>
  access.readable(schedule.channel) ? schedule : { ...schedule, text: blindText(schedule.text, ownActor) }
import { createViewTables, Views } from './views.ts'
import { seenFor, type Along, type AlongEach, type WriteContext } from './writes.ts'
import { createTasks, LEASE_MIN_S, taskLimits } from './tasks.ts'
import { TASK_BATCH_MAX } from '../upstream/contract/schemas.ts'

type Caller = Identity & { request: boolean; schedule?: { id: number; n: number } }
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
  /** Resolves once the tables have every event the log has. */
  readonly ready: Promise<void>
  private readonly files: Files
  /** Tasks, as upstream's tasks.ts keeps them (src/engine/tasks.ts). */
  private readonly tasks: ReturnType<typeof createTasks>

  constructor(
    private readonly storage: DurableObjectStorage,
    options: { bucket?: R2Bucket | null; prefix?: string } = {},
  ) {
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
    let rows: BoardEvent[]
    try {
      rows = this.log.append(BOARD_SESSION, events, (landed) => this.views.fold(landed))
    } catch (error) {
      // The transaction rolled back: so do the folds it made in memory.
      this.views = new Views(this.storage)
      throw error
    }
    for (const row of rows) if (!(await this.tables.applyNext(row))) await this.catchUp()
    return rows
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
  async post(caller: Caller, parsed: In<'post'>, along?: Along): Promise<Out<'post'>> {
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
      const rows = await this.append([
        ...(seen ? [seen] : []),
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
            origin: null,
            from: null,
            ...(attachments.length ? { attachments } : {}),
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

  async edit(caller: Caller, { id, text, revision }: In<'edit'>): Promise<Out<'edit'>> {
    if (text.length > MESSAGE_TEXT_MAX) throw textTooLong()
    const at = messageAt(id)
    return this.exclusive(async () => {
      const message = await this.authorizeOwn(caller, at, 'edit')
      if (!authored(message, caller)) throw forbidden('only the author can edit a message')
      if (message.deleted) {
        if (revision !== undefined && revision !== (message.revision ?? message.id)) throw new HttpError(409, 'revision_conflict', `#${message.id} was deleted since revision ${revision}`)
        throw badRequest('message was deleted', 'message_deleted')
      }
      if (revision !== undefined) atRevision(message, message.id, revision)
      const seen = seenFor(caller, this.views.actors)
      await this.append([
        ...(seen ? [seen] : []),
        { type: 'message.edited', payload: { id: message.id, thread: message.thread, text, by: caller.author, from: null } },
        // A root may be a task: an edit by anyone but its owner holds it.
        ...(message.re === null ? heldByEdit(message, caller) : []),
      ])
      return { ok: true as const }
    })
  }

  async delete(caller: Caller, { id, revision }: In<'delete'>): Promise<Out<'delete'>> {
    const at = messageAt(id)
    return this.exclusive(async () => {
      const message = await this.authorizeOwn(caller, at, 'delete')
      if (!authored(message, caller)) throw forbidden('only the author can delete a message')
      // A tombstone changes no more: deleting it again is nothing, unless the caller read it before.
      if (message.deleted) {
        if (revision !== undefined && revision !== (message.revision ?? message.id)) throw new HttpError(409, 'revision_conflict', `#${message.id} was deleted since revision ${revision}`)
        return { ok: true as const }
      }
      if (revision !== undefined) atRevision(message, message.id, revision)
      await this.append([
        // A root that's a task is canceled first, while it still wears its labels.
        ...(message.re === null ? canceledByDelete(message, caller) : []),
        { type: 'message.deleted', payload: { id: message.id, thread: message.thread, by: caller.author, from: null } },
      ])
      return { ok: true as const }
    })
  }

  async react(caller: Caller, { id, emoji, remove }: In<'react'>): Promise<Out<'react'>> {
    const at = messageAt(id)
    return this.exclusive(async () => {
      const message = await this.authorizeMessage(caller.principal.access, 'react', at)
      if (message.deleted) throw badRequest('message was deleted', 'message_deleted')
      const seen = seenFor(caller, this.views.actors)
      await this.append([
        ...(seen ? [seen] : []),
        { type: remove ? 'reaction.removed' : 'reaction.added', payload: { id: message.id, thread: message.thread, emoji, by: caller.author, from: null } },
      ])
      return { ok: true as const }
    })
  }

  async label(caller: Caller, { id, set, unset, if: expected }: In<'label'>): Promise<Out<'label'>> {
    const at = messageAt(id)
    return this.exclusive(async () => {
      const message = await this.authorizeMessage(caller.principal.access, 'label', at)
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
