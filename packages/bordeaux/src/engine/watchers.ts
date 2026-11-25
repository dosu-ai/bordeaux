// Registered watchers (spec 04): a registrant's tails, the matches they make, and the queue it
// pulls them from. Ported from upstream at the pinned commit: the registry (src/server/registry.ts),
// the queue (src/server/registered.ts, nearly line for line), and the matching (src/server/watch.ts
// `dispatch`), on the board's DO instead of A2 sessions.
//
// Δ Matching uses the access a registrant had when it registered (its `x-board-can`-free summary),
// and every pull filters again by what it may read then: a narrower view, never a wider one.
// Δ A registration with a `url` is woken (`POST <url>/wake`) when it has matches, by the DO's alarm.
import { HttpError, type BoardEventView, type Identity, type MatchView, type RegistrationView } from '@vercel/board'
import { compileAccess, type AccessSummary } from '@vercel/board/access'
import { derivedId } from '../upstream/client/ids.ts'
import type { BoardEvent } from '../upstream/contract/events.ts'
import type { ActorsState, Message } from '../upstream/contract/folds.ts'
import type { Access } from '../upstream/server/access.ts'
import { compileFilter, eventView, foldEvent, loadBefore, view } from '../upstream/server/feed.ts'
import type { BoardReads } from '../upstream/server/reads.ts'
import { compileWatcher } from '../upstream/server/watch-spec.ts'
import { canonicalWatchers, type SyncEntrySpec, type WatcherSpec } from '../upstream/server/watchers-hash.ts'

/** Tries before a match is given up on (upstream `MATCH_TRIES`). */
export const MATCH_TRIES = 5
/** How long a pulled match is its puller's (upstream `LEASE_MS`). */
export const LEASE_MS = 5 * 60_000
/** After an error, a match waits 1 second, doubling to 30 (upstream `retryDelay`). */
export const retryDelay = (attempts: number) => Math.min(30_000, 1000 * 2 ** (attempts - 1))
/** The queue a registrant's sync pulls (upstream `SYNC_QUEUE`). */
export const SYNC_QUEUE = '@sync'
/** The queue of platform events a registrant pushed for sync key `key` (upstream `inboxQueue`). */
export const inboxQueue = (key: string) => `@inbox:${key}`
/** Bookkeeping events, matched only by a tail that asks for `--all` (upstream watch.ts `RECEIPTS`). */
const RECEIPTS = new Set(['message.synced', 'message.files_synced', 'task.renewed'])
/** What a registrant's sync gets where it may sync: what it delivers, and a thread's new targets (upstream watch.ts `SYNCED`). */
const SYNCED = new Set(['message.posted', 'message.edited', 'message.deleted', 'reaction.added', 'reaction.removed', 'labels.changed', 'thread.synced'])

/** A registration, with what its registrant could read when it registered. */
export type Registration = RegistrationView & { principal: { id: string; kind: string; handle: string; facts?: Identity['principal']['facts']; scope?: string }; can: AccessSummary; own?: true }

/** The registrant the board's own watchers and sync queue under, as if registered: they run in the board's DO. */
export const OWN = '@board'
export type RegistryState = { byOwner: Record<string, Registration> }

/** The same on both ends as upstream's: a board on `http()` hashes its watchers, and the board it uses what it holds. */
export async function watchersHash(watch: Record<string, WatcherSpec>, sync: readonly SyncEntrySpec[] = []): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalWatchers(watch, sync))))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

export const viewOf = ({ principal: _principal, can: _can, ...view }: Registration): RegistrationView => view

// --- The queue: upstream's registered.ts. ---

export type Pending = { id: string; queue: string; thread: string; event: unknown; attempts: number; lease: { id: string; until: number } | null; retryAt: number | null }
export type QueueState = { queues: Record<string, string[]>; pending: Record<string, Pending> }
export const emptyQueue = (): QueueState => ({ queues: {}, pending: {} })

type QueueEvent =
  | { type: 'watch.matched'; id: string; payload: { thread: string; event: unknown; watcher?: string; sync?: true; inbox?: string } }
  | { type: 'watch.leased'; payload: { matched: string; lease: string; until: number } }
  | { type: 'watch.acked'; payload: { matched: string; lease: string; error?: string; retryAt?: number } }
  | { type: 'watch.expired'; payload: { matched: string; lease: string } }
  | { type: 'watch.failed'; payload: { matched: string; thread: string; error: string } }
  | { type: 'watch.skipped'; payload: { matched: string; reason: string } }

const queueKey = (queue: string, thread: string) => `${queue}\u001f${thread}`

/**
 * When a queue next has something to do: each lane's head, at its retry or when its lease runs
 * out, or now when it's free. Only heads count: what waits behind one waits for it.
 */
export function nextDue(state: QueueState, now: number): number | undefined {
  let due: number | undefined
  for (const ids of Object.values(state.queues)) {
    const head = state.pending[ids[0]!]
    if (!head) continue
    const at = Math.max(now, head.retryAt ?? head.lease?.until ?? now)
    if (due === undefined || at < due) due = at
  }
  return due
}

/** Puts a dead letter back at the end of its lane, with its tries counted again from none. */
export function revive(state: QueueState, item: Pending) {
  if (state.pending[item.id]) return
  state.pending[item.id] = { ...item, attempts: 0, lease: null, retryAt: null }
  ;(state.queues[queueKey(item.queue, item.thread)] ??= []).push(item.id)
}

function remove(state: QueueState, id: string) {
  const found = state.pending[id]
  if (!found) return
  delete state.pending[id]
  const key = queueKey(found.queue, found.thread)
  const rest = (state.queues[key] ?? []).filter((queued) => queued !== id)
  if (rest.length > 0) state.queues[key] = rest
  else delete state.queues[key]
}

export function foldQueue(state: QueueState, event: QueueEvent): QueueState {
  switch (event.type) {
    case 'watch.matched': {
      const { watcher, sync, inbox, thread } = event.payload
      const queue = watcher ?? (sync ? SYNC_QUEUE : inbox !== undefined ? inboxQueue(inbox) : undefined)
      if (queue === undefined || state.pending[event.id]) return state
      state.pending[event.id] = { id: event.id, queue, thread, event: event.payload.event, attempts: 0, lease: null, retryAt: null }
      ;(state.queues[queueKey(queue, thread)] ??= []).push(event.id)
      return state
    }
    case 'watch.leased': {
      const found = state.pending[event.payload.matched]
      if (found && !found.lease) found.lease = { id: event.payload.lease, until: event.payload.until }
      return state
    }
    case 'watch.acked': {
      const found = state.pending[event.payload.matched]
      if (!found || found.lease?.id !== event.payload.lease) return state
      if (event.payload.error === undefined) {
        remove(state, found.id)
        return state
      }
      found.attempts += 1
      found.lease = null
      found.retryAt = event.payload.retryAt ?? null
      return state
    }
    case 'watch.expired': {
      const found = state.pending[event.payload.matched]
      if (!found || found.lease?.id !== event.payload.lease) return state
      found.attempts += 1
      found.lease = null
      return state
    }
    case 'watch.failed':
    case 'watch.skipped':
      remove(state, event.payload.matched)
      return state
  }
}

/** Whether `access` may see `event` now, as it was matched (upstream `readable`). */
function readable(access: Access, event: unknown, queue: string) {
  const channel = (event as BoardEventView).message?.channel
  if (queue === SYNC_QUEUE) return channel === undefined ? access.everywhere('sync') : access.can('sync', channel)
  return channel === undefined ? access.readsAll : access.readable(channel)
}

const free = (found: Pending, now: number) => !(found.lease && found.lease.until > now) && !(found.retryAt !== null && found.retryAt > now)
const describe = (error: unknown) => ((error instanceof Error ? error.message : String(error)) || 'unknown error').slice(0, 500)

function failure(found: Pending, error: string): QueueEvent {
  console.error(`[bordeaux] a registrant's ${found.queue} gave up on an item after ${MATCH_TRIES} tries:`, error)
  return { type: 'watch.failed', payload: { matched: found.id, thread: found.thread, error: describe(error) } }
}

const leaseId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')

type Leased = { id: string; queue: string; thread: string; event: unknown; lease: string; attempt: number }

/** Leases each queue's oldest match that's free, which the registrant may still have (upstream `pull`). */
export function pull(state: QueueState, options: { access: Access; limit: number; now: number }): { events: QueueEvent[]; matches: MatchView[] } {
  const { events, leased } = lease(state, { ...options, queues: (queue) => !queue.startsWith('@inbox:'), visible: (event, queue) => readable(options.access, event, queue) })
  return { events, matches: leased.map(({ id, queue, thread, lease, attempt, event }) => ({ id, watcher: queue, thread, lease, attempt, event: event as BoardEventView })) }
}

/** Leases the platform events the registrant pushed for sync key `key`, while it may still sync somewhere (upstream `pullInbox`). */
export function pullInbox(state: QueueState, key: string, options: { access: Access; limit: number; now: number }): { events: QueueEvent[]; leased: Leased[] } {
  const queue = inboxQueue(key)
  return lease(state, { ...options, queues: (name) => name === queue, visible: () => options.access.anywhere('sync') })
}

/** Leases what's free in the queues `queues` picks: each one's oldest item, which `visible` says its registrant may still have (upstream `lease`). */
function lease(state: QueueState, options: { limit: number; now: number; queues: (queue: string) => boolean; visible: (event: unknown, queue: string) => boolean }): { events: QueueEvent[]; leased: Leased[] } {
  const events: QueueEvent[] = []
  const leased: Leased[] = []
  for (const ids of Object.values(state.queues)) {
    if (leased.length >= options.limit) break
    const head = state.pending[ids[0]!]!
    if (!options.queues(head.queue) || !free(head, options.now)) continue
    let attempts = head.attempts
    if (head.lease) {
      events.push({ type: 'watch.expired', payload: { matched: head.id, lease: head.lease.id } })
      attempts += 1
      if (attempts >= MATCH_TRIES) {
        events.push(failure(head, `its lease ran out ${attempts} times`))
        continue
      }
    }
    if (!options.visible(head.event, head.queue)) {
      events.push({ type: 'watch.skipped', payload: { matched: head.id, reason: "its registrant can't have it anymore" } })
      continue
    }
    const lease = leaseId()
    events.push({ type: 'watch.leased', payload: { matched: head.id, lease, until: options.now + LEASE_MS } })
    leased.push({ id: head.id, queue: head.queue, thread: head.thread, lease, attempt: attempts, event: head.event })
  }
  return { events, leased }
}

/** Leases every queue's oldest free item, whatever it is: the board's own runner takes them all. */
export const leaseAll = (state: QueueState, options: { limit: number; now: number }) => lease(state, { ...options, queues: () => true, visible: () => true })

/** How a pulled match went: done, skipped, or an error that waits, then tries again (upstream `ack`). */
export function ack(state: QueueState, id: string, body: { lease: string; error?: string | undefined; skip?: boolean | undefined }, now: number, tries = MATCH_TRIES): QueueEvent[] {
  const found = state.pending[id]
  if (!found) throw new HttpError(404, 'no_match', `no match ${id} is waiting for this token`)
  if (found.lease?.id !== body.lease) throw new HttpError(409, 'stale_lease', 'that lease ran out, and the match was pulled again')
  if (body.skip) return [{ type: 'watch.skipped', payload: { matched: id, reason: 'its board skipped it' } }]
  if (body.error === undefined) return [{ type: 'watch.acked', payload: { matched: id, lease: body.lease } }]
  const attempts = found.attempts + 1
  if (attempts >= tries) return [{ type: 'watch.acked', payload: { matched: id, lease: body.lease, error: body.error } }, failure(found, body.error)]
  return [{ type: 'watch.acked', payload: { matched: id, lease: body.lease, error: body.error, retryAt: now + retryDelay(attempts) } }]
}

// --- Matching: upstream watch.ts `dispatch`, for registered watchers. ---

/** Each registrant's matches for `event`: the message before or after it must match, as in a tail; and its sync's (upstream `dispatch`). */
export async function matchesFor(event: BoardEvent, registrations: readonly Registration[], reads: BoardReads, actors: ActorsState, rootOf: (thread: string) => Promise<Message | undefined>): Promise<Map<string, QueueEvent[]>> {
  const out = new Map<string, QueueEvent[]>()
  const add = (owner: string, matched: QueueEvent) => (out.get(owner) ?? out.set(owner, []).get(owner)!).push(matched)
  if (event.type === 'thread.synced') {
    await syncMatches(event, registrations, reads, actors, undefined, await rootOf(event.payload.thread), event.payload.thread, add)
    return out
  }
  const messages = await loadBefore(reads, event)
  const { id, before, after } = foldEvent(messages, structuredClone(actors), event)
  const message = after ?? before
  const thread = (event.payload as { thread?: string }).thread ?? event.id
  const by = (event.payload as { by?: { actor?: string } }).by?.actor
  // A schedule's send is how a watcher asks to be woken later: its own still wakes it.
  const scheduled = event.type === 'message.posted' && event.payload.schedule !== undefined
  for (const registration of registrations) {
    const access = compileAccess(registration.can)
    // An event about a message only where it reads the message's channel, one about none only if it reads all.
    if (id === null ? !access.readsAll : !message || !access.readable(message.channel)) continue
    for (const [watcherId, spec] of Object.entries(registration.watch)) {
      let compiled: ReturnType<typeof compileWatcher>
      try {
        compiled = compileWatcher(watcherId, spec)
      } catch {
        continue
      }
      // A watcher's own writes don't wake it (upstream watch.ts): a registered one writes as
      // `<owner>+<id>`, the board's own as `board:watch:<id>`.
      if (by === (registration.own ? `board:watch:${watcherId}` : `${registration.owner}+${watcherId.toLowerCase()}`) && !scheduled) continue
      if (RECEIPTS.has(event.type) && !compiled.all) continue
      const match = compileFilter(compiled.filters, { me: null, actors, messages, access })
      if (!(compiled.criteria ? match(before) || match(after) : id !== null)) continue
      const shown = eventView(event, after, actors, await reads.reader(access, after ? [after] : []))
      add(registration.owner, { type: 'watch.matched', id: await derivedId('board-watch', `@${registration.owner}/${watcherId}`, event.id), payload: { thread, event: shown, watcher: watcherId } })
    }
  }
  await syncMatches(event, registrations, reads, actors, before, message, thread, add)
  return out
}

/** A registrant's sync, in the channels where it may sync: every change it delivers (upstream `dispatch`, its second half). */
async function syncMatches(event: BoardEvent, registrations: readonly Registration[], reads: BoardReads, actors: ActorsState, before: Message | undefined, about: Message | undefined, thread: string, add: (owner: string, matched: QueueEvent) => void) {
  if (!SYNCED.has(event.type) || !about) return
  for (const registration of registrations) {
    if ((registration.sync?.length ?? 0) === 0) continue
    const access = compileAccess(registration.can)
    if (!access.can('sync', about.channel)) continue
    const reader = await reads.reader(access, [about, ...(before ? [before] : [])])
    // A label change re-renders a copy only when the labels change what it shows: sync compares them.
    const shown = { ...eventView(event, about, actors, reader), ...(event.type === 'labels.changed' && before ? { before: view(before, actors, reader) } : {}) }
    add(registration.owner, { type: 'watch.matched', id: await derivedId('board-watch', `@${registration.owner}/@sync`, event.id), payload: { thread, event: shown, sync: true } })
  }
}
