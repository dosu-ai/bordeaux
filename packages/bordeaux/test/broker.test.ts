import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { broker, RECHECK_MS } from '../src/worker/broker.ts'
import { directory } from '../src/worker/auth.ts'
import { BASE } from './helpers.ts'

/** GitHub, faked at the process boundary: what the device flow and the membership check ask it. */
function fakeGitHub(options: { member?: 'member' | 'admin' | null; pending?: boolean; stillMember?: 'member' | 'admin' | null }) {
  const sent: string[] = []
  const send = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    sent.push(url)
    if (url === 'https://github.com/login/device/code') return Response.json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    if (url === 'https://github.com/login/oauth/access_token') return Response.json(options.pending ? { error: 'authorization_pending', error_description: 'waiting' } : { access_token: 'gho_secret', token_type: 'bearer' })
    if (url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'ada' })
    if (url === 'https://api.github.com/app/installations/7/access_tokens') return Response.json({ token: 'ghs_app' })
    if (url === 'https://api.github.com/orgs/acme/memberships/ada')
      return options.stillMember ? Response.json({ state: 'active', role: options.stillMember }) : Response.json({ message: 'Not Found' }, { status: 404 })
    if (url === 'https://api.github.com/user/memberships/orgs/acme')
      return options.member ? Response.json({ state: 'active', role: options.member }) : Response.json({ message: 'Not Found' }, { status: 404 })
    return new Response('unexpected', { status: 500 })
  }) as typeof fetch
  return { send, sent }
}

const post = (path: string, body: unknown, send: typeof fetch) =>
  broker(new Request(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body) }), env, send)

const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'

describe('the token broker', () => {
  it("signs in a member of the board's org, as their GitHub user ID, and only talks to GitHub", async () => {
    const github = fakeGitHub({ member: 'member' })
    const started = await (await post('/auth/device', {}, github.send)).json()
    expect(started).toMatchObject({ user_code: 'ABCD-1234' })
    const issued = (await (await post('/auth/token', { grant_type: DEVICE, device_code: 'dc' }, github.send)).json()) as { access_token: string; refresh_token: string }
    const me = await (await SELF.fetch(`${BASE}/me`, { headers: { authorization: `Bearer ${issued.access_token}` } })).json()
    expect(me).toMatchObject({ principal: 'bordeaux:user:42', handle: 'ada', kind: 'person' })
    expect(github.sent.every((url) => url.startsWith('https://github.com/') || url.startsWith('https://api.github.com/'))).toBe(true)
    expect(JSON.stringify(issued)).not.toContain('gho_secret')
  })

  it("refuses someone who isn't a member of the org", async () => {
    const response = await post('/auth/token', { grant_type: DEVICE, device_code: 'dc' }, fakeGitHub({ member: null }).send)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'access_denied' })
  })

  it('passes on that GitHub is still waiting for the person', async () => {
    const response = await post('/auth/token', { grant_type: DEVICE, device_code: 'dc' }, fakeGitHub({ pending: true }).send)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'authorization_pending' })
  })

  it('renews a sign-in once per refresh token', async () => {
    const github = fakeGitHub({ member: 'admin' })
    const first = (await (await post('/auth/token', { grant_type: DEVICE, device_code: 'dc' }, github.send)).json()) as { refresh_token: string }
    const renewed = await post('/auth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token }, github.send)
    expect(renewed.status).toBe(200)
    const again = await post('/auth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token }, github.send)
    expect(again.status).toBe(401)
  })

  describe('renewing a sign-in whose last membership check is over 12 hours old', () => {
    /** An RSA key in PKCS#1, as GitHub hands out an App's. */
    async function appKey(): Promise<string> {
      const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
      const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
      // PKCS#8 wraps PKCS#1 after a fixed 26-byte header for a 2048-bit RSA key.
      const pkcs1 = pkcs8.slice(26)
      return `-----BEGIN RSA PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs1))}\n-----END RSA PRIVATE KEY-----`
    }
    const stale = () => directory(env).startSession({ id: '42', login: 'ada', owner: false, checkedAt: Date.now() - RECHECK_MS - 1000, expiresAt: Date.now() + 3_600_000 })
    const refresh = async (token: string, appEnv: typeof env, send: typeof fetch) =>
      broker(new Request(`${BASE}/auth/token`, { method: 'POST', body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: token }) }), appEnv, send)

    it('asks GitHub through the App, and renews a member, as an owner when they became one', async () => {
      const appEnv = { ...env, GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '7', GITHUB_PRIVATE_KEY: await appKey() }
      const github = fakeGitHub({ stillMember: 'admin' })
      const response = await refresh(await stale(), appEnv, github.send)
      expect(response.status).toBe(200)
      expect(github.sent).toContain('https://api.github.com/orgs/acme/memberships/ada')
    })

    it('ends the sign-in of someone who left the org', async () => {
      const appEnv = { ...env, GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '7', GITHUB_PRIVATE_KEY: await appKey() }
      const response = await refresh(await stale(), appEnv, fakeGitHub({ stillMember: null }).send)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: 'access_denied' })
    })

    it('asks the person to sign in again on a board with no App to check with', async () => {
      const response = await refresh(await stale(), env, fakeGitHub({}).send)
      expect(response.status).toBe(401)
    })
  })
})
