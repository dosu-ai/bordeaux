// SHIM (bordeaux): the shape of upstream's A2 board session that the vendored feed uses. bordeaux's
// engine (src/engine/session.ts) implements it on Durable Object SQLite.
import type { BoardEvent } from '../contract/events.ts'

export type BoardSession = {
  /** For the feed, only the head index matters: `channelsReducer` is how it asks. */
  state(reducer: { name: string }, options?: { through?: number | 'latest' }): Promise<{ state: unknown; index: number }>
  /** Events with index in [gte, lte]. */
  history(range: { gte: number; lte: number }): Promise<BoardEvent[]>
  /** Events after `startAfter`, as they land. */
  stream(options: { startAfter: number }): AsyncIterable<BoardEvent>
}
