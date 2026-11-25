import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../src/worker/backend.ts'
import { api, tokenFor } from './helpers.ts'

// A reader of every channel, as the Worker sends one to the board's DO.
const actor = { id: 'bordeaux:user:170', kind: 'person', handle: 'tails', name: 'tails', avatar: null }
const wire = { principal: { id: actor.id, kind: 'person', handle: 'tails', can: { '*': ['read'] } }, author: { id: actor.id, handle: 'tails', name: 'tails', avatar: null, profile: null }, actor, request: true }

describe('the feed under load', () => {
  it('keeps answering after more long-polls than workerd lets timers pile up (10,000)', { timeout: 120_000 }, async () => {
    const token = await tokenFor(170, 'tails')
    const { cursor } = (await api(token, 'GET', '/events')).body
    await api(token, 'POST', '/messages', { channel: 'feed-load', text: 'there is always something to read' })
    const board = env.BOARD.get(env.BOARD.idFromName(boardKey(null)))
    // Each answers at once, with what's there: a timer it started and didn't clear outlives it.
    for (let done = 0; done < 10_200; done += 200) {
      const answers = await Promise.all(Array.from({ length: 200 }, () => board.call('events', wire as never, { after: cursor, wait: 30 }, null)))
      expect(answers.filter((answer) => !answer.ok)).toEqual([])
    }
  })
})
