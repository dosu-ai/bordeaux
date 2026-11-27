// A team's boards (spec 08, "Multi-board and teams"): the default board at the deployment's URL,
// and named ones at `/b/<name>/`. Each is its own board() and its own Durable Object, and its URL
// is the audience of the tokens made out to it, so one board's token isn't another's.
import { board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { bordeauxTokens, directory, issuerKeys } from './auth.ts'
import { durable } from './backend.ts'
import type { BordeauxEnv } from './env.ts'
import { configOf, teamSyncOf, type SyncProvider } from './config.ts'
import { Lru } from './lru.ts'
import { boardUrl, type Team } from './team.ts'

export { boardUrl }

/** A board's name: 1 to 64 letters, numbers, and `._-`, matched whatever its case (as upstream's). */
export const BOARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** The board a URL of the team's names: null for the default, a name, or undefined for none. */
export function boardNamed(team: Team, url: string): string | null | undefined {
  const base = team.url.replace(/\/+$/, '')
  const at = url.replace(/\/+$/, '')
  if (at === base) return null
  const found = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/b/([^/]+)$`).exec(at)
  return found && BOARD_NAME.test(found[1]!) ? found[1]!.toLowerCase() : undefined
}

/** board() per team and board, for the boards this isolate served most recently, and the sync it was built with. */
const handles = new Lru<string, { board: ReturnType<typeof board>; team: Team; synced: string }>(500)

/**
 * A hosted team's providers, built from its rows by the Worker's `teamSync` (spec 09): each
 * provider the team has rows for and is linked to.
 */
function teamProviders(env: BordeauxEnv, team: Team): Record<string, SyncProvider> {
  if (!team.sync) return {}
  const built: Record<string, SyncProvider> = {}
  for (const [key, given] of Object.entries(teamSyncOf(env))) {
    const rows = team.sync.rows.filter((row) => row.provider === key)
    // The team's access token on the platform, as its directory keeps it (Linear's, Slack's).
    const link = team.sync.links[key]
    const provider = rows.length > 0 ? given.build(rows, link, () => directory(env, team).syncToken(key, link ?? '')) : null
    if (provider) built[key] = provider
  }
  return built
}

/**
 * board() for the team's board named `name`, or its default board for null: one per isolate. The
 * handle keeps the team as the latest request found it, which its backend sends the board's DO.
 * A hosted team's default board is built again when its sync rows or links change.
 */
export function boardOf(env: BordeauxEnv, team: Team, name: string | null) {
  const key = name?.toLowerCase() ?? ''
  const synced = name === null && team.sync ? JSON.stringify(team.sync) : ''
  const kept = handles.get(`${team.id}/${key}`)
  if (kept && kept.synced === synced) {
    kept.team = team
    return kept.board
  }
  // Upstream's verifier: GitHub Actions, any issuer a grant names, and the board's own service tokens.
  const tokens = oidcTokens({ oidc: { [team.url]: issuerKeys(env, team) } })
  const config = configOf(env)
  // A deployment's own sync, or a hosted team's, built from its rows: never both (hosted refuses `sync`).
  const own = config.sync && Object.fromEntries(Object.entries(config.sync).filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null))
  const sync = name === null && team.sync ? teamProviders(env, team) : own
  const entry = { team, synced } as { board: ReturnType<typeof board>; team: Team; synced: string }
  entry.board = board({
    backend: durable(env, () => entry.team, name),
    ...(config.middleware ? { middleware: config.middleware } : {}),
    // A deployment's own watchers and sync are its default board's.
    ...(name === null && config.watch ? { watch: config.watch } : {}),
    ...(name === null && sync && Object.keys(sync).length > 0 ? { sync } : {}),
    url: boardUrl(team, name),
    ...(name !== null ? { basePath: `/b/${key}` } : {}),
    // The verifier chain (spec 03): the board's own tokens, then upstream's.
    authenticate: async (request) => (await bordeauxTokens(env, team, request.credential, request.audience)) ?? tokens(request),
  })
  handles.set(`${team.id}/${key}`, entry)
  return entry.board
}

/** Boards this isolate has seen exist, for 5 minutes: how long a board deleted elsewhere can still answer here. */
const known = new Lru<string, number>(2000)
const KNOWN_MS = 5 * 60_000

/** Whether the team has a board named `name` (the default board always is). */
export async function exists(env: BordeauxEnv, team: Team, name: string | null): Promise<boolean> {
  if (name === null) return true
  const key = `${team.id}/${name.toLowerCase()}`
  if ((known.get(key) ?? 0) > Date.now()) return true
  const found = await directory(env, team).hasBoard(name.toLowerCase())
  if (found) known.set(key, Date.now() + KNOWN_MS)
  return found
}

export const forget = (team: Team, name: string) => {
  known.delete(`${team.id}/${name.toLowerCase()}`)
  handles.delete(`${team.id}/${name.toLowerCase()}`)
}
