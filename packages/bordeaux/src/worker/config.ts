// A deployment's own code (spec 00, "Wiring is code"): what `bordeaux.config.ts` gives board().
// The Worker and every board's Durable Object run the same bundle, so `configure()` at the top of
// the deployment's entry module reaches both before any request.
import type { BoardOptions } from '@vercel/board'
import type { SyncRow } from './directory.ts'
import type { BordeauxEnv } from './env.ts'

/** One of upstream's sync providers, as board() takes it. */
export type SyncProvider = NonNullable<BoardOptions['sync']>[string]

/**
 * A built-in provider a hosted team may sync with, built from the team's rows (spec 09, "Sync,
 * later"). The hosted Worker's `configure()` names them: `teamSync: { github: githubTeamSync(env) }`.
 */
export type TeamSync = {
  /** Why a team on the platform account `login` can't sync `external`, or null when it can. */
  refuse(external: string, login: string | undefined): string | null
  /** The team's provider, from its rows and its link to the platform (the sync App's installation); null without a link. */
  build(rows: SyncRow[], link: string | undefined): SyncProvider | null
  /** Where an owner turns the platform on for their account, such as the sync App's install page. */
  install: string
}

export type BordeauxConfig = {
  /** Runs on every post and edit on every board, before it lands (upstream `board({ middleware })`). */
  middleware?: BoardOptions['middleware']
  /** The default board's own watchers: `{ triage: { tail: 'errors-www', run } }`, run by the board itself. */
  watch?: BoardOptions['watch']
  /**
   * The default board's two-way sync: `{ slack: slackSync(env, channels({ '#ops': 'ops' })) }`.
   * An entry that's null (a sync helper whose secrets aren't set) is left out.
   */
  sync?: Record<string, SyncProvider | null>
  /**
   * Hosted only: the built-in providers each team may sync with, by key (`github`), built from
   * the team's own rows (`bdx sync add`). An entry that's null (its secrets aren't set) is left
   * out. A self-hosted deployment ignores it: its sync is `sync`.
   */
  teamSync?: Record<string, TeamSync | null>
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

/** The providers hosted teams may sync with, those whose secrets are set. */
export function teamSyncOf(env: BordeauxEnv): Record<string, TeamSync> {
  const given = configOf(env).teamSync ?? {}
  return Object.fromEntries(Object.entries(given).filter((entry): entry is [string, TeamSync] => entry[1] !== null))
}
