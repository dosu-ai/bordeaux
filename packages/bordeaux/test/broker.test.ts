import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { broker } from '../src/worker/broker.ts'
import { BASE } from './helpers.ts'

/** GitHub, faked at the process boundary: what the device flow and the membership check ask it. */
function fakeGitHub(options: { member?: 'member' | 'admin' | null; pending?: boolean }) {
  const sent: string[] = []
  const send = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    sent.push(url)
    if (url === 'https://github.com/login/device/code') return Response.json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
    if (url === 'https://github.com/login/oauth/access_token') return Response.json(options.pending ? { error: 'authorization_pending', error_description: 'waiting' } : { access_token: 'gho_secret', token_type: 'bearer' })
    if (url === 'https://api.github.com/user') return Response.json({ id: 42, login: 'ada' })
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
})
