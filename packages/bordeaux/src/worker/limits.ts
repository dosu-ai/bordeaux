// A hosted team's limits (spec 09, "Limits"): the Worker's vars, which a team's record may
// override. Requests and wakes are rate-limiting bindings, keyed by team, so their numbers are
// the bindings' own. A self-hosted team has none.
import type { BordeauxEnv } from './env.ts'

export type Limits = {
  /** Named boards per team. */
  boards: number
  /** What the team's boards' Durable Objects store, in bytes. */
  dataBytes: number
  /** The team's files in R2, in bytes. */
  fileBytes: number
  /** Registered watchers per board. */
  watchers: number
}

const DEFAULTS: Limits = { boards: 20, dataBytes: 1_000_000_000, fileBytes: 5_000_000_000, watchers: 50 }

const VARS = { boards: 'BORDEAUX_LIMIT_BOARDS', dataBytes: 'BORDEAUX_LIMIT_DATA_BYTES', fileBytes: 'BORDEAUX_LIMIT_FILE_BYTES', watchers: 'BORDEAUX_LIMIT_WATCHERS' } as const

/** A hosted team's limits: its record's, else the Worker's vars, else the defaults. */
export function limitsOf(env: BordeauxEnv, overrides: Partial<Limits> = {}): Limits {
  const limits = { ...DEFAULTS }
  for (const [key, name] of Object.entries(VARS) as [keyof Limits, (typeof VARS)[keyof Limits]][]) {
    // An empty var is an unset one, not a limit of 0.
    const given = overrides[key] ?? env[name]
    if (given === undefined || given === '') continue
    const value = Number(given)
    if (Number.isSafeInteger(value) && value >= 0) limits[key] = value
  }
  return limits
}

/** Bytes as people read them: `1 GB`, `5 MB`. */
export const bytes = (n: number) => (n >= 1e9 ? `${+(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)} kB` : `${n} bytes`)
