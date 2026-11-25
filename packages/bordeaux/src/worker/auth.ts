// The verifier chain's first link (spec 03): tokens from the board's own issuer, which signs with
// the DirectoryDO's keys. A token from another issuer isn't this link's to judge: it returns null.
import { HttpError } from '@vercel/board'
import type { HostPrincipal } from '@vercel/board/access'
import { createLocalJWKSet, decodeJwt, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import type { BordeauxEnv } from './env.ts'

/** The team's directory: one per deployment for now (Q4). */
export const directory = (env: BordeauxEnv) => env.DIRECTORY.get(env.DIRECTORY.idFromName('default'))

/** A person's ID on a bordeaux board, from their GitHub user ID (spec 03). */
export const personId = (githubId: string | number) => `bordeaux:user:${githubId}`

let keys: { fetched: number; set: ReturnType<typeof createLocalJWKSet> } | null = null

async function keySet(env: BordeauxEnv, refresh: boolean) {
  if (!keys || refresh || Date.now() - keys.fetched > 3_600_000) keys = { fetched: Date.now(), set: createLocalJWKSet(await directory(env).jwks()) }
  return keys.set
}

async function verified(env: BordeauxEnv, token: string, audience: string): Promise<JWTPayload> {
  const options = { issuer: env.BORDEAUX_URL, audience, algorithms: ['ES256'] }
  try {
    return (await jwtVerify(token, await keySet(env, false), options)).payload
  } catch (error) {
    // A key made since this isolate fetched them: fetch again, once.
    if (!(error instanceof errors.JWKSNoMatchingKey)) throw error
    return (await jwtVerify(token, await keySet(env, true), options)).payload
  }
}

/**
 * The issuer's keys as upstream's `oidcTokens()` takes them, so a service token is verified with
 * them directly: a Worker can't fetch its own URL for its JWKS.
 */
export const issuerKeys = (env: BordeauxEnv): JWTVerifyGetKey => async (header, token) => {
  try {
    return await (await keySet(env, false))(header, token)
  } catch (error) {
    if (!(error instanceof errors.JWKSNoMatchingKey)) throw error
    return (await keySet(env, true))(header, token)
  }
}

const SERVICE = /^service:[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}$/

/**
 * A response refusing a revoked service token, or null. Checked in front of board() on every
 * request: board() keeps a token's principal until the token expires, and service tokens last up
 * to 90 days, so a check inside `authenticate` would stop being asked.
 */
export async function revokedToken(env: BordeauxEnv, request: Request): Promise<Response | null> {
  const credential = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!credential) return null
  let claims: JWTPayload
  try {
    claims = decodeJwt(credential)
  } catch {
    return null
  }
  if (claims.iss !== env.BORDEAUX_URL || !SERVICE.test(claims.sub ?? '') || !claims.jti) return null
  if (!(await directory(env).revoked(claims.jti))) return null
  return Response.json({ error: { code: 'token_revoked', message: 'this token was revoked' } }, { status: 401 })
}

/**
 * Who a bordeaux person token is, or null for anything else. A service token is upstream's to verify
 * as an OIDC token of the board's own issuer, which g4 names (spec 03).
 */
export async function bordeauxTokens(env: BordeauxEnv, credential: string | null, audience: string): Promise<HostPrincipal | null> {
  if (!credential) return null
  let iss: string | undefined
  try {
    iss = decodeJwt(credential).iss
  } catch {
    return null
  }
  if (iss !== env.BORDEAUX_URL) return null
  if (SERVICE.test(decodeJwt(credential).sub ?? '')) return null
  let payload: JWTPayload
  try {
    payload = await verified(env, credential, audience)
  } catch (error) {
    const expired = error instanceof errors.JWTExpired
    throw new HttpError(401, expired ? 'token_expired' : 'invalid_token', expired ? 'this token has expired: sign in again (bdx login)' : `this token didn't verify: ${(error as Error).message}`)
  }
  const sub = payload.sub ?? ''
  const person = /^user:(\d+)$/.exec(sub)
  if (person) return { id: personId(person[1]!), kind: 'person', handle: String(payload.login ?? person[1]), expiresAt: payload.exp ? new Date(payload.exp * 1000) : null }
  throw new HttpError(401, 'invalid_token', `this board doesn't take tokens for ${sub || 'no subject'} yet`)
}
