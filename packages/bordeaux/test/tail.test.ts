import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../src/worker/backend.ts'
import { api, BASE, tokenFor } from './helpers.ts'

// A long-poll that waits (`wait > 0`) is answered by the board's TailDO; one that doesn't, by the
// board's own DO. Each pair below asks both for the same feed and expects the same answer.

const head = async (token: string, query = '') => (await api(token, 'GET', `/events?${query}`)).body.cursor as string
const ids = (events: { cursor: string; type: string }[]) => events.map((event) => `${event.type}@${event.cursor}`)

/** The same page, from the board (no wait) and from the TailDO (a wait that ends at once, since there's something there). */
async function bothWays(token: string, query: string, headers: Record<string, string> = {}) {
  const board = (await api(token, 'GET', `/events?${query}`, undefined, headers)).body
  const tail = (await api(token, 'GET', `/events?${query}&wait=5`, undefined, headers)).body
  return { board, tail }
}

describe("a board's TailDO", () => {
  it("shows a waiting reader the events the board's own feed would, and nothing it can't read", async () => {
    const author = await tokenFor(180, 'poster')
    const narrowed = { 'x-board-can': 'tail-b=read' }
    const after = await head(author)
    await api(author, 'POST', '/messages', { channel: 'tail-a', text: 'in a' })
    await api(author, 'POST', '/messages', { channel: 'tail-b', text: 'in b' })

    const everything = await bothWays(author, `after=${after}`)
    expect(everything.tail).toEqual(everything.board)
    // The wait was the TailDO's: it follows the board, to where the board's feed ends.
    const followed = await runInDurableObject(env.TAIL!.get(env.TAIL!.idFromName(boardKey(null))), async (instance) => (instance as any).at?.index)
    expect(String(followed)).toBe(everything.board.cursor)
    expect(everything.tail.events.map((event: { message: { text: string } }) => event.message.text)).toEqual(['in a', 'in b'])

    const onlyB = await bothWays(author, `after=${after}`, narrowed)
    expect(onlyB.tail).toEqual(onlyB.board)
    expect(onlyB.tail.events.map((event: { message: { channel: string } }) => event.message.channel)).toEqual(['tail-b'])
  })

  it('shows a label change to a reader filtering on it as the message comes in and leaves its view', async () => {
    const author = await tokenFor(181, 'labeler')
    const after = await head(author)
    const { message } = (await api(author, 'POST', '/messages', { channel: 'tail-labels', text: 'triage me' })).body
    await api(author, 'POST', `/messages/${message.id}/labels`, { set: { state: 'open' } })
    await api(author, 'POST', `/messages/${message.id}/labels`, { set: { state: 'done' } })
    const { board, tail } = await bothWays(author, `after=${after}&label=state%3Dopen`)
    expect(tail).toEqual(board)
    expect(ids(tail.events)).toHaveLength(2)
  })

  it('wakes a waiting reader with the next post, once, from a cursor the board gave it', async () => {
    const author = await tokenFor(182, 'waiter')
    // An SSE stream's first page comes from the board: the TailDO may not have followed that far yet.
    await api(author, 'POST', '/messages', { channel: 'tail-wake', text: 'before' })
    const cursor = await head(author, 'channel=tail-wake')
    const waiting = api(author, 'GET', `/events?channel=tail-wake&after=${cursor}&wait=10`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await api(author, 'POST', '/messages', { channel: 'tail-wake', text: 'after' })
    const { events } = (await waiting).body
    expect(events.map((event: { message: { text: string } }) => event.message.text)).toEqual(['after'])
  })

  it('streams over SSE through the TailDO', async () => {
    const author = await tokenFor(183, 'streamer')
    const controller = new AbortController()
    const response = await SELF.fetch(`${BASE}/events?channel=tail-sse`, { headers: { authorization: `Bearer ${author}`, accept: 'text/event-stream' }, signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    await new Promise((resolve) => setTimeout(resolve, 200))
    await api(author, 'POST', '/messages', { channel: 'tail-sse', text: 'streamed' })
    let text = ''
    while (!text.includes('streamed')) text += decoder.decode((await reader.read()).value)
    expect(text).toContain('event: board')
    controller.abort()
  })
})
