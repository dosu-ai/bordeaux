// The team a request is for (spec 09, "The team, per request"). A self-hosted deployment is one
// team, read from its env; every route asks for the team first and reads the board's URL, org,
// and installation from it, never from env.
import type { BordeauxEnv } from './env.ts'

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
}

/** The one team a self-hosted deployment is (Q4). */
export function envTeam(env: BordeauxEnv): Team {
  if (!env.BORDEAUX_URL) throw new Error("BORDEAUX_URL is required: the board's public URL, which every token is for")
  return {
    id: 'default',
    url: env.BORDEAUX_URL,
    org: env.BORDEAUX_GITHUB_ORG || undefined,
    installation: env.GITHUB_INSTALLATION_ID || undefined,
    owners: (env.BORDEAUX_OWNERS ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean),
  }
}

/** The team a request is for. */
export async function teamOf(_request: Request, env: BordeauxEnv): Promise<Team> {
  return envTeam(env)
}
