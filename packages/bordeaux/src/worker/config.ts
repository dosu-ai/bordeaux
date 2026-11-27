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
  /**
   * The team's provider, from its rows and its link to the platform (the sync App's installation,
   * or the Linear organization); null without a link. `token` is the team's access token, for a
   * platform whose tokens the team's directory keeps (`oauth`), for that link only.
   */
  build(rows: SyncRow[], link: string | undefined, token: () => Promise<SyncAccess>): SyncProvider | null
  /** Where an owner turns the platform on for their account, such as the sync App's install page. */
  install?: string
  /** A platform a team links to by OAuth, whose tokens its directory keeps sealed (Linear). */
  oauth?: SyncOAuth
}

/**
 * How close to expiring a team's platform token is refreshed, by its directory. A board keeps a
 * token only until a minute before this, so it never holds one a refresh may have replaced.
 */
export const SYNC_REFRESH_BEFORE_MS = 5 * 60_000

/** An access token, and when it expires (null for never). */
export type SyncAccess = { token: string; expires_at: number | null }

/** A team's tokens on a platform, as its directory keeps them, sealed. */
export type SyncTokens = { access: string; refresh: string | null; expires_at: number | null }

/** How a team links to a platform by OAuth, and how the hub knows the platform's events. */
export type SyncOAuth = {
  /** The platform's page where an admin approves the link, coming back to `redirect` with `state`. */
  authorize(state: string, redirect: string): string
  /**
   * Trades the code the platform sent back for tokens, and the ID its events name the workspace
   * by. Throws `SyncLinkRefused` for a link the hub won't keep.
   */
  exchange(code: string, redirect: string): Promise<{ external: string; name: string; tokens: SyncTokens }>
  /** New tokens for old ones about to expire. */
  refresh(tokens: SyncTokens): Promise<SyncTokens>
  /**
   * A webhook's workspace, if the platform signed it: the ID a team is linked by, whether it says
   * the app was removed, and what the hub answers itself instead (Slack's URL check). Null for a
   * webhook the platform didn't sign, or too old.
   */
  event(request: Request, body: string): Promise<{ external: string | null; removed: boolean; answer?: Record<string, unknown> } | null>
}

/**
 * A link the platform made that the hub won't keep, such as Slack's for a whole Enterprise Grid
 * org. Its message is for the admin who approved it: what to do instead. Asking again won't help.
 */
export class SyncLinkRefused extends Error {}

/** Where a platform's OAuth page sends back an admin who approved an owner's link: the hub's, for every team. */
export const syncRedirect = (env: BordeauxEnv, provider: string) => new URL(`/sync/${provider}/callback`, env.BORDEAUX_HOSTED_URL).href

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
