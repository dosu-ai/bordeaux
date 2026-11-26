import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { BoardEngine } from '../src/engine/engine.ts'
import { boardKey } from '../src/worker/backend.ts'
import { api, tokenFor } from './helpers.ts'

describe('a board on a Durable Object', () => {
  it('posts as the person the token names, and reads the thread back', async () => {
    const token = await tokenFor(583231, 'octocat')
    const posted = await api(token, 'POST', '/messages', { channel: 'deploys', text: 'shipped a1b2c3', labels: { env: 'prod' } })
    expect(posted.status).toBe(201)
    const { message } = posted.body
    expect(message).toMatchObject({ channel: 'deploys', text: 'shipped a1b2c3', labels: { env: 'prod' }, by: { principal: 'bordeaux:user:583231' }, author: { handle: 'octocat', kind: 'person' } })

    const reply = await api(token, 'POST', '/messages', { re: message.id, text: 'rolled back' })
    const thread = await api(token, 'GET', `/messages/${message.id}`)
    expect(thread.body.replies.map((m: { id: string }) => m.id)).toEqual([reply.body.message.id])
  })

  it("refuses a post where the caller's x-board-can doesn't reach, and hides what it can't read", async () => {
    const token = await tokenFor(1, 'ada')
    const { body } = await api(token, 'POST', '/messages', { channel: 'secret', text: 'hush' })
    const narrowed = { 'x-board-can': 'public=read,post' }
    expect((await api(token, 'POST', '/messages', { channel: 'secret', text: 'again' }, narrowed)).status).toBe(403)
    expect((await api(token, 'GET', `/messages/${body.message.id}`, undefined, narrowed)).status).toBe(404)
  })

  it('lands one of several replies racing after the same message', async () => {
    const token = await tokenFor(2, 'grace')
    const root = (await api(token, 'POST', '/messages', { channel: 'races', text: 'root' })).body.message
    const racing = await Promise.all([1, 2, 3].map((n) => api(token, 'POST', '/messages', { re: root.id, text: `racer ${n}`, after: root.id })))
    expect(racing.map((r) => r.status).sort()).toEqual([201, 409, 409])
    expect(racing.filter((r) => r.status === 409).every((r) => r.body.error.code === 'newer_message')).toBe(true)
  })

  it("rebuilds its tables from the log when a write's table update was cut short", async () => {
    const token = await tokenFor(3, 'linus')
    const { message } = (await api(token, 'POST', '/messages', { channel: 'restarts', text: 'before the crash' })).body
    const stub = env.BOARD.get(env.BOARD.idFromName(boardKey('default', null)))
    await runInDurableObject(stub, async (_instance, state) => {
      // As if the DO stopped after the log's transaction and before the tables applied it.
      for (const table of ['board_messages', 'board_versions', 'board_terms']) state.storage.sql.exec(`delete from ${table}`)
      state.storage.sql.exec('update board_positions set log_index = 0')
      const restarted = new BoardEngine(state.storage)
      await restarted.ready
      expect((await restarted.tables.message(Number(message.id)))?.text).toBe('before the crash')
    })
    expect((await api(token, 'GET', `/messages/${message.id}`)).body.message.text).toBe('before the crash')
  })
})
