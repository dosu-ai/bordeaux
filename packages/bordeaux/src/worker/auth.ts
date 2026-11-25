// The verifier chain's first link (spec 03): tokens from the board's own issuer, which signs with
// the DirectoryDO's keys. A token from another issuer isn't this link's to judge: it returns null.
import { HttpError } from '@vercel/board'
import type { HostPrincipal } from '@vercel/board/access'
import { createLocalJWKSet, decodeJwt, errors, jwtVerify, type JWTPayload } from 'jose'
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

async function verified(env: BordeauxEnv, token: string): Promise<JWTPayload> {
  const options = { issuer: env.BORDEAUX_URL, audience: env.BORDEAUX_URL, algorithms: ['ES256'] }
  try {
    return (await jwtVerify(token, await keySet(env, false), options)).payload
  } catch (error) {
    // A key made since this isolate fetched them: fetch again, once.
    if (!(error instanceof errors.JWKSNoMatchingKey)) throw error
    return (await jwtVerify(token, await keySet(env, true), options)).payload
  }
}

/** Who a bordeaux token is, or null for one this issuer didn't sign. */
export async function bordeauxTokens(env: BordeauxEnv, credential: string | null): Promise<HostPrincipal | null> {
  if (!credential) return null
  let iss: string | undefined
  try {
    iss = decodeJwt(credential).iss
  } catch {
    return null
  }
  if (iss !== env.BORDEAUX_URL) return null
  let payload: JWTPayload
  try {
    payload = await verified(env, credential)
  } catch (error) {
    const expired = error instanceof errors.JWTExpired
    throw new HttpError(401, expired ? 'token_expired' : 'invalid_token', expired ? 'this token has expired: sign in again (bx login)' : `this token didn't verify: ${(error as Error).message}`)
  }
  const sub = payload.sub ?? ''
  const person = /^user:(\d+)$/.exec(sub)
  if (person) return { id: personId(person[1]!), kind: 'person', handle: String(payload.login ?? person[1]), expiresAt: payload.exp ? new Date(payload.exp * 1000) : null }
  throw new HttpError(401, 'invalid_token', `this board doesn't take tokens for ${sub || 'no subject'} yet`)
}
