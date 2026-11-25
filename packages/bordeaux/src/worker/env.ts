// What the bordeaux Worker and its Durable Objects are bound to (wrangler.jsonc).
import type { BoardDO } from '../engine/do.ts'
import type { DirectoryDO } from './directory.ts'

export interface BordeauxEnv {
  /** One Durable Object per board. */
  BOARD: DurableObjectNamespace<BoardDO>
  /** One per team: signing keys, refresh tokens, revoked token IDs. */
  DIRECTORY: DurableObjectNamespace<DirectoryDO>
  /** The board's public URL, which every token's audience must equal. */
  BORDEAUX_URL: string
  /** The GitHub org whose members are the board's people (spec 03). */
  BORDEAUX_GITHUB_ORG?: string
  /** More owners than the org's, by GitHub login, comma-separated. */
  BORDEAUX_OWNERS?: string
  /** The GitHub App's client ID, for the device flow. */
  GITHUB_CLIENT_ID?: string
  /** "1" turns on `POST /__dev/token`, which mints a person token with no sign-in: local development and tests only. */
  BORDEAUX_DEV?: string
}
