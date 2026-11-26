import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../../src/worker/backend.ts'
import { limitsOf, type Limits } from '../../src/worker/limits.ts'
import { registry } from '../../src/worker/registry.ts'
import { forgetHost, teamOfRecord } from '../../src/worker/team.ts'

const HUB = new URL('https://board.test')
let next = 8000

/** A team with limits of its own, as a paid plan's record would have: its URL. */
async function team(login: string, limits: Partial<Limits> = {}): Promise<string> {
  const id = next++
  const { team: record } = await registry(env).register({ id, login, type: 'Organization', installation: id }, HUB.host)
  await registry(env).setLimits(record.id, limits)
  return teamOfRecord(record, HUB).url
}

/** Changes a team's limits, as an operator would, and drops what this isolate kept of it. */
async function relimit(url: string, limits: Partial<Limits>) {
  const record = (await registry(env).byHost(new URL(url).host))!
  await registry(env).setLimits(record.id, limits)
  forgetHost(new URL(url).host)
  return record
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
    const url = await team('lim-data')
    const token = await tokenAt(url)
    const first = await call(url, token, 'POST', '/messages', { channel: 'general', text: 'the first write reports what the board holds' })
    expect(first.status).toBe(201)
    // Lowered on its record after the board was served: the board's DO is sent the new limit.
    await relimit(url, { dataBytes: 1 })
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

  it('checks the first write a board gets against what the team holds already', async () => {
    const url = await team('lim-first', { dataBytes: 1 })
    const token = await tokenAt(url)
    expect((await call(url, token, 'POST', '/messages', { channel: 'general', text: 'over from the start' })).body).toMatchObject({ error: { code: 'limit_data' } })
  })

  it('takes an empty limit var as unset, not as a limit of 0', () => {
    expect(limitsOf({ ...env, BORDEAUX_LIMIT_BOARDS: '' }).boards).toBe(20)
    expect(limitsOf({ ...env, BORDEAUX_LIMIT_BOARDS: '7' }).boards).toBe(7)
  })

  it('holds a wake past its wakes a minute, and sends it later', async () => {
    const url = await team('lim-wakes')
    const token = await tokenAt(url)
    const record = (await registry(env).byHost(new URL(url).host))!
    expect((await call(url, token, 'POST', '/watchers', { watch: { all: { tail: 'wakes' } }, url: 'https://agent.test/hook' })).status).toBe(200)
    // The limiter counts in whole minutes: start well inside one, so it doesn't reset mid-test.
    const left = 60_000 - (Date.now() % 60_000)
    if (left < 3_000) await new Promise((resolve) => setTimeout(resolve, left + 100))
    // The team has used its 60 wakes this minute.
    for (let n = 0; n < 60; n++) await env.WAKE_LIMITER!.limit({ key: record.id })
    await call(url, token, 'POST', '/messages', { channel: 'wakes', text: 'wake me' })
    const board = env.BOARD.get(env.BOARD.idFromName(boardKey(record.id, null)))
    // The board's own alarm may be running the wake already: wait for it to be put off.
    let wakes: { due_at: number; attempt: number }[] = []
    for (const until = Date.now() + 2_000; Date.now() < until && !(wakes[0] && wakes[0].due_at > Date.now() + 5_000); ) {
      await runDurableObjectAlarm(board)
      wakes = await runInDurableObject(board, async (_, state) => state.storage.sql.exec<{ due_at: number; attempt: number }>("select due_at, attempt from bx_timers where kind = 'wake'").toArray())
    }
    expect(wakes).toHaveLength(1)
    expect(wakes[0]!.due_at).toBeGreaterThan(Date.now() + 5_000)
    expect(wakes[0]!.attempt).toBe(1)
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
