// Hosted teams (spec 09, "The registry"): one RegistryDO maps hosts, GitHub installations, and
// GitHub accounts to teams. A team's ID is Dosu's, not GitHub's, since it's in every DO key.
import { DurableObject } from 'cloudflare:workers'
import type { BordeauxEnv } from './env.ts'
import type { Limits } from './limits.ts'

/** A GitHub account a team is linked to, and the App's installation on it. */
export type GitHubLink = { id: number; login: string; type: 'Organization' | 'User'; installation: number }

/** As GitHub has the installation, or `deleting` once the daily cron or an operator is deleting the team. */
export type TeamState = 'active' | 'suspended' | 'uninstalled' | 'deleting'

export type TeamRecord = {
  /** `t_` and 16 random bytes in base32: the prefix of every DO key the team's boards use. */
  id: string
  /** `<login>.<hub host>`, lowercase, fixed at sign-up. */
  host: string
  github: GitHubLink
  state: TeamState
  /** When the team was last suspended or uninstalled. */
  state_at: number | null
  /** When Dosu suspended the team, apart from GitHub's state: only Dosu lifts it. */
  held_at?: number | null
  /** When GitHub says the installation last changed, as of the last event applied: an older one that arrives late is ignored. */
  event_at?: number
  created_at: number
  /** Limits of its own, over the Worker's (spec 09, "Limits"). */
  limits?: Partial<Limits>
  /** What the daily cron last found it uses. */
  usage?: Usage
  /** Its links to platforms it syncs with, by provider: the sync App's installation on its account, for `github` (spec 09). */
  sync?: Record<string, number>
  /** When its links last changed, so a board told of older links keeps the newer ones. */
  sync_at?: number
}

export type Usage = { boards: number; data: number; files: number; at: number }

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
    // Each team's links to platforms it syncs with, by the ID a platform's events name it by.
    ctx.storage.sql.exec('create table if not exists bx_sync_links (provider text not null, external text not null, id text not null, primary key (provider, external))')
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
    // A team being deleted stays so: once it's gone, installing again makes a new one.
    if (known?.state === 'deleting') return { team: known, created: false }
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

  /** Follows a GitHub account's new login. The team's host doesn't move: every token names it (spec 09, "Renames"). */
  async rename(account: number, login: string): Promise<TeamRecord | null> {
    const found = this.one('account', account)
    if (!found || found.github.login === login) return found
    return this.save({ ...found, github: { ...found.github, login } })
  }

  /** Sets a team's own limits, over the Worker's; null for no such team. */
  async setLimits(id: string, limits: Partial<Limits>): Promise<TeamRecord | null> {
    const found = this.one('id', id)
    return found && this.save({ ...found, limits: { ...found.limits, ...limits } })
  }

  /** Marks the team on an installation suspended, uninstalled, or active again; null for none. */
  async setState(installation: number, state: TeamState, eventAt?: number): Promise<TeamRecord | null> {
    const found = this.one('installation', installation)
    if (!found || found.state === 'deleting' || (eventAt !== undefined && (found.event_at ?? 0) > eventAt)) return found
    const at = eventAt !== undefined ? { event_at: eventAt } : {}
    if (found.state === state) return eventAt !== undefined ? this.save({ ...found, ...at }) : found
    return this.save({ ...found, ...at, state, state_at: state === 'active' ? null : Date.now() })
  }

  /**
   * Dosu's suspension of a team, or its end. It's apart from GitHub's state, so neither the
   * installation's unsuspend nor installing the App again lifts it.
   */
  async hold(id: string, held: boolean): Promise<TeamRecord | null> {
    const found = this.one('id', id)
    return found && this.save({ ...found, held_at: held ? (found.held_at ?? Date.now()) : null })
  }

  /**
   * Marks a team `deleting`, if it may be: uninstalled before `before`, or any team when an
   * operator deletes it (`before` is Infinity). Null when it may not, or is gone.
   */
  async claimDeletion(id: string, before: number): Promise<TeamRecord | null> {
    const found = this.one('id', id)
    if (!found) return null
    const due = before === Infinity || found.state === 'deleting' || (found.state === 'uninstalled' && (found.state_at ?? 0) < before)
    return due ? this.save({ ...found, state: 'deleting' }) : null
  }

  /** The team a platform's events for `external` are for (the sync App's installation, for `github`). */
  async byLink(provider: string, external: string): Promise<TeamRecord | null> {
    const [row] = this.ctx.storage.sql.exec<{ id: string }>('select id from bx_sync_links where provider = ? and external = ?', provider, external).toArray()
    return row ? this.one('id', row.id) : null
  }

  /**
   * Links the team on GitHub account `account` to a platform's `external` ID, in place of any link
   * it had for `provider`: null when the account has no team, or one being deleted.
   */
  async link(provider: string, external: number, account: number): Promise<TeamRecord | null> {
    const found = this.one('account', account)
    if (!found || found.state === 'deleting') return null
    const before = found.sync?.[provider]
    if (before !== undefined) this.ctx.storage.sql.exec('delete from bx_sync_links where provider = ? and external = ?', provider, String(before))
    this.ctx.storage.sql.exec('insert or replace into bx_sync_links (provider, external, id) values (?, ?, ?)', provider, String(external), found.id)
    return this.save({ ...found, sync: { ...found.sync, [provider]: external }, sync_at: Math.max(Date.now(), (found.sync_at ?? 0) + 1) })
  }

  /** Forgets a platform's `external` ID: the team it was linked to, or null for none. */
  async unlink(provider: string, external: number): Promise<TeamRecord | null> {
    const [row] = this.ctx.storage.sql.exec<{ id: string }>('delete from bx_sync_links where provider = ? and external = ? returning id', provider, String(external)).toArray()
    const found = row ? this.one('id', row.id) : null
    if (!found || found.sync?.[provider] !== external) return found
    const { [provider]: _gone, ...rest } = found.sync
    return this.save({ ...found, sync: rest, sync_at: Math.max(Date.now(), (found.sync_at ?? 0) + 1) })
  }

  /** Every team, oldest first. */
  async list(): Promise<TeamRecord[]> {
    return this.ctx.storage.sql.exec<{ data: string }>('select data from bx_teams').toArray().map((row) => JSON.parse(row.data) as TeamRecord).sort((a, b) => a.created_at - b.created_at)
  }

  async recordUsage(id: string, usage: Usage): Promise<void> {
    const found = this.one('id', id)
    if (found) this.save({ ...found, usage })
  }

  /** Forgets a team, whose boards are deleted. */
  async remove(id: string): Promise<boolean> {
    this.ctx.storage.sql.exec('delete from bx_sync_links where id = ?', id)
    return this.ctx.storage.sql.exec('delete from bx_teams where id = ? returning 1 as gone', id).toArray().length > 0
  }
}
