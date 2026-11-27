// One per team: the issuer's signing keys, the refresh tokens people sign in with, and the IDs of
// tokens revoked before they ran out (spec 03, "The bordeaux issuer").
import { DurableObject } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK, type JWTPayload } from 'jose'
import { SYNC_REFRESH_BEFORE_MS, SyncLinkRefused, teamSyncOf, type SyncAccess, type SyncTokens } from './config.ts'
import type { BordeauxEnv } from './env.ts'
import { seal, unseal } from './seal.ts'

const ALG = 'ES256'

/** How long an owner's link to a platform waits for an admin to approve it. */
const TICKET_TTL_MS = 10 * 60_000
/** How long after a platform refuses a refresh it's asked again: a dead refresh token isn't sent on every call. */
const REFRESH_RETRY_MS = 5 * 60_000

/** Why a destroyed Durable Object resets itself: its caller expects this one. */
export const DESTROYED = 'bordeaux: destroyed'

/**
 * One of a hosted team's sync settings (spec 09, "Sync, later"): a platform's repo, channel, or
 * team, the board channel it maps to on the team's default board, and which way it goes.
 */
export type SyncRow = { provider: string; external: string; channel: string; direction: 'into' | 'mirror'; by: string; created_at: string }

/** A person's sign-in, as a refresh token keeps it. */
export type Session = { id: string; login: string; owner: boolean; checkedAt: number; expiresAt: number }

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
const digest = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

export class DirectoryDO extends DurableObject<BordeauxEnv> {
  private signing: Promise<{ key: CryptoKey; kid: string }> | null = null
  /** A platform's refresh under way: each refresh token works once, so there's one at a time. */
  private refreshing = new Map<string, Promise<SyncAccess>>()
  /** A platform's last refused refresh, for the tokens it refused, and until when it isn't asked again. */
  private refused = new Map<string, { sealed: string; until: number; message: string }>()

  constructor(ctx: DurableObjectState, env: BordeauxEnv) {
    super(ctx, env)
    ctx.storage.sql.exec('create table if not exists bx_keys (kid text primary key, private_jwk text not null, public_jwk text not null, created_at integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_refresh (hash text primary key, data text not null, expires_at integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_revoked (jti text primary key, until integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_owners (principal text primary key, until integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_boards (name text primary key, by text not null, created_at integer not null)')
    // Named boards deleted: their Durable Objects keep what they had until the team is deleted.
    ctx.storage.sql.exec('create table if not exists bx_deleted_boards (name text primary key, at integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_usage (board text primary key, data integer not null, files integer not null, at integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_tokens (jti text primary key, sub text not null, by text not null, expires_at integer not null, revoked integer not null default 0)')
    ctx.storage.sql.exec('create table if not exists bx_sync (provider text not null, external text not null, channel text not null, direction text not null, by text not null, created_at integer not null, primary key (provider, external))')
    // When the rows last changed, so a board told of older rows keeps the newer ones (spec 09).
    ctx.storage.sql.exec('create table if not exists bx_sync_version (id integer primary key, version integer not null)')
    // An owner's links to a platform, waiting for its admin to approve them, and the team's tokens there, sealed.
    ctx.storage.sql.exec('create table if not exists bx_sync_tickets (ticket text primary key, provider text not null, by text not null, expires_at integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_sync_tokens (provider text primary key, external text not null, sealed text not null)')
    // Tokens a platform won't refresh again, by the sealed tokens it refused: over until linked again.
    ctx.storage.sql.exec('create table if not exists bx_sync_refused (provider text primary key, sealed text not null, message text not null)')
  }

  /** Marks the rows changed: a version later than any before it. */
  private syncChanged() {
    this.ctx.storage.sql.exec('insert into bx_sync_version (id, version) values (0, ?) on conflict (id) do update set version = max(version + 1, excluded.version)', Date.now())
  }

  /** The team's sync rows, and when they last changed (0 for never). */
  async syncState(): Promise<{ rows: SyncRow[]; version: number }> {
    const [row] = this.ctx.storage.sql.exec<{ version: number }>('select version from bx_sync_version where id = 0').toArray()
    return { rows: await this.syncRows(), version: Number(row?.version ?? 0) }
  }

  /** The current signing key, made on first use. */
  private key(): Promise<{ key: CryptoKey; kid: string }> {
    this.signing ??= (async () => {
      const [row] = this.ctx.storage.sql.exec<{ kid: string; private_jwk: string }>('select kid, private_jwk from bx_keys order by created_at desc limit 1').toArray()
      if (row) return { key: (await importJWK(JSON.parse(row.private_jwk) as JWK, ALG)) as CryptoKey, kid: row.kid }
      const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true })
      const kid = crypto.randomUUID()
      const priv = { ...(await exportJWK(privateKey)), kid, alg: ALG }
      const pub = { ...(await exportJWK(publicKey)), kid, alg: ALG, use: 'sig' }
      this.ctx.storage.sql.exec('insert into bx_keys (kid, private_jwk, public_jwk, created_at) values (?, ?, ?, ?)', kid, JSON.stringify(priv), JSON.stringify(pub), Date.now())
      return { key: privateKey as CryptoKey, kid }
    })()
    return this.signing
  }

  /** The issuer's public keys, for `/.well-known/jwks.json` and the Worker's verifier. */
  async jwks(): Promise<{ keys: JWK[] }> {
    await this.key()
    const rows = this.ctx.storage.sql.exec<{ public_jwk: string }>('select public_jwk from bx_keys').toArray()
    return { keys: rows.map((row) => JSON.parse(row.public_jwk) as JWK) }
  }

  /** A token from the team's issuer at `url`, made out to `audience` (one of its boards' URLs, the default board's if left out), lasting `ttl` seconds. */
  async mint(claims: JWTPayload & { sub: string }, ttl: number, url: string, audience?: string): Promise<{ token: string; jti: string; expiresAt: number }> {
    const { key, kid } = await this.key()
    const jti = crypto.randomUUID()
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT(claims).setProtectedHeader({ alg: ALG, kid, typ: 'JWT' }).setIssuer(url).setAudience(audience ?? url).setIssuedAt(now).setExpirationTime(now + ttl).setJti(jti).sign(key)
    return { token, jti, expiresAt: (now + ttl) * 1000 }
  }

  /** Keeps a person's sign-in under a new refresh token, which only its hash names here. */
  async startSession(session: Session): Promise<string> {
    const token = `bxr_${hex(crypto.getRandomValues(new Uint8Array(32)).buffer)}`
    this.ctx.storage.sql.exec('insert into bx_refresh (hash, data, expires_at) values (?, ?, ?)', await digest(token), JSON.stringify(session), session.expiresAt)
    return token
  }

  /** Spends a refresh token: the sign-in it kept, which the caller keeps going under a new one, or null. */
  async takeSession(token: string): Promise<Session | null> {
    const hash = await digest(token)
    const [row] = this.ctx.storage.sql.exec<{ data: string; expires_at: number }>('select data, expires_at from bx_refresh where hash = ?', hash).toArray()
    this.ctx.storage.sql.exec('delete from bx_refresh where hash = ? or expires_at < ?', hash, Date.now())
    if (!row || Number(row.expires_at) < Date.now()) return null
    return JSON.parse(row.data) as Session
  }

  /** Records whether a person is a board owner, as their last sign-in or renewal found, until it ends. */
  async setOwner(principal: string, owner: boolean, until: number) {
    if (owner) this.ctx.storage.sql.exec('insert or replace into bx_owners (principal, until) values (?, ?)', principal, until)
    else this.ctx.storage.sql.exec('delete from bx_owners where principal = ?', principal)
  }

  async isOwner(principal: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('select 1 from bx_owners where principal = ? and until > ?', principal, Date.now()).toArray().length > 0
  }

  /** The team's named boards (the default board isn't one: it always is). */
  async boards(): Promise<{ name: string; by: string; created_at: string }[]> {
    return this.ctx.storage.sql
      .exec<{ name: string; by: string; created_at: number }>('select * from bx_boards order by name')
      .toArray()
      .map((row) => ({ name: row.name, by: row.by, created_at: new Date(Number(row.created_at)).toISOString() }))
  }

  async hasBoard(name: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('select 1 from bx_boards where name = ?', name).toArray().length > 0
  }

  /** Makes a named board, or finds the one there (false), or makes none past `max` boards ('full'). */
  async createBoard(name: string, by: string, max = Infinity): Promise<boolean | 'full'> {
    if (await this.hasBoard(name)) return false
    const [row] = this.ctx.storage.sql.exec<{ n: number }>('select count(*) as n from bx_boards').toArray()
    if (Number(row?.n ?? 0) >= max) return 'full'
    return this.ctx.storage.sql.exec('insert into bx_boards (name, by, created_at) values (?, ?, ?) on conflict (name) do nothing returning 1 as made', name, by, Date.now()).toArray().length > 0
  }

  /** Keeps what one of the team's boards stores and its files' bytes, as it reported them: the team's totals. */
  async usage(board: string, data: number, files: number): Promise<{ data: number; files: number }> {
    this.ctx.storage.sql.exec('insert into bx_usage (board, data, files, at) values (?, ?, ?, ?) on conflict (board) do update set data = excluded.data, files = excluded.files, at = excluded.at', board, data, files, Date.now())
    return this.totals()
  }

  async deleteBoard(name: string): Promise<boolean> {
    const gone = this.ctx.storage.sql.exec('delete from bx_boards where name = ? returning 1 as gone', name).toArray().length > 0
    if (gone) this.ctx.storage.sql.exec('insert or replace into bx_deleted_boards (name, at) values (?, ?)', name, Date.now())
    return gone
  }

  /** Every named board the team has had, deleted or not: what deleting the team deletes. */
  async everyBoard(): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ name: string }>('select name from bx_boards union select name from bx_deleted_boards order by name').toArray().map((row) => row.name)
  }

  /** The team's totals, as its boards last reported them. */
  async totals(): Promise<{ data: number; files: number }> {
    const [row] = this.ctx.storage.sql.exec<{ data: number | null; files: number | null }>('select sum(data) as data, sum(files) as files from bx_usage').toArray()
    return { data: Number(row?.data ?? 0), files: Number(row?.files ?? 0) }
  }

  /** Deletes all the team's directory keeps: its keys, sign-ins, boards' names, and tokens. */
  async destroy() {
    await this.ctx.storage.deleteAll()
    // What this instance holds in memory goes too: a call after this starts from nothing.
    this.ctx.abort(DESTROYED)
  }

  /** The team's sync settings, by provider and external ID. */
  async syncRows(): Promise<SyncRow[]> {
    return this.ctx.storage.sql
      .exec<{ provider: string; external: string; channel: string; direction: string; by: string; created_at: number }>('select * from bx_sync order by provider, external')
      .toArray()
      .map((row) => ({ provider: row.provider, external: row.external, channel: row.channel, direction: row.direction === 'mirror' ? 'mirror' : 'into', by: row.by, created_at: new Date(Number(row.created_at)).toISOString() }))
  }

  /** Maps a platform's external ID to a board channel, or changes where it maps: true when it's new. */
  async addSync(row: { provider: string; external: string; channel: string; direction: 'into' | 'mirror'; by: string }): Promise<boolean> {
    const known = this.ctx.storage.sql.exec('select 1 from bx_sync where provider = ? and external = ?', row.provider, row.external).toArray().length > 0
    this.ctx.storage.sql.exec(
      'insert into bx_sync (provider, external, channel, direction, by, created_at) values (?, ?, ?, ?, ?, ?) on conflict (provider, external) do update set channel = excluded.channel, direction = excluded.direction, by = excluded.by',
      row.provider,
      row.external,
      row.channel,
      row.direction,
      row.by,
      Date.now(),
    )
    this.syncChanged()
    return !known
  }

  /** Stops syncing a platform's external ID; false for one that wasn't. */
  async removeSync(provider: string, external: string): Promise<boolean> {
    const gone = this.ctx.storage.sql.exec('delete from bx_sync where provider = ? and external = ? returning 1 as gone', provider, external).toArray().length > 0
    if (gone) this.syncChanged()
    return gone
  }

  /** A ticket for an owner's link to a platform: it's good for 10 minutes, once. */
  async syncTicket(provider: string, by: string): Promise<string> {
    this.ctx.storage.sql.exec('delete from bx_sync_tickets where expires_at <= ?', Date.now())
    const ticket = hex(crypto.getRandomValues(new Uint8Array(32)).buffer as ArrayBuffer)
    this.ctx.storage.sql.exec('insert into bx_sync_tickets (ticket, provider, by, expires_at) values (?, ?, ?, ?)', ticket, provider, by, Date.now() + TICKET_TTL_MS)
    return ticket
  }

  /** Takes a ticket: the owner it was made for, or null for one that's unknown, used, or too old. */
  async takeSyncTicket(provider: string, ticket: string): Promise<string | null> {
    const [row] = this.ctx.storage.sql.exec<{ by: string; expires_at: number }>('delete from bx_sync_tickets where ticket = ? and provider = ? returning by, expires_at', ticket, provider).toArray()
    return row && Number(row.expires_at) > Date.now() ? row.by : null
  }

  private syncKey(): string {
    if (!this.env.BORDEAUX_SYNC_KEY) throw new Error('BORDEAUX_SYNC_KEY is not set: the team\'s platform tokens are sealed with it')
    return this.env.BORDEAUX_SYNC_KEY
  }

  /** Keeps the team's tokens on a platform, for its workspace `external`, in place of any before. */
  async putSyncTokens(provider: string, external: string, tokens: SyncTokens): Promise<void> {
    const sealed = await seal(this.syncKey(), JSON.stringify(tokens), `${provider}:${external}`)
    this.ctx.storage.sql.exec('insert or replace into bx_sync_tokens (provider, external, sealed) values (?, ?, ?)', provider, external, sealed)
  }

  /** The team's links a platform won't refresh again, by provider, with what to do: link again. */
  async syncRefused(): Promise<Record<string, string>> {
    const rows = this.ctx.storage.sql.exec<{ provider: string; message: string }>('select r.provider, r.message from bx_sync_refused r join bx_sync_tokens t on t.provider = r.provider and t.sealed = r.sealed').toArray()
    return Object.fromEntries(rows.map((row) => [row.provider, row.message]))
  }

  /** Drops the team's tokens on a platform, only for workspace `external` when it's named: true when there were some. */
  async dropSyncTokens(provider: string, external?: string): Promise<boolean> {
    const dropped = external === undefined
      ? this.ctx.storage.sql.exec('delete from bx_sync_tokens where provider = ? returning 1 as gone', provider)
      : this.ctx.storage.sql.exec('delete from bx_sync_tokens where provider = ? and external = ? returning 1 as gone', provider, external)
    return dropped.toArray().length > 0
  }

  /**
   * The team's access token on a platform, for workspace `link`, the one the registry links the
   * team to: tokens for any other are refused. It's refreshed first when it's within 5 minutes of
   * expiring. A refresh gives a new refresh token and the old one stops working, so this is the
   * one place that refreshes, one at a time. A refused refresh isn't tried again for 5 minutes,
   * and the token it was for is used while it lasts. One the platform won't ever take again
   * (`SyncLinkRefused`) isn't tried again at all: it's kept, for `bdx sync list` and `bdx health`,
   * until an owner links again.
   */
  async syncToken(provider: string, link: string): Promise<SyncAccess> {
    const [row] = this.ctx.storage.sql.exec<{ external: string; sealed: string }>('select external, sealed from bx_sync_tokens where provider = ?', provider).toArray()
    if (!row) throw new Error(`this team has no ${provider} link: an owner links it with bdx sync link ${provider}`)
    // Two links approved at once may leave one workspace's tokens under the other's link.
    if (row.external !== link) throw new Error(`this team's ${provider} tokens are for another workspace than the one it's linked to: an owner links it again with bdx sync link ${provider}`)
    const tokens = JSON.parse(await unseal(this.syncKey(), row.sealed, `${provider}:${row.external}`)) as SyncTokens
    const current = { token: tokens.access, expires_at: tokens.expires_at }
    if (tokens.expires_at === null || tokens.expires_at - Date.now() > SYNC_REFRESH_BEFORE_MS) return current
    const lasting = () => tokens.expires_at !== null && tokens.expires_at > Date.now() + 10_000
    const [over] = this.ctx.storage.sql.exec<{ message: string }>('select message from bx_sync_refused where provider = ? and sealed = ?', provider, row.sealed).toArray()
    if (over) {
      if (lasting()) return current
      throw new Error(over.message)
    }
    const refused = this.refused.get(provider)
    if (refused && refused.sealed === row.sealed && refused.until > Date.now()) {
      if (lasting()) return current
      throw new Error(refused.message)
    }
    let pending = this.refreshing.get(provider)
    if (!pending) {
      pending = (async () => {
        const oauth = teamSyncOf(this.env)[provider]?.oauth
        if (!oauth) throw new Error(`this deployment doesn't sync ${provider}`)
        let fresh: SyncTokens
        try {
          fresh = await oauth.refresh(tokens)
        } catch (error) {
          if (error instanceof SyncLinkRefused) {
            this.ctx.storage.sql.exec('insert or replace into bx_sync_refused (provider, sealed, message) values (?, ?, ?)', provider, row.sealed, error.message)
            if (lasting()) return current
            throw new Error(error.message)
          }
          const until = Date.now() + REFRESH_RETRY_MS
          const message = `${(error as Error)?.message ?? error} (asked again after ${new Date(until).toISOString()})`
          this.refused.set(provider, { sealed: row.sealed, until, message })
          if (lasting()) return current
          throw new Error(message)
        }
        const sealed = await seal(this.syncKey(), JSON.stringify(fresh), `${provider}:${row.external}`)
        // Only over the tokens it refreshed: a link made while it refreshed keeps its own.
        this.ctx.storage.sql.exec('update bx_sync_tokens set sealed = ? where provider = ? and sealed = ?', sealed, provider, row.sealed)
        return { token: fresh.access, expires_at: fresh.expires_at }
      })().finally(() => this.refreshing.delete(provider))
      this.refreshing.set(provider, pending)
    }
    return pending
  }

  /** Keeps a service token's record, to list and revoke it: never the token itself. */
  async recordToken(token: { jti: string; sub: string; by: string; expiresAt: number }) {
    this.ctx.storage.sql.exec('insert into bx_tokens (jti, sub, by, expires_at) values (?, ?, ?, ?)', token.jti, token.sub, token.by, token.expiresAt)
  }

  /** The service tokens that haven't run out. */
  async tokens() {
    return this.ctx.storage.sql
      .exec<{ jti: string; sub: string; by: string; expires_at: number; revoked: number }>('select * from bx_tokens where expires_at > ? order by expires_at', Date.now())
      .toArray()
      .map((row) => ({ jti: row.jti, sub: row.sub, by: row.by, expires_at: new Date(Number(row.expires_at)).toISOString(), revoked: row.revoked === 1 }))
  }

  /** Revokes a service token by its ID; false for one this board never made. */
  async revokeToken(jti: string): Promise<boolean> {
    const [row] = this.ctx.storage.sql.exec<{ expires_at: number }>('select expires_at from bx_tokens where jti = ?', jti).toArray()
    if (!row) return false
    this.ctx.storage.sql.exec('update bx_tokens set revoked = 1 where jti = ?', jti)
    await this.revoke(jti, Number(row.expires_at))
    return true
  }

  /** Revokes a token by its ID until it would have run out anyway. */
  async revoke(jti: string, until: number) {
    this.ctx.storage.sql.exec('insert or replace into bx_revoked (jti, until) values (?, ?)', jti, until)
  }

  async revoked(jti: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('select 1 from bx_revoked where jti = ? and until > ?', jti, Date.now()).toArray().length > 0
  }
}
