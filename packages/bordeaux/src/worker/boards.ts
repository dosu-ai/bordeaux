// A team's boards (spec 08, "Multi-board and teams"): the default board at the deployment's URL,
// and named ones at `/b/<name>/`. Each is its own board() and its own Durable Object, and its URL
// is the audience of the tokens made out to it, so one board's token isn't another's.
import { board } from '@vercel/board'
import { oidcTokens } from '@vercel/board/access'
import { bordeauxTokens, directory, issuerKeys } from './auth.ts'
import { durable } from './backend.ts'
import type { BordeauxEnv } from './env.ts'
import { configOf } from './config.ts'
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

/** board() per team and board, for the boards this isolate served most recently. */
const handles = new Lru<string, ReturnType<typeof board>>(500)

/** board() for the team's board named `name`, or its default board for null: one per isolate. */
export function boardOf(env: BordeauxEnv, team: Team, name: string | null) {
  const key = name?.toLowerCase() ?? ''
  let found = handles.get(`${team.id}/${key}`)
  if (!found) {
    // Upstream's verifier: GitHub Actions, any issuer a grant names, and the board's own service tokens.
    const tokens = oidcTokens({ oidc: { [team.url]: issuerKeys(env, team) } })
    const config = configOf(env)
    const sync = config.sync && Object.fromEntries(Object.entries(config.sync).filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null))
    found = board({
      backend: durable(env, team, name),
      ...(config.middleware ? { middleware: config.middleware } : {}),
      // A deployment's own watchers and sync are its default board's.
      ...(name === null && config.watch ? { watch: config.watch } : {}),
      ...(name === null && sync && Object.keys(sync).length > 0 ? { sync } : {}),
      url: boardUrl(team, name),
      ...(name !== null ? { basePath: `/b/${key}` } : {}),
      // The verifier chain (spec 03): the board's own tokens, then upstream's.
      authenticate: async (request) => (await bordeauxTokens(env, team, request.credential, request.audience)) ?? tokens(request),
    })
    handles.set(`${team.id}/${key}`, found)
  }
  return found
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
