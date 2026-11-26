import { createExecutionContext, env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../../src/worker/index.ts'
import { directory } from '../../src/worker/auth.ts'
import { broker } from '../../src/worker/broker.ts'
import { registry } from '../../src/worker/registry.ts'
import { teamOfRecord } from '../../src/worker/team.ts'

const HUB = new URL('https://board.test')

/** A team, as `POST /__dev/team` makes one: its URL. */
async function team(login: string, type: 'Organization' | 'User' = 'Organization', id?: number): Promise<string> {
  const response = await SELF.fetch(`${HUB.origin}/__dev/team`, { method: 'POST', body: JSON.stringify({ login, type, ...(id ? { id } : {}) }) })
  return ((await response.json()) as { url: string }).url
}

async function tokenAt(url: string, id: number, login: string, audience?: string): Promise<string> {
  const response = await SELF.fetch(`${url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id, login, ...(audience ? { audience } : {}) }) })
  return ((await response.json()) as { access_token: string }).access_token
}

async function call(url: string, token: string, method: string, path: string, body?: unknown) {
  const response = await SELF.fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: (await response.json()) as any }
}

describe('hosted teams', () => {
  it('answers 404 no_team at a host with no team', async () => {
    const response = await SELF.fetch('https://nobody.board.test/channels')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'no_team' } })
  })

  it('serves no board at the hub', async () => {
    expect((await SELF.fetch(`${HUB.origin}/channels`)).status).toBe(404)
  })

  it('puts each team at its own subdomain, with its own URL', async () => {
    const url = await team('acme-url')
    expect(url).toBe('https://acme-url.board.test')
    const token = await tokenAt(url, 1, 'ada')
    expect((await call(url, token, 'GET', '/')).body).toMatchObject({ url })
  })

  it("refuses one team's token at another, on its issuer and on its audience", async () => {
    const [a, b] = [await team('acme-tokens'), await team('beta-tokens')]
    const token = await tokenAt(a, 1, 'ada')
    expect((await call(a, token, 'GET', '/channels')).status).toBe(200)
    expect((await call(b, token, 'GET', '/channels')).status).toBe(401)
    // Signed by a's issuer but made out to b, as b's own: b's keys don't verify it.
    const record = (await registry(env).byHost(new URL(a).host))!
    const forged = await directory(env, teamOfRecord(record, HUB)).mint({ sub: 'user:1', login: 'ada' }, 3600, b, b)
    expect((await call(b, forged.token, 'GET', '/channels')).body).toMatchObject({ error: { code: 'invalid_token' } })
  })

  it("keeps each team's boards and directories apart", async () => {
    const [a, b] = [await team('acme-apart'), await team('beta-apart')]
    const [ta, tb] = [await tokenAt(a, 1, 'ada'), await tokenAt(b, 2, 'bob')]
    expect((await call(a, ta, 'POST', '/messages', { channel: 'acme-only', text: 'hello from acme' })).status).toBe(201)
    expect((await call(a, ta, 'GET', '/messages?channel=acme-only')).body.messages).toHaveLength(1)
    expect((await call(b, tb, 'GET', '/channels')).body.channels.map((found: { name: string }) => found.name)).not.toContain('acme-only')
    expect((await call(b, tb, 'GET', '/messages?channel=acme-only')).body.messages ?? []).toEqual([])
    expect((await call(a, ta, 'POST', '/admin/boards', { name: 'ops' })).status).toBe(201)
    expect((await call(a, await tokenAt(a, 1, 'ada', `${a}/b/ops`), 'GET', '/b/ops/channels')).status).toBe(200)
    expect((await call(b, tb, 'GET', '/b/ops/channels')).body).toMatchObject({ error: { code: 'no_board' } })
  })

  it("refuses a suspended team's boards, and an uninstalled one's with how to come back", async () => {
    const paused = await team('paused', 'Organization', 501)
    const gone = await team('gone', 'Organization', 502)
    await registry(env).setState(501, 'suspended')
    await registry(env).setState(502, 'uninstalled')
    expect(await (await SELF.fetch(`${paused}/channels`)).json()).toMatchObject({ error: { code: 'team_suspended' } })
    const uninstalled = await SELF.fetch(`${gone}/channels`)
    expect(uninstalled.status).toBe(403)
    expect(await uninstalled.json()).toMatchObject({ error: { code: 'team_uninstalled', message: expect.stringContaining('install it on gone again by') } })
  })

  it('refuses to serve with a self-hosted setting that would fall back to the operator', async () => {
    const response = await worker.fetch(new Request('https://acme-url.board.test/channels'), { ...env, BORDEAUX_GITHUB_ORG: 'dosu-ai' }, createExecutionContext())
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: { code: 'misconfigured', message: expect.stringContaining('BORDEAUX_GITHUB_ORG') } })
  })
})

describe('the registry', () => {
  const link = (id: number, login: string, installation = id) => ({ id, login, type: 'Organization' as const, installation })

  it('makes one team per installation, whichever asks first', async () => {
    const first = await registry(env).register(link(601, 'once'), HUB.host)
    const again = await registry(env).register(link(601, 'once'), HUB.host)
    expect(first.created).toBe(true)
    expect(again).toEqual({ team: first.team, created: false })
    expect(first.team.id).toMatch(/^t_[a-z2-7]{26}$/)
  })

  it('restores a team installed again on the same account, host and all', async () => {
    const { team: before } = await registry(env).register(link(602, 'back', 7001), HUB.host)
    await registry(env).setState(7001, 'uninstalled')
    const { team: after, created } = await registry(env).register(link(602, 'back', 7002), HUB.host)
    expect(created).toBe(false)
    expect(after).toMatchObject({ id: before.id, host: before.host, state: 'active', github: { installation: 7002 } })
  })

  it('gives a reserved login its account ID', async () => {
    expect((await registry(env).register(link(603, 'WWW'), HUB.host)).team.host).toBe('www-603.board.test')
  })
})

describe('personal teams', () => {
  /** GitHub, saying who signed in with the device flow. */
  const github = (who: { id: number; login: string }) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'gho_test', token_type: 'bearer' })
      if (url === 'https://api.github.com/user') return Response.json(who)
      return new Response('unexpected', { status: 500 })
    }) as typeof fetch

  const signIn = async (who: { id: number; login: string }) => {
    const { team: record } = await registry(env).register({ id: 701, login: 'ada', type: 'User', installation: 701 }, HUB.host)
    const team = teamOfRecord(record, HUB)
    const request = new Request(`${team.url}/auth/token`, { method: 'POST', body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dc' }) })
    return broker(request, env, team, github(who))
  }

  it('signs in its one person, as its owner', async () => {
    const response = await signIn({ id: 701, login: 'ada' })
    expect(response.status).toBe(200)
    const { access_token } = (await response.json()) as { access_token: string }
    expect(JSON.parse(atob(access_token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/')))).toMatchObject({ sub: 'user:701', owner: true })
  })

  it('refuses anyone else', async () => {
    const response = await signIn({ id: 702, login: 'bob' })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'access_denied' })
  })
})
