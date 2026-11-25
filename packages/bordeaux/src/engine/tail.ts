// A board's TailDO (spec 08, "Long-polls, SSE, and waiters"): the feed's long-polls, off the
// board's own DO. Every SSE tail and `/events?wait=` waits here. The TailDO follows the board's
// log with one long-poll of its own, keeps the newest events and who's who, and runs upstream's
// feed for each waiting reader. What a feed needs that only the board has (messages as they
// were at an index, older events) it asks once however many readers ask, so a post costs the
// board one follow and a read or two, not a feed per tail.
//
// Δ The spec's sketch has tails on hibernatable WebSockets. `board()` drives SSE in the Worker a
// page at a time through the backend's `events`, so the TailDO answers those pages over RPC.
import { DurableObject } from 'cloudflare:workers'
import type { Protocol } from '@vercel/board'
import { foldActors, type ActorsState, type Message } from '../upstream/contract/folds.ts'
import type { BoardEvent } from '../upstream/contract/events.ts'
import { linkedIds } from '../upstream/server/feed.ts'
import type { BoardReads } from '../upstream/server/reads.ts'
import { boardKey } from '../worker/backend.ts'
import type { BordeauxEnv } from '../worker/env.ts'
import { toWireError, type Envelope } from './do.ts'
import { cursorAt } from './engine.ts'
import { feedPage, Waiters, type FeedSource } from './feed-page.ts'
import { fromWire, type WireIdentity } from './identity.ts'
import { Reloader, retried, type CallerVersion } from './reload.ts'

/** How long the TailDO's one long-poll on the board waits for an append. */
const FOLLOW_MS = 20_000
/** How long the TailDO goes on following after its last reader, so the next one finds it current. */
const LINGER_MS = 60_000
/** How many of the newest events it keeps; a reader further back reads the board's log. */
const KEPT = 2_000
/** How many board reads it remembers: messages at an index never change once the index has passed. */
const READS_KEPT = 2_000
/** How long a reader whose cursor is past the TailDO's waits for it to catch up, before reading the board itself. */
const REACH_MS = 2_000

export class TailDO extends DurableObject<BordeauxEnv> {
  private name: string | null = null
  /** The last index followed, and who's who as of it; null until the first reader starts it. */
  private at: { index: number; actors: ActorsState } | null = null
  /** The newest events, in order, ending at `at.index`. */
  private kept: BoardEvent[] = []
  private readonly appended = new Waiters()
  private starting: Promise<void> | null = null
  private following: Promise<void> | null = null
  private readers = 0
  private lingerUntil = 0
  private readonly hurried = new AbortController()
  private readonly reloader: Reloader
  /** Board reads in flight or done, shared by every reader that asks the same. */
  private readonly reads = new Map<string, Promise<unknown>>()
  private catchingUp: Promise<void> | null = null

  constructor(ctx: DurableObjectState, env: BordeauxEnv) {
    super(ctx, env)
    this.reloader = new Reloader(ctx, () => this.env.CF_VERSION_METADATA, () => this.hurried.abort())
  }

  private board() {
    return retried(() => this.env.BOARD.get(this.env.BOARD.idFromName(boardKey(this.name))))
  }

  /** A page of the feed, waited for here (upstream a2.ts `events`, as the board's DO answers it). */
  async events(wire: WireIdentity, query: Protocol['events']['input'], board: string | null, version?: CallerVersion): Promise<Envelope> {
    this.name = board
    this.reloader.newer(version)
    return this.reloader.spell(async () => {
      this.readers++
      try {
        const caller = fromWire(wire)
        const after = query.after !== undefined ? cursorAt(query.after) : undefined
        await this.follow()
        if (after !== undefined) await this.reach(after)
        return { ok: true, value: await feedPage(this.source, caller, query, after, this.hurried.signal) }
      } catch (error) {
        return { ok: false, error: toWireError(error) }
      } finally {
        this.readers--
        this.lingerUntil = Date.now() + LINGER_MS
      }
    })
  }

  /** Starts following the board, once: from its head, with who's who as of it. */
  private async follow() {
    this.starting ??= (async () => {
      const start = await this.board().tailStart()
      this.at = { index: start.index, actors: start.actors }
      this.kept = []
    })().catch((error: unknown) => {
      this.starting = null
      throw error
    })
    await this.starting
    this.following ??= this.loop().finally(() => {
      this.following = null
      // Stopped: the next reader starts again from the board's head, not from what's gone stale.
      this.starting = null
    })
  }

  /** Follows the board while anyone reads, and a minute after. */
  private async loop() {
    while (!this.hurried.signal.aborted && (this.readers > 0 || Date.now() < this.lingerUntil)) {
      try {
        const asked = Date.now()
        const followed = await this.board().tailFollow(this.at!.index, FOLLOW_MS)
        this.reloader.newer(followed.version)
        this.take(followed.events)
        // Nothing, and early: the board is about to reload. Give it the quiet moment it waits for.
        if (followed.events.length === 0 && Date.now() - asked < FOLLOW_MS / 2) await new Promise((resolve) => setTimeout(resolve, 1000))
      } catch (error) {
        console.error('[bordeaux] tail: following the board failed:', (error as Error)?.message ?? error)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  /** Takes the board's events after the last one it has, in order. */
  private take(events: BoardEvent[]) {
    const at = this.at!
    let took = false
    for (const event of events) {
      if (event.index <= at.index) continue
      if (event.index !== at.index + 1) {
        // A gap means this isn't the board it followed: start again from its head.
        console.error(`[bordeaux] tail: expected event ${at.index + 1}, got ${event.index}: starting again`)
        this.starting = null
        break
      }
      foldActors(at.actors, event)
      this.kept.push(event)
      at.index = event.index
      took = true
    }
    if (this.kept.length > KEPT) this.kept.splice(0, this.kept.length - KEPT)
    if (took) this.appended.notify()
  }

  /**
   * Waits until it has followed to `after`: a reader's first page comes from the board itself,
   * so its cursor can be ahead of this follower. If it isn't there soon, it reads the board.
   */
  private async reach(after: number) {
    const deadline = Date.now() + REACH_MS
    while (this.at!.index < after && Date.now() < deadline) {
      const woken = new AbortController()
      const timer = setTimeout(() => woken.abort(), Math.max(0, deadline - Date.now()))
      try {
        await this.appended.next(woken.signal)
      } finally {
        clearTimeout(timer)
      }
    }
    if (this.at!.index < after) {
      // One catch-up at a time, shared while it's out, never kept: the next may find more.
      this.catchingUp ??= this.board()
        .tailFollow(this.at!.index, 0)
        .then((followed) => this.take(followed.events))
        .finally(() => (this.catchingUp = null))
      await this.catchingUp
    }
  }

  /** One board read for every reader that asks the same; kept, since what it reads never changes. */
  private shared<T>(key: string, read: () => Promise<T>): Promise<T> {
    let found = this.reads.get(key) as Promise<T> | undefined
    if (!found) {
      found = read()
      this.reads.set(key, found)
      // A failed read is asked again next time; the rest are kept, the oldest going first.
      found.catch(() => this.reads.delete(key))
      if (this.reads.size > READS_KEPT) this.reads.delete(this.reads.keys().next().value!)
    }
    return found
  }

  /** The board's messages as they were at `index`, read once. */
  private messagesAt(ids: readonly number[], index: number): Promise<Map<number, Message>> {
    if (ids.length === 0) return Promise.resolve(new Map())
    const sorted = [...new Set(ids)].sort((a, b) => a - b)
    return this.shared(`at:${index}:${sorted.join(',')}`, () => this.board().tailMessagesAt(sorted, index))
  }

  private readonly boardReads: BoardReads = {
    messagesAt: (ids, index) => this.messagesAt(ids, index),
    // Where the messages a view links to live: a message never moves, so as of the follower is fine.
    reader: async (access, messages) => {
      if (access.readsAll) return { access, channelOf: () => undefined }
      const ids = [...messages].flatMap((message) => linkedIds(message.links)).filter((id) => id > 0)
      const found = await this.messagesAt(ids, this.at!.index)
      return { access, channelOf: (id) => found.get(id)?.channel }
    },
  }

  /** What this TailDO has followed, as a feed reads it. */
  private readonly source: FeedSource = {
    session: {
      state: async () => ({ state: null, index: this.at!.index }),
      history: async ({ gte, lte }) => {
        const first = this.kept[0]?.index
        const last = Math.min(lte, this.at!.index)
        if (first !== undefined && gte >= first) return this.kept.slice(gte - first, last - first + 1)
        return this.shared(`history:${gte}:${last}`, () => this.board().tailHistory(gte, last))
      },
      // Never asked: each read is `pollFeed` with no wait.
      stream: () => {
        throw new Error('the TailDO waits itself')
      },
    },
    reads: this.boardReads,
    actors: () => this.at!.actors,
    head: () => this.at!.index,
    next: (signal) => this.appended.next(signal),
  }
}
