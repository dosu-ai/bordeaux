import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../src/worker/backend.ts'
import { platform } from './config.ts'
import { api, BASE, tokenFor } from './helpers.ts'

const board = () => env.BOARD.get(env.BOARD.idFromName(boardKey('default', null)))
/** Runs the board's own work until `done` holds, as its alarm would. */
async function until<T>(done: () => Promise<T | undefined | null | false>): Promise<T> {
  for (const deadline = Date.now() + 4000; Date.now() < deadline; ) {
    await runDurableObjectAlarm(board())
    const found = await done()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('timed out')
}

describe("a deployment's own sync", () => {
  it('brings a platform thread onto the board, and sends a board reply back to it', async () => {
    const token = await tokenFor(95, 'helper')
    const webhook = await SELF.fetch(`${BASE}/webhooks/chat`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'chat:C1:100', id: '100', text: 'the printer is on fire', user: 'U2', name: 'Ana' }) })
    expect(webhook.status).toBe(200)

    const root = await until(async () => (await api(token, 'GET', '/messages?channel=support')).body.messages?.find((m: { text: string }) => m.text === 'the printer is on fire'))
    expect(root).toMatchObject({ from: 'chat', author: { name: 'Ana', kind: 'external' } })

    await api(token, 'POST', '/messages', { re: root.id, text: 'putting it out' })
    const sent = await until(async () => platform.posts.find((post) => post.text.includes('putting it out')))
    expect(sent.threadId).toBe('chat:C1:100')
  })
})
