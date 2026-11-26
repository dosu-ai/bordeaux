import { createExecutionContext, env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../../src/worker/index.ts'

const HUB = 'https://board.test'
/** A hosted deployment with the App's client secret, so its inspector signs in with GitHub's web flow. */
const web = { ...env, GITHUB_CLIENT_SECRET: 'test-only' }
const send = (url: string, headers: Record<string, string> = {}) => worker.fetch(new Request(url, { headers }), web, createExecutionContext())

describe("a hosted team's inspector", () => {
  it("signs in through the hub's one callback, which sends the code on to the team's own", async () => {
    const made = await SELF.fetch(`${HUB}/__dev/team`, { method: 'POST', body: JSON.stringify({ login: 'web-signin' }) })
    const board = ((await made.json()) as { url: string }).url

    const login = await send(`${board}/inspect/login`)
    expect(login.status).toBe(302)
    const authorize = new URL(login.headers.get('location')!)
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${HUB}/inspect/callback`)
    const state = authorize.searchParams.get('state')!
    expect(state).toMatch(/^web-signin\.board\.test\.[0-9a-f]{32}$/)
    const cookie = login.headers.getSetCookie().map((set) => set.split(';')[0]).join('; ')

    const atHub = await send(`${HUB}/inspect/callback?code=c1&state=${state}`)
    expect(atHub.status).toBe(302)
    expect(atHub.headers.get('location')).toBe(`${board}/inspect/callback?code=c1&state=${state}`)

    const back = await send(atHub.headers.get('location')!, { cookie })
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('/inspect/')
    expect(back.headers.getSetCookie().some((set) => set.startsWith('bx_inspect=ey'))).toBe(true)
  })

  it("sends a code on only to a team's host", async () => {
    const response = await send(`${HUB}/inspect/callback?code=c2&state=evil.example.com.0123456789abcdef0123456789abcdef`)
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it("refuses a code at a team's callback without the state its cookie holds", async () => {
    const made = await SELF.fetch(`${HUB}/__dev/team`, { method: 'POST', body: JSON.stringify({ login: 'web-nostate' }) })
    const board = ((await made.json()) as { url: string }).url
    const response = await send(`${board}/inspect/callback?code=c3&state=web-nostate.board.test.0123456789abcdef0123456789abcdef`)
    expect(response.status).toBe(400)
  })
})
