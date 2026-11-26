// What the bordeaux Worker and its Durable Objects are bound to (wrangler.jsonc).
import type { BoardDO } from '../engine/do.ts'
import type { DirectoryDO } from './directory.ts'
import type { TailDO } from '../engine/tail.ts'
import type { RegistryDO } from './registry.ts'

export interface BordeauxEnv {
  /** One Durable Object per board. */
  BOARD: DurableObjectNamespace<BoardDO>
  /**
   * One per board: the feed's long-polls and SSE tails, off the board's own DO (spec 08). Without
   * it, the board's DO holds them itself.
   */
  TAIL?: DurableObjectNamespace<TailDO>
  /** One per team: signing keys, refresh tokens, revoked token IDs. */
  DIRECTORY: DurableObjectNamespace<DirectoryDO>
  /** Hosted only: the one registry of teams, by host, installation, and account (spec 09). */
  REGISTRY?: DurableObjectNamespace<RegistryDO>
  /**
   * Hosted only: the hub's URL (`https://board.dosu.ai`). Set, the deployment serves a team per
   * subdomain of it, found in the registry, and BORDEAUX_URL, BORDEAUX_GITHUB_ORG,
   * GITHUB_INSTALLATION_ID, and BORDEAUX_OWNERS must be unset (spec 09, "Hosted mode").
   */
  BORDEAUX_HOSTED_URL?: string
  /** Hosted: the daily cron's work, one message per team (`bordeaux-teams`), so no one run walks every team. */
  TEAMS_QUEUE?: Queue<{ team: string }>
  /** Hosted: the GitHub org whose owners may use the operator routes (`dosu-ai`). */
  BORDEAUX_OPERATOR_ORG?: string
  /** Hosted: the service's terms and privacy policy. With both set, the hub says installing agrees to them. */
  BORDEAUX_TERMS_URL?: string
  BORDEAUX_PRIVACY_URL?: string
  /** Hosted: registry lookups per client IP (`ratelimits` in wrangler.jsonc), for hosts this isolate hasn't kept. */
  LOOKUP_LIMITER?: RateLimit
  /** Hosted: each team's requests, keyed by team ID (`ratelimits` in wrangler.jsonc); over it, 429. */
  REQUEST_LIMITER?: RateLimit
  /** Hosted: each team's wakes, keyed by team ID; over it, a wake waits. */
  WAKE_LIMITER?: RateLimit
  /** Hosted: a team's named boards (default 20). A team's record may override each limit. */
  BORDEAUX_LIMIT_BOARDS?: string
  /** Hosted: what a team's boards store, in bytes (default 1 GB). */
  BORDEAUX_LIMIT_DATA_BYTES?: string
  /** Hosted: a team's files, in bytes (default 5 GB). */
  BORDEAUX_LIMIT_FILE_BYTES?: string
  /** Hosted: registered watchers per board (default 50). */
  BORDEAUX_LIMIT_WATCHERS?: string
  /** The team's files (spec 08, "Files"): each board's under its own prefix. */
  FILES?: R2Bucket
  /** The board's public URL, which every token's audience must equal. Self-hosted only. */
  BORDEAUX_URL?: string
  /** The GitHub org whose members are the board's people (spec 03). */
  BORDEAUX_GITHUB_ORG?: string
  /** More owners than the org's, by GitHub login, comma-separated. */
  BORDEAUX_OWNERS?: string
  /** The GitHub App's client ID, for the device flow. */
  GITHUB_CLIENT_ID?: string
  /** The GitHub App's client secret, for signing in to the hosted inspector with GitHub's web flow. A secret. */
  GITHUB_CLIENT_SECRET?: string
  /** Upstream's prebuilt inspector page (`@vercel/board/dist/inspect`), as Static Assets. */
  ASSETS?: Fetcher
  /** The GitHub App, as the board itself: checking membership on renewal, and sync (spec 06). */
  GITHUB_APP_ID?: string
  /** The App's private key, PEM, PKCS#1 as GitHub hands it out or PKCS#8. A secret. */
  GITHUB_PRIVATE_KEY?: string
  /** The App's installation on the board's org. */
  GITHUB_INSTALLATION_ID?: string
  /** The App's webhook secret: hosted, what the hub checks the App's installation events by. A secret. */
  GITHUB_WEBHOOK_SECRET?: string
  /** Hosted: the App's slug, which its install page is named by (`github.com/apps/<slug>`). */
  GITHUB_APP_SLUG?: string
  /** Hosted: the sync App's ID, the second GitHub App a team installs to sync with GitHub (spec 09, "Sync, later"). */
  GITHUB_SYNC_APP_ID?: string
  /** Hosted: the sync App's private key, PEM. A secret. */
  GITHUB_SYNC_PRIVATE_KEY?: string
  /** Hosted: the sync App's webhook secret, which the hub and each team's board check its events by. A secret. */
  GITHUB_SYNC_WEBHOOK_SECRET?: string
  /** Hosted: the sync App's slug (`bordeaux-ai-sync` if unset): its install page, and its bot's login, `<slug>[bot]`. */
  GITHUB_SYNC_APP_SLUG?: string
  /**
   * This Worker version's ID and upload time (`version_metadata` in wrangler.jsonc). A board's
   * Durable Object that a newer version calls resets itself once it's idle, so a deploy reaches
   * a board that's always busy (spec 08, "Deploys").
   */
  CF_VERSION_METADATA?: WorkerVersionMetadata
  /** How long one of the board's own runs holds up the next before the runner moves on, in ms (default 60000). For tests. */
  BORDEAUX_RUN_TIMEOUT_MS?: string
  /** "1" turns on `POST /__dev/token`, which mints a person token with no sign-in: local development and tests only. */
  BORDEAUX_DEV?: string
}
