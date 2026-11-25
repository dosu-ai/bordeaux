// What the bordeaux Worker and its Durable Objects are bound to (wrangler.jsonc).
import type { BoardDO } from '../engine/do.ts'
import type { DirectoryDO } from './directory.ts'
import type { TailDO } from '../engine/tail.ts'

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
  /** The team's files (spec 08, "Files"): each board's under its own prefix. */
  FILES?: R2Bucket
  /** The board's public URL, which every token's audience must equal. */
  BORDEAUX_URL: string
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
  /** The GitHub App, as the board itself: checking membership on renewal now, sync in M3 (spec 06). */
  GITHUB_APP_ID?: string
  /** The App's private key, PEM, PKCS#1 as GitHub hands it out or PKCS#8. A secret. */
  GITHUB_PRIVATE_KEY?: string
  /** The App's installation on the board's org. */
  GITHUB_INSTALLATION_ID?: string
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
