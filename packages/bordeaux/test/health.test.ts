import { env, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { linearSync, teams } from '../src/sync/index.ts'
import { checkSync } from '../src/worker/health.ts'
import { api, BASE, tokenFor } from './helpers.ts'

const health = async (token: string, query = '', headers: Record<string, string> = {}) => {
  const response = await SELF.fetch(`${BASE}/admin/health${query}`, { headers: { authorization: `Bearer ${token}`, ...headers } })
  return { status: response.status, body: (await response.json()) as any }
}

afterEach(() => vi.restoreAllMocks())

describe('health', () => {
  it("shows an owner each queue with work, what the queues gave up on, and that each sync reaches its platform", async () => {
    const owner = await tokenFor(1, 'owner')
    const token = await tokenFor(140, 'puller')
    await api(token, 'POST', '/watchers', { watch: { all: { tail: 'health' } } })
    await api(owner, 'POST', '/messages', { channel: 'health', text: 'waiting' })
    const { status, body } = await health(owner)
    expect(status).toBe(200)
    expect(body.board).toBeNull()
    expect(body.queues).toContainEqual({ owner: 'bordeaux:user:140', pending: 1, leased: 0, retrying: 0 })
    expect(body.dead).toMatchObject({ count: expect.any(Number) })
    expect(body.timers).toMatchObject({ late: 0 })
    expect(body.sync).toContainEqual({ key: 'slack', platform: 'slack', ok: true })
  })

  it("is for someone who manages every channel", async () => {
    expect((await health(await tokenFor(141, 'someone'), '', { 'x-board-can': 'ops=read' })).status).toBe(403)
  })

  it("answers 404 for a board the team doesn't have", async () => {
    expect((await health(await tokenFor(1, 'owner'), '?board=nowhere')).body.error.code).toBe('no_board')
  })

  it("signs a Linear app in, which is what turns on Linear's webhooks for it", async () => {
    const asked: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      asked.push(`${url.host}${url.pathname}`)
      if (url.pathname === '/oauth/token') return Response.json({ access_token: 'test-only', expires_in: 86400 * 30 })
      return Response.json({ data: { viewer: { id: 'app-user', displayName: 'Board', organization: { id: 'org' } } } })
    })
    // Test values: no Linear app has these.
    const linear = linearSync({ LINEAR_CLIENT_ID: 'test-id', LINEAR_CLIENT_SECRET: 'test-only', LINEAR_WEBHOOK_SECRET: 'test-only' } as never, teams({ ENG: 'eng' }))
    expect(await checkSync(env as never, { linear })).toEqual([{ key: 'linear', platform: 'linear', ok: true }])
    expect(asked).toContain('api.linear.app/oauth/token')
  })

  it("says which sync can't reach its platform, and why", async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'invalid_client' }, { status: 401 }))
    const linear = linearSync({ LINEAR_CLIENT_ID: 'test-id', LINEAR_CLIENT_SECRET: 'wrong', LINEAR_WEBHOOK_SECRET: 'test-only' } as never, teams({ ENG: 'eng' }))
    const [found] = await checkSync(env as never, { linear })
    expect(found).toMatchObject({ key: 'linear', ok: false, error: expect.stringContaining('Linear') })
  })
})

describe('doctor', () => {
  it("says which bindings a deployment has, and that its dev token route is on, to someone who manages it", async () => {
    const owner = await tokenFor(1, 'owner')
    const found = await SELF.fetch(`${BASE}/admin/doctor`, { headers: { authorization: `Bearer ${owner}` } })
    expect(await found.json()).toMatchObject({ url: BASE, dev: true, bindings: { board: true, directory: true, tail: true, files: true } })
    const narrowed = await SELF.fetch(`${BASE}/admin/doctor`, { headers: { authorization: `Bearer ${owner}`, 'x-board-can': 'ops=read' } })
    expect(narrowed.status).toBe(403)
  })
})
