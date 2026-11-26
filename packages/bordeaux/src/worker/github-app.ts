// The board's GitHub App, as the board itself: an installation token minted from the App's private
// key (spec 06's GITHUB_* secrets), for what no person's token is kept for, such as checking that
// someone is still in the org when their sign-in renews (spec 03).
import { importPKCS8, SignJWT } from 'jose'
import type { BordeauxEnv } from './env.ts'
import type { Team } from './team.ts'

type Fetch = typeof fetch

/** The App's credentials and its installation on the team's org, or null when the team has no App installed. */
export function appOf(env: BordeauxEnv, team: Team): { id: string; key: string; installation: string } | null {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY || !team.installation) return null
  return { id: env.GITHUB_APP_ID, key: env.GITHUB_PRIVATE_KEY, installation: team.installation }
}

/** DER length bytes. */
function length(n: number): number[] {
  if (n < 0x80) return [n]
  const bytes: number[] = []
  for (let left = n; left > 0; left >>= 8) bytes.unshift(left & 0xff)
  return [0x80 | bytes.length, ...bytes]
}

/**
 * GitHub hands out App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`); WebCrypto takes PKCS#8. The PKCS#8
 * form wraps the same key: version 0, the rsaEncryption algorithm, and the PKCS#1 bytes.
 */
export function toPkcs8(pem: string): string {
  if (pem.includes('BEGIN PRIVATE KEY')) return pem
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, '')), (c) => c.charCodeAt(0))
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]
  const octets = [0x04, ...length(der.length), ...der]
  const body = [0x02, 0x01, 0x00, ...algorithm, ...octets]
  const wrapped = Uint8Array.from([0x30, ...length(body.length), ...body])
  const base64 = btoa(String.fromCharCode(...wrapped)).replace(/.{64}/g, '$&\n')
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`
}

/** The App itself, as GitHub's API knows it: a JWT signed with its private key, good for 10 minutes. */
async function appJwt(app: { id: string; key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  // Issued a minute early, as GitHub suggests, for clocks that run ahead.
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(app.id).setIssuedAt(now - 60).setExpirationTime(now + 540).sign(await importPKCS8(toPkcs8(app.key), 'RS256'))
}

/** The account an installation of the App is on, as GitHub says, asked as the App; null for one that isn't the App's. */
export async function installationOf(env: BordeauxEnv, installation: string, send: Fetch = fetch): Promise<{ id: number; login: string; type: string } | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) throw new Error('the hub has no GitHub App to ask: set GITHUB_APP_ID and the GITHUB_PRIVATE_KEY secret')
  const response = await send(`https://api.github.com/app/installations/${encodeURIComponent(installation)}`, {
    headers: { authorization: `Bearer ${await appJwt({ id: env.GITHUB_APP_ID, key: env.GITHUB_PRIVATE_KEY })}`, accept: 'application/vnd.github+json', 'user-agent': 'bordeaux' },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub didn't say whose installation ${installation} is: ${response.status}`)
  const { account } = (await response.json()) as { account: { id: number; login: string; type: string } }
  return { id: account.id, login: account.login, type: account.type }
}

/** Installation tokens, by installation, each cached for up to 55 minutes (GitHub's last an hour). */
const cached = new Map<string, { token: string; until: number }>()

/** An installation token, cached for up to 55 minutes (GitHub's last an hour). */
export async function installationToken(app: NonNullable<ReturnType<typeof appOf>>, send: Fetch = fetch): Promise<string> {
  const found = cached.get(app.installation)
  if (found && found.until > Date.now()) return found.token
  const jwt = await appJwt(app)
  const response = await send(`https://api.github.com/app/installations/${app.installation}/access_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'bordeaux' },
  })
  if (!response.ok) throw new Error(`GitHub didn't give the App an installation token: ${response.status}`)
  const { token } = (await response.json()) as { token: string }
  cached.set(app.installation, { token, until: Date.now() + 55 * 60_000 })
  return token
}

/** `login`'s membership of `org`, as the App sees it: active with a role, or null for none. */
export async function membershipOf(env: BordeauxEnv, team: Team, org: string, login: string, send: Fetch = fetch): Promise<{ role: string } | null | 'unknown'> {
  const app = appOf(env, team)
  if (!app) return 'unknown'
  const token = await installationToken(app, send)
  const response = await send(`https://api.github.com/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(login)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'bordeaux' },
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub didn't say whether ${login} is in ${org}: ${response.status}`)
  const found = (await response.json()) as { state?: string; role?: string }
  return found.state === 'active' ? { role: found.role ?? 'member' } : null
}
