// The team a request is for (spec 09, "The team, per request"). A self-hosted deployment is one
// team, read from its env. A hosted one serves many, each found by the request's host in the
// registry. Every route asks for the team first and reads the board's URL, org, and installation
// from it, never from env.
import type { BordeauxEnv } from './env.ts'
import { registry, type TeamRecord } from './registry.ts'
import { configOf } from './config.ts'
import type { SyncRow } from './directory.ts'
import { limitsOf, type Limits } from './limits.ts'
import { Lru } from './lru.ts'

export interface Team {
  /** The prefix of every Durable Object key the team's boards use: `default` self-hosted. */
  id: string
  /** The default board's public URL, which every token's audience and issuer name. */
  url: string
  /** The GitHub org whose members are the team's people. */
  org: string | undefined
  /** The board's GitHub App installation on the org. */
  installation: string | undefined
  /** More owners than the org's, by GitHub login, lowercase. */
  owners: string[]
  /** A personal team's one person, by GitHub user ID: they sign in in place of the org's members. */
  person?: string
  /** A hosted team's limits; a self-hosted one has none. */
  limits?: Limits
  /**
   * A hosted team's sync, as data (spec 09, "Sync, later"): its rows, and its links to each
   * platform by provider (the sync App's installation on its account, for `github`). Carried
   * with the team, since board() is built synchronously, here and in the board's DO.
   */
  sync?: { rows: SyncRow[]; links: Record<string, string> }
}

/** The team's board named `name`, or its default board for null: its URL, every token's audience. */
export const boardUrl = (team: Team, name: string | null) => (name === null ? team.url : `${team.url}/b/${name.toLowerCase()}`)

/** The one team a self-hosted deployment is (Q4). */
export function envTeam(env: BordeauxEnv): Team {
  if (env.BORDEAUX_HOSTED_URL) throw new Error('a hosted deployment has no team of its own: each request names one by its host')
  if (!env.BORDEAUX_URL) throw new Error("BORDEAUX_URL is required: the board's public URL, which every token is for")
  return {
    id: 'default',
    url: env.BORDEAUX_URL,
    org: env.BORDEAUX_GITHUB_ORG || undefined,
    installation: env.GITHUB_INSTALLATION_ID || undefined,
    owners: (env.BORDEAUX_OWNERS ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean),
  }
}

/** A hosted team's record, as every route reads it. */
export function teamOfRecord(record: TeamRecord, hub: URL): Team {
  return {
    id: record.id,
    url: `${hub.protocol}//${record.host}`,
    org: record.github.login,
    installation: String(record.github.installation),
    owners: [],
    ...(record.github.type === 'User' ? { person: String(record.github.id) } : {}),
  }
}

/** The hub's URL on a hosted deployment, or null for a self-hosted one. */
export function hubOf(env: BordeauxEnv): URL | null {
  if (!env.BORDEAUX_HOSTED_URL) return null
  const hub = new URL(env.BORDEAUX_HOSTED_URL)
  // What would make a team fall back to the operator's own org, or run the operator's code on every team.
  const set = (['BORDEAUX_URL', 'BORDEAUX_GITHUB_ORG', 'GITHUB_INSTALLATION_ID', 'BORDEAUX_OWNERS'] as const).filter((name) => env[name])
  if (set.length > 0) throw new Error(`a hosted deployment can't set ${set.join(', ')}: each team's come from the registry`)
  const config = configOf(env)
  if (config.watch || config.sync) throw new Error("a hosted deployment's configure() can't set watch or sync: they're a self-hosted deployment's own code")
  return hub
}

/**
 * Hosts this isolate has looked up: a team's record for 5 minutes, how long a suspension takes to
 * reach it, and a host with no team for 30 seconds, so the same unknown host doesn't ask the
 * registry on every request.
 */
const found = new Lru<string, { record: TeamRecord | null; until: number }>(2000)
const FOUND_MS = 5 * 60_000
const MISSING_MS = 30_000

/** Drops what this isolate knows of a host, after its team changed here. */
export const forgetHost = (host: string) => found.delete(host.toLowerCase())

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })

/** A hosted team's record, or what to answer instead: no team at that host, or one that can't be used. */
export async function teamAt(env: BordeauxEnv, hub: URL, host: string, request?: Request): Promise<Team | Response> {
  const key = host.toLowerCase()
  const kept = found.get(key)
  let record = kept && kept.until > Date.now() ? kept.record : undefined
  if (record === undefined) {
    // Every lookup the isolate hasn't kept asks the one registry: a client making up hosts is held
    // to a few a minute, so it can't keep the registry from everyone else.
    const ip = request?.headers.get('cf-connecting-ip')
    if (ip && env.LOOKUP_LIMITER && !(await env.LOOKUP_LIMITER.limit({ key: ip })).success) return refuse(429, 'rate_limited', 'too many hosts looked up from here this minute: wait and try again')
    record = await registry(env).byHost(key)
    found.set(key, { record, until: Date.now() + (record ? FOUND_MS : MISSING_MS) })
  }
  if (!record) return refuse(404, 'no_team', `no team is at ${key}: a GitHub org or person makes one at ${hub.origin}`)
  if (record.held_at || record.state === 'suspended') return refuse(403, 'team_suspended', 'this team is suspended')
  if (record.state === 'deleting') return refuse(403, 'team_uninstalled', "this team's boards are being deleted")
  if (record.state === 'uninstalled') {
    const until = new Date((record.state_at ?? 0) + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    return refuse(403, 'team_uninstalled', `this team's GitHub App was uninstalled: install it on ${record.github.login} again by ${until} to keep its boards`)
  }
  return hostedTeam(env, hub, record)
}

/** A hosted team as its requests see it: its record, and its limits. */
export const hostedTeam = (env: BordeauxEnv, hub: URL, record: TeamRecord): Team => ({ ...teamOfRecord(record, hub), limits: limitsOf(env, record.limits) })
