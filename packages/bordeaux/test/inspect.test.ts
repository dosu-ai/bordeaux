import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { api, BASE, tokenFor } from './helpers.ts'

/** The cookies a response sets, as a browser would send them back. */
const jar = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((set) => set.split(';')[0])
    .join('; ')

const page = (cookie: string, path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, { redirect: 'manual', ...init, headers: { cookie, 'x-inspect-token': 'page', 'sec-fetch-site': 'same-origin', ...init.headers } })

describe('the hosted inspector', () => {
  it('signs a person in, serves upstream’s page, and proxies the board as them', async () => {
    const away = await SELF.fetch(`${BASE}/inspect/`, { redirect: 'manual' })
    expect(away.status).toBe(302)
    expect(away.headers.get('location')).toBe(`${BASE}/inspect/login`)

    // A local board with no GitHub App signs in as a made-up person.
    const login = await SELF.fetch(`${BASE}/inspect/login?id=97&login=ines`, { redirect: 'manual' })
    expect(login.status).toBe(302)
    expect(login.headers.getSetCookie().every((set) => set.includes('Path=/inspect') && set.includes('HttpOnly'))).toBe(true)
    const cookie = jar(login)

    const html = await SELF.fetch(`${BASE}/inspect/`, { headers: { cookie } })
    expect(html.status).toBe(200)
    expect(html.headers.get('content-security-policy')).toContain("script-src 'self'")
    const shell = await html.text()
    expect(shell).toContain('<meta name="inspect-base" content="/inspect">')
    expect(shell).not.toContain('inspect-named')

    const app = await SELF.fetch(`${BASE}/inspect/app.js?v=0.57.0`)
    expect(app.status).toBe(200)
    expect(app.headers.get('content-type')).toContain('javascript')
    expect((await app.text()).length).toBeGreaterThan(100_000)

    const me = await page(cookie, '/inspect/board/me')
    expect(await me.json()).toMatchObject({ principal: 'bordeaux:user:97', handle: 'ines' })
    const posted = await page(cookie, '/inspect/board/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({ channel: 'inspected', text: 'from the page' }),
    })
    expect(posted.status).toBe(201)
    expect(((await posted.json()) as any).message.by.principal).toBe('bordeaux:user:97')
  })

  it("answers only its own page, and only someone signed in", async () => {
    const cookie = jar(await SELF.fetch(`${BASE}/inspect/login?id=98`, { redirect: 'manual' }))
    expect((await page(cookie, '/inspect/board/me', { headers: { 'x-inspect-token': 'other' } })).status).toBe(403)
    expect((await page(cookie, '/inspect/board/me', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    // A write must carry this origin.
    const write = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'x', text: 'no' }) }
    expect((await page(cookie, '/inspect/board/messages', write)).status).toBe(403)
    expect((await page(cookie, '/inspect/board/../admin/boards')).status).not.toBe(200)
    expect((await page('', '/inspect/board/me')).status).toBe(401)
    // Signing out is a POST from this page: a link or another site can't do it.
    const shown = await SELF.fetch(`${BASE}/inspect/logout`, { headers: { cookie } })
    expect(shown.headers.getSetCookie()).toEqual([])
    expect(await shown.text()).toContain('<form method="post">')
    expect((await SELF.fetch(`${BASE}/inspect/logout`, { method: 'POST', headers: { cookie, origin: 'https://elsewhere.test' } })).status).toBe(403)
    const out = await SELF.fetch(`${BASE}/inspect/logout`, { method: 'POST', headers: { cookie, origin: BASE } })
    expect(out.headers.getSetCookie().every((set) => set.includes('Max-Age=0'))).toBe(true)
  })

  it('serves a named board at /b/<name>/inspect, with tokens made out to that board', async () => {
    await api(await tokenFor(99, 'olu'), 'POST', '/admin/boards', { name: 'eng' })
    const login = await SELF.fetch(`${BASE}/b/eng/inspect/login?id=99&login=olu`, { redirect: 'manual' })
    expect(login.headers.getSetCookie()[0]).toContain('Path=/b/eng/inspect')
    const cookie = jar(login)
    expect(await (await page(cookie, '/b/eng/inspect/board/')).json()).toMatchObject({ url: `${BASE}/b/eng` })
    expect((await page(cookie, '/b/eng/inspect/board/me')).status).toBe(200)
    // One path per board, as its cookies are.
    const mixed = await SELF.fetch(`${BASE}/b/Eng/inspect/`, { redirect: 'manual' })
    expect(mixed.status).toBe(301)
    expect(mixed.headers.get('location')).toBe(`${BASE}/b/eng/inspect/`)
  })
})
