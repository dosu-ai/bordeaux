// One per team: the issuer's signing keys, the refresh tokens people sign in with, and the IDs of
// tokens revoked before they ran out (spec 03, "The bordeaux issuer").
import { DurableObject } from 'cloudflare:workers'
import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK, type JWTPayload } from 'jose'
import type { BordeauxEnv } from './env.ts'

const ALG = 'ES256'

/** A person's sign-in, as a refresh token keeps it. */
export type Session = { id: string; login: string; owner: boolean; checkedAt: number; expiresAt: number }

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
const digest = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

export class DirectoryDO extends DurableObject<BordeauxEnv> {
  private signing: Promise<{ key: CryptoKey; kid: string }> | null = null

  constructor(ctx: DurableObjectState, env: BordeauxEnv) {
    super(ctx, env)
    ctx.storage.sql.exec('create table if not exists bx_keys (kid text primary key, private_jwk text not null, public_jwk text not null, created_at integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_refresh (hash text primary key, data text not null, expires_at integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_revoked (jti text primary key, until integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_owners (principal text primary key, until integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_boards (name text primary key, by text not null, created_at integer not null)')
    ctx.storage.sql.exec('create table if not exists bx_tokens (jti text primary key, sub text not null, by text not null, expires_at integer not null, revoked integer not null default 0)')
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

  /** Makes a named board, or finds the one there: `created` says which. */
  async createBoard(name: string, by: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('insert into bx_boards (name, by, created_at) values (?, ?, ?) on conflict (name) do nothing returning 1 as made', name, by, Date.now()).toArray().length > 0
  }

  async deleteBoard(name: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('delete from bx_boards where name = ? returning 1 as gone', name).toArray().length > 0
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
