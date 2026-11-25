import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../src/worker/backend.ts'
import { api, tokenFor } from './helpers.ts'

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("a deployment's own watchers", () => {
  it('run on the board when their tail matches, and their own writes never wake them again', async () => {
    const token = await tokenFor(90, 'oncall')
    const { message } = (await api(token, 'POST', '/messages', { channel: 'ops', text: 'db down' })).body
    let replies: { text: string; by: { actor: string } }[] = []
    for (const deadline = Date.now() + 5000; Date.now() < deadline && replies.length === 0; ) {
      await runDurableObjectAlarm(env.BOARD.get(env.BOARD.idFromName(boardKey(null))))
      replies = (await api(token, 'GET', `/messages/${message.id}`)).body.replies
      if (replies.length === 0) await later(100)
    }
    expect(replies).toMatchObject([{ text: `paged on ${message.id}`, by: { actor: 'board:watch:pager' } }])
    await runDurableObjectAlarm(env.BOARD.get(env.BOARD.idFromName(boardKey(null))))
    expect((await api(token, 'GET', `/messages/${message.id}`)).body.replies).toHaveLength(1)
  })
})
