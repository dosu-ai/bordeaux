// A deployment's own code (spec 00, "Wiring is code"): what `bordeaux.config.ts` gives board().
// The Worker and every board's Durable Object run the same bundle, so `configure()` at the top of
// the deployment's entry module reaches both before any request.
import type { BoardOptions } from '@vercel/board'

export type BordeauxConfig = {
  /** Runs on every post and edit on every board, before it lands (upstream `board({ middleware })`). */
  middleware?: BoardOptions['middleware']
  /** The default board's own watchers: `{ triage: { tail: 'errors-www', run } }`, run by the board itself. */
  watch?: BoardOptions['watch']
  /** The default board's two-way sync: `{ slack: slack({ adapter }, channels({ '#ops': 'ops' })) }`. */
  sync?: BoardOptions['sync']
}

let config: BordeauxConfig = {}

/** Sets the deployment's config: call it at the top of the Worker's entry module, before any request. */
export function configure(given: BordeauxConfig) {
  config = given
}

export const configOf = () => config
