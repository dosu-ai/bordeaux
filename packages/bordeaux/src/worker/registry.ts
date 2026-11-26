// Hosted teams (spec 09, "The registry"): one RegistryDO maps hosts, GitHub installations, and
// GitHub accounts to teams. A team's ID is Dosu's, not GitHub's, since it's in every DO key.
import { DurableObject } from 'cloudflare:workers'
import type { BordeauxEnv } from './env.ts'

/** A GitHub account a team is linked to, and the App's installation on it. */
export type GitHubLink = { id: number; login: string; type: 'Organization' | 'User'; installation: number }

export type TeamState = 'active' | 'suspended' | 'uninstalled'

export type TeamRecord = {
  /** `t_` and 16 random bytes in base32: the prefix of every DO key the team's boards use. */
  id: string
  /** `<login>.<hub host>`, lowercase, fixed at sign-up. */
  host: string
  github: GitHubLink
  state: TeamState
  /** When the team was last suspended or uninstalled. */
  state_at: number | null
  created_at: number
}

/** Subdomains no login gets, whoever signs up first. */
export const RESERVED = ['www', 'api', 'app', 'admin', 'docs', 'status', 'mail', 'hub', 'origin']

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** A new team ID: `t_` and 16 random bytes in base32, lowercase, unpadded. */
export function newTeamId(): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return `t_${out}`
}

/** The one registry. */
export const registry = (env: BordeauxEnv) => {
  if (!env.REGISTRY) throw new Error('a hosted deployment needs the REGISTRY Durable Object binding')
  return env.REGISTRY.get(env.REGISTRY.idFromName('registry'))
}

export class RegistryDO extends DurableObject<BordeauxEnv> {
  constructor(ctx: DurableObjectState, env: BordeauxEnv) {
    super(ctx, env)
    ctx.storage.sql.exec('create table if not exists bx_teams (id text primary key, host text not null unique, account integer not null unique, installation integer not null unique, data text not null)')
  }

  private one(where: string, value: string | number): TeamRecord | null {
    const [row] = this.ctx.storage.sql.exec<{ data: string }>(`select data from bx_teams where ${where} = ?`, value).toArray()
    return row ? (JSON.parse(row.data) as TeamRecord) : null
  }

  private save(record: TeamRecord) {
    this.ctx.storage.sql.exec(
      'insert into bx_teams (id, host, account, installation, data) values (?, ?, ?, ?, ?) on conflict (id) do update set host = excluded.host, account = excluded.account, installation = excluded.installation, data = excluded.data',
      record.id,
      record.host,
      record.github.id,
      record.github.installation,
      JSON.stringify(record),
    )
    return record
  }

  async byHost(host: string): Promise<TeamRecord | null> {
    return this.one('host', host.toLowerCase())
  }

  async byId(id: string): Promise<TeamRecord | null> {
    return this.one('id', id)
  }

  async byInstallation(installation: number): Promise<TeamRecord | null> {
    return this.one('installation', installation)
  }

  /**
   * The team for an installation of the App on a GitHub account, made if there isn't one. The same
   * installation finds the team it made; a new installation on an account that already has a
   * team (installed again after uninstalling) restores that team, host and boards included.
   */
  async register(github: GitHubLink, hub: string): Promise<{ team: TeamRecord; created: boolean }> {
    const same = this.one('installation', github.installation)
    if (same) return { team: same, created: false }
    const known = this.one('account', github.id)
    if (known) return { team: this.save({ ...known, github, state: 'active', state_at: null }), created: false }
    const login = github.login.toLowerCase()
    const taken = (host: string) => this.ctx.storage.sql.exec('select 1 from bx_teams where host = ?', host).toArray().length > 0
    // The login, unless it's reserved or a team's already: then the account's ID, then the installation's too.
    const hosts = [`${login}.${hub}`, `${login}-${github.id}.${hub}`, `${login}-${github.id}-${github.installation}.${hub}`]
    const host = hosts.find((one, n) => !(n === 0 && RESERVED.includes(login)) && !taken(one))
    if (!host) throw new Error(`no host is free for ${github.login}: ${hosts.join(', ')} are taken`)
    const team = this.save({ id: newTeamId(), host, github, state: 'active', state_at: null, created_at: Date.now() })
    return { team, created: true }
  }

  /** Marks the team on an installation suspended, uninstalled, or active again; null for none. */
  async setState(installation: number, state: TeamState): Promise<TeamRecord | null> {
    const found = this.one('installation', installation)
    if (!found || found.state === state) return found
    return this.save({ ...found, state, state_at: state === 'active' ? null : Date.now() })
  }
}
