// One page of the feed (`GET /events`), from whatever holds a board's log: the board's own DO,
// or its TailDO (spec 08, "Long-polls, SSE, and waiters"). Each read is upstream's `pollFeed` with
// no wait; the waiting is here.
//
// Δ The wait isn't `pollFeed`'s: `AbortSignal.timeout()` keeps its timer until it fires, even once
// the call has answered, and a board with many tails and steady posts piled up workerd's 10,000
// active timeouts, failing every feed. This waits for the next append with timers it clears.
import type { BoardEventView, Protocol } from '@vercel/board'
import type { ActorsState } from '../upstream/contract/folds.ts'
import type { BoardSession } from '../upstream/server/a2.ts'
import type { Access } from '../upstream/server/access.ts'
import { lastFeed, pollFeed, ref } from '../upstream/server/feed.ts'
import type { BoardReads } from '../upstream/server/reads.ts'

/** Where a page reads from, and how it waits for the next append. */
export type FeedSource = {
  session: BoardSession
  reads: BoardReads
  /** Who's who now: each page folds its own copy as it goes. */
  actors(): ActorsState
  /** The last index this source has. */
  head(): number
  /** Resolves on the next append, or when `signal` aborts. */
  next(signal: AbortSignal): Promise<void>
}

type Query = Protocol['events']['input']
type Reader = { principal: { access: Access }; actor: { id: string; handle: string } }

/**
 * A page from `after`: what's there, or else the first visible event to land within `wait`
 * seconds, or nothing once it runs out. `hurried` ends a wait at once (a reload is due).
 */
export async function feedPage(source: FeedSource, caller: Reader, query: Query, after: number | undefined, hurried: AbortSignal): Promise<{ events: BoardEventView[]; cursor: string }> {
  const feedFrom = (from: number | undefined) => ({
    session: source.session,
    reads: source.reads,
    after: from,
    filters: query,
    all: query.all ?? false,
    me: { id: caller.actor.id, handle: caller.actor.handle },
    actors: structuredClone(source.actors()),
    access: caller.principal.access,
  })
  const waitMs = hurried.aborted ? 0 : (query.wait ?? 0) * 1000
  const deadline = Date.now() + waitMs
  const stop = new AbortController()
  const hurry = () => stop.abort()
  hurried.addEventListener('abort', hurry, { once: true })
  const guard = setTimeout(() => stop.abort(), waitMs + 30_000)
  try {
    if (query.last !== undefined) {
      const { events, cursor } = await lastFeed(feedFrom(after), query.last, stop.signal)
      return { events, cursor: ref(cursor) }
    }
    let page = await pollFeed(feedFrom(after), 0, stop.signal)
    while (page.events.length === 0 && !stop.signal.aborted) {
      // More of the log than one read takes, or an append since: read on without waiting.
      if (source.head() <= page.cursor) {
        const left = deadline - Date.now()
        if (left <= 0) break
        const woken = new AbortController()
        const timer = setTimeout(() => woken.abort(), left)
        const stopped = () => woken.abort()
        stop.signal.addEventListener('abort', stopped, { once: true })
        try {
          await source.next(woken.signal)
        } finally {
          clearTimeout(timer)
          stop.signal.removeEventListener('abort', stopped)
        }
        if (stop.signal.aborted || source.head() <= page.cursor) break
      }
      page = await pollFeed(feedFrom(page.cursor), 0, stop.signal)
    }
    return { events: page.events, cursor: ref(page.cursor) }
  } finally {
    clearTimeout(guard)
    hurried.removeEventListener('abort', hurry)
  }
}

/** Resolves once something calls `notify()`, or when the signal aborts: the waits of a feed. */
export class Waiters {
  private readonly waiting = new Set<() => void>()

  next(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const wake = () => {
        this.waiting.delete(wake)
        signal.removeEventListener('abort', wake)
        resolve()
      }
      this.waiting.add(wake)
      signal.addEventListener('abort', wake, { once: true })
    })
  }

  notify() {
    for (const wake of [...this.waiting]) wake()
  }
}
