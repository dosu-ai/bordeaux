// Registered watchers (spec 04): a registrant's tails, the matches they make, and the queue it
// pulls them from. Ported from upstream at the pinned commit: the registry (src/server/registry.ts),
// the queue (src/server/registered.ts, nearly line for line), and the matching (src/server/watch.ts
// `dispatch`), on the board's DO instead of A2 sessions.
//
// Δ Matching uses the access a registrant had when it registered (its `x-board-can`-free summary),
// and every pull filters again by what it may read then: a narrower view, never a wider one.
// Δ A registration with a `url` is woken (`POST <url>/wake`) when it has matches, by the DO's alarm.
import { HttpError, type BoardEventView, type MatchView, type RegistrationView } from '@vercel/board'
import { compileAccess, type AccessSummary } from '@vercel/board/access'
import { derivedId } from '../upstream/client/ids.ts'
import type { BoardEvent } from '../upstream/contract/events.ts'
import type { ActorsState } from '../upstream/contract/folds.ts'
import type { Access } from '../upstream/server/access.ts'
import { compileFilter, eventView, foldEvent, loadBefore } from '../upstream/server/feed.ts'
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
/** Bookkeeping events, matched only by a tail that asks for `--all` (upstream watch.ts `RECEIPTS`). */
const RECEIPTS = new Set(['actor.seen', 'message.synced', 'message.files_synced', 'task.renewed'])

/** A registration, with what its registrant could read when it registered. */
export type Registration = RegistrationView & { principal: { id: string; kind: string; handle: string }; can: AccessSummary }
export type RegistryState = { byOwner: Record<string, Registration> }

/** The same on both ends as upstream's: a board on `http()` hashes its watchers, and the board it uses what it holds. */
export async function watchersHash(watch: Record<string, WatcherSpec>, sync: readonly SyncEntrySpec[] = []): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalWatchers(watch, sync))))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

export const viewOf = ({ principal: _principal, can: _can, ...view }: Registration): RegistrationView => view

// --- The queue: upstream's registered.ts. ---

type Pending = { id: string; queue: string; thread: string; event: unknown; attempts: number; lease: { id: string; until: number } | null; retryAt: number | null }
export type QueueState = { queues: Record<string, string[]>; pending: Record<string, Pending> }
export const emptyQueue = (): QueueState => ({ queues: {}, pending: {} })

type QueueEvent =
  | { type: 'watch.matched'; id: string; payload: { thread: string; event: unknown; watcher?: string; sync?: true } }
  | { type: 'watch.leased'; payload: { matched: string; lease: string; until: number } }
  | { type: 'watch.acked'; payload: { matched: string; lease: string; error?: string; retryAt?: number } }
  | { type: 'watch.expired'; payload: { matched: string; lease: string } }
  | { type: 'watch.failed'; payload: { matched: string; thread: string; error: string } }
  | { type: 'watch.skipped'; payload: { matched: string; reason: string } }

const queueKey = (queue: string, thread: string) => `${queue}\u001f${thread}`

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
      const { watcher, sync, thread } = event.payload
      const queue = watcher ?? (sync ? SYNC_QUEUE : undefined)
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

/** Leases each queue's oldest match that's free, which the registrant may still have (upstream `pull` and `lease`). */
export function pull(state: QueueState, options: { access: Access; limit: number; now: number }): { events: QueueEvent[]; matches: MatchView[] } {
  const events: QueueEvent[] = []
  const matches: MatchView[] = []
  for (const ids of Object.values(state.queues)) {
    if (matches.length >= options.limit) break
    const head = state.pending[ids[0]!]!
    if (head.queue.startsWith('@inbox:') || !free(head, options.now)) continue
    let attempts = head.attempts
    if (head.lease) {
      events.push({ type: 'watch.expired', payload: { matched: head.id, lease: head.lease.id } })
      attempts += 1
      if (attempts >= MATCH_TRIES) {
        events.push(failure(head, `its lease ran out ${attempts} times`))
        continue
      }
    }
    if (!readable(options.access, head.event, head.queue)) {
      events.push({ type: 'watch.skipped', payload: { matched: head.id, reason: "its registrant can't have it anymore" } })
      continue
    }
    const lease = leaseId()
    events.push({ type: 'watch.leased', payload: { matched: head.id, lease, until: options.now + LEASE_MS } })
    matches.push({ id: head.id, watcher: head.queue, thread: head.thread, lease, attempt: attempts, event: head.event as BoardEventView })
  }
  return { events, matches }
}

/** How a pulled match went: done, skipped, or an error that waits, then tries again (upstream `ack`). */
export function ack(state: QueueState, id: string, body: { lease: string; error?: string | undefined; skip?: boolean | undefined }, now: number): QueueEvent[] {
  const found = state.pending[id]
  if (!found) throw new HttpError(404, 'no_match', `no match ${id} is waiting for this token`)
  if (found.lease?.id !== body.lease) throw new HttpError(409, 'stale_lease', 'that lease ran out, and the match was pulled again')
  if (body.skip) return [{ type: 'watch.skipped', payload: { matched: id, reason: 'its board skipped it' } }]
  if (body.error === undefined) return [{ type: 'watch.acked', payload: { matched: id, lease: body.lease } }]
  const attempts = found.attempts + 1
  if (attempts >= MATCH_TRIES) return [{ type: 'watch.acked', payload: { matched: id, lease: body.lease, error: body.error } }, failure(found, body.error)]
  return [{ type: 'watch.acked', payload: { matched: id, lease: body.lease, error: body.error, retryAt: now + retryDelay(attempts) } }]
}

// --- Matching: upstream watch.ts `dispatch`, for registered watchers. ---

/** Each registrant's matches for `event`: the message before or after it must match, as in a tail. */
export async function matchesFor(event: BoardEvent, registrations: readonly Registration[], reads: BoardReads, actors: ActorsState): Promise<Map<string, QueueEvent[]>> {
  const out = new Map<string, QueueEvent[]>()
  if (event.type === 'thread.synced') return out
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
      // A watcher's own writes don't wake it (upstream watch.ts): it writes as `<owner>+<id>`.
      if (by === `${registration.owner}+${watcherId.toLowerCase()}` && !scheduled) continue
      if (RECEIPTS.has(event.type) && !compiled.all) continue
      const match = compileFilter(compiled.filters, { me: null, actors, messages, access })
      if (!(compiled.criteria ? match(before) || match(after) : id !== null)) continue
      const shown = eventView(event, after, actors, await reads.reader(access, after ? [after] : []))
      const list = out.get(registration.owner) ?? out.set(registration.owner, []).get(registration.owner)!
      list.push({ type: 'watch.matched', id: await derivedId('board-watch', `@${registration.owner}/${watcherId}`, event.id), payload: { thread, event: shown, watcher: watcherId } })
    }
  }
  return out
}
