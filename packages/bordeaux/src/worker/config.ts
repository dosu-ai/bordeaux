// A deployment's own code (spec 00, "Wiring is code"): what `bordeaux.config.ts` gives board().
// The Worker and every board's Durable Object run the same bundle, so `configure()` at the top of
// the deployment's entry module reaches both before any request.
import type { BoardOptions } from '@vercel/board'
import type { BordeauxEnv } from './env.ts'

export type BordeauxConfig = {
  /** Runs on every post and edit on every board, before it lands (upstream `board({ middleware })`). */
  middleware?: BoardOptions['middleware']
  /** The default board's own watchers: `{ triage: { tail: 'errors-www', run } }`, run by the board itself. */
  watch?: BoardOptions['watch']
  /**
   * The default board's two-way sync: `{ slack: slackSync(env, channels({ '#ops': 'ops' })) }`.
   * An entry that's null (a sync helper whose secrets aren't set) is left out.
   */
  sync?: Record<string, NonNullable<BoardOptions['sync']>[string] | null>
}

type Given = BordeauxConfig | ((env: BordeauxEnv) => BordeauxConfig)
let given: Given = {}
let built: BordeauxConfig | null = null

/**
 * Sets the deployment's config: call it at the top of the Worker's entry module, before any
 * request. A function gets the Worker's env, for config built from its secrets (a platform's
 * adapter), and runs once per isolate.
 */
export function configure(config: Given) {
  given = config
  built = null
}

export const configOf = (env: BordeauxEnv): BordeauxConfig => (built ??= typeof given === 'function' ? given(env) : given)
