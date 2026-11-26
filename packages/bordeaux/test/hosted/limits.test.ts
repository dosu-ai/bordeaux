import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Limits } from '../../src/worker/limits.ts'
import { registry } from '../../src/worker/registry.ts'
import { teamOfRecord } from '../../src/worker/team.ts'

const HUB = new URL('https://board.test')
let next = 8000

/** A team with limits of its own, as a paid plan's record would have: its URL. */
async function team(login: string, limits: Partial<Limits> = {}): Promise<string> {
  const id = next++
  const { team: record } = await registry(env).register({ id, login, type: 'Organization', installation: id }, HUB.host)
  await registry(env).setLimits(record.id, limits)
  return teamOfRecord(record, HUB).url
}

async function tokenAt(url: string): Promise<string> {
  const response = await SELF.fetch(`${url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: 1, login: 'ada' }) })
  return ((await response.json()) as { access_token: string }).access_token
}

async function call(url: string, token: string, method: string, path: string, body?: unknown) {
  const response = await SELF.fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: (await response.json()) as any }
}

describe("a hosted team's limits", () => {
  it('makes no named board past its limit, but finds one it has', async () => {
    const url = await team('lim-boards', { boards: 1 })
    const token = await tokenAt(url)
    expect((await call(url, token, 'POST', '/admin/boards', { name: 'one' })).status).toBe(201)
    expect((await call(url, token, 'POST', '/admin/boards', { name: 'two' })).body).toMatchObject({ error: { code: 'limit_boards' } })
    expect((await call(url, token, 'POST', '/admin/boards', { name: 'one' })).status).toBe(200)
  })

  it('refuses writes once its boards hold more than its data limit, and still reads', async () => {
    const url = await team('lim-data', { dataBytes: 1 })
    const token = await tokenAt(url)
    const first = await call(url, token, 'POST', '/messages', { channel: 'general', text: 'the first write reports what the board holds' })
    expect(first.status).toBe(201)
    const second = await call(url, token, 'POST', '/messages', { channel: 'general', text: 'over' })
    expect(second.status).toBe(413)
    expect(second.body).toMatchObject({ error: { code: 'limit_data' } })
    expect((await call(url, token, 'GET', '/messages?channel=general')).body.messages).toHaveLength(1)
    expect((await call(url, token, 'POST', `/messages/${first.body.message.id}/delete`, {})).status).toBe(200)
  })

  it('refuses a file that would put it over its file limit', async () => {
    const url = await team('lim-files', { fileBytes: 10 })
    const token = await tokenAt(url)
    expect((await call(url, token, 'POST', '/attachments/uploads', { name: 'a.txt', type: 'text/plain', size: 8 })).status).toBe(200)
    const over = await call(url, token, 'POST', '/attachments/uploads', { name: 'b.txt', type: 'text/plain', size: 3 })
    expect(over.status).toBe(413)
    expect(over.body).toMatchObject({ error: { code: 'limit_files' } })
  })

  it('holds no more registered watchers on a board than its limit', async () => {
    const url = await team('lim-watchers', { watchers: 2 })
    const token = await tokenAt(url)
    const three = await call(url, token, 'POST', '/watchers', { watch: { a: { tail: 'a' }, b: { tail: 'b' }, c: { tail: 'c' } } })
    expect(three.body).toMatchObject({ error: { code: 'limit_watchers' } })
    expect((await call(url, token, 'POST', '/watchers', { watch: { a: { tail: 'a' }, b: { tail: 'b' } } })).status).toBe(200)
  })

  it('answers 429 with retry-after past its requests a minute', async () => {
    const url = await team('lim-requests')
    const answers = []
    for (let n = 0; n < 101; n++) answers.push(await SELF.fetch(`${url}/`))
    expect(answers.slice(0, 100).every((answer) => answer.status !== 429)).toBe(true)
    expect(answers[100]!.status).toBe(429)
    expect(answers[100]!.headers.get('retry-after')).toBe('60')
  })
})
