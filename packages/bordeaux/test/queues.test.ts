import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { MATCH_TRIES, nextDue, type QueueState } from '../src/engine/watchers.ts'
import { boardKey } from '../src/worker/backend.ts'
import { api, BASE, tokenFor } from './helpers.ts'

const board = () => env.BOARD.get(env.BOARD.idFromName(boardKey('default', null)))
const sync = [{ key: 'acme-slack', platform: 'slack' }]
const author = { id: 'acme-slack:user:U9', handle: 'kim', name: 'Kim', avatar: null, isBot: false }
const reaction = (thread: string) => ({ kind: 'reaction', channel: 'acme-slack:C9', thread: `acme-slack:C9:${thread}`, subthread: null, message: thread, context: null, emoji: 'eyes', added: true, author })

/** Lets every item in `owner`'s queue run again now, as if its retry had come: what time would do. */
async function skipRetries(owner: string) {
  await runInDurableObject(board(), async (_instance, state) => {
    const [row] = state.storage.sql.exec<{ data: string }>('select data from bx_queues where owner = ?', owner).toArray()
    const queue = JSON.parse(row!.data) as QueueState
    for (const item of Object.values(queue.pending)) item.retryAt = null
    state.storage.sql.exec('update bx_queues set data = ? where owner = ?', JSON.stringify(queue), owner)
  })
}

describe('matching', () => {
  it("never fails a write that landed, and one event it can't match doesn't hold up the rest", async () => {
    const token = await tokenFor(130, 'mae')
    // A registration whose access can't be compiled: matching any event throws.
    await runInDurableObject(board(), async (instance) => {
      ;(instance as any).engine.registry.byOwner.broken = { owner: 'broken', url: null, watch: {}, sync: [{ key: 'x', platform: 'x' }], hash: '', principal: { id: 'broken', kind: 'person', handle: 'broken' }, can: null }
    })
    try {
      expect((await api(token, 'POST', '/messages', { channel: 'matching', text: 'first' })).status).toBe(201)
      expect((await api(token, 'POST', '/messages', { channel: 'matching', text: 'second' })).status).toBe(201)
      expect((await board().ownFailures()).some((failure) => failure.queue === '(matching)')).toBe(true)
    } finally {
      await runInDurableObject(board(), async (instance) => {
        delete (instance as any).engine.registry.byOwner.broken
      })
    }
  })

  it("comes back for a lane's head when its retry is due, not for what waits behind it", () => {
    const now = 1_000_000
    const queue: QueueState = {
      queues: { 'a\u001ft': ['head', 'behind'] },
      pending: {
        head: { id: 'head', queue: 'a', thread: 't', event: null, attempts: 1, lease: null, retryAt: now + 4000 },
        behind: { id: 'behind', queue: 'a', thread: 't', event: null, attempts: 0, lease: null, retryAt: null },
      },
    }
    expect(nextDue(queue, now)).toBe(now + 4000)
  })
})

describe("a sync elsewhere's inbox", () => {
  it("takes the same event for two syncs that share a key's name", async () => {
    const first = await tokenFor(131, 'one')
    const second = await tokenFor(132, 'two')
    for (const token of [first, second]) await api(token, 'POST', '/watchers', { watch: {}, sync })
    for (const token of [first, second]) expect((await api(token, 'POST', '/inbox/acme-slack', { events: [{ id: 'shared-1', event: reaction('300'), raw: {} }] })).status).toBe(200)
    expect((await api(first, 'GET', '/inbox/acme-slack/next')).body.items).toHaveLength(1)
    expect((await api(second, 'GET', '/inbox/acme-slack/next')).body.items).toHaveLength(1)
  })

  it('keeps what it gave up on after its last try, and runs it again when it is replayed', async () => {
    const token = await tokenFor(133, 'flaky')
    await api(token, 'POST', '/watchers', { watch: {}, sync })
    await api(token, 'POST', '/inbox/acme-slack', { events: [{ id: 'doomed-1', event: reaction('301'), raw: {} }] })
    let id = ''
    for (let tries = 0; tries < MATCH_TRIES; tries++) {
      const [item] = (await api(token, 'GET', '/inbox/acme-slack/next')).body.items
      id = item.id
      expect((await api(token, 'POST', `/inbox/acme-slack/${item.id}/ack`, { lease: item.lease, error: 'the platform is down' })).status).toBe(200)
      await skipRetries('bordeaux:user:133')
    }
    expect((await api(token, 'GET', '/inbox/acme-slack/next')).body.items).toEqual([])
    const owner = await tokenFor(1, 'owner')
    const { dead } = (await api(owner, 'GET', '/admin/dead-letters')).body
    expect(dead.find((letter: { id: string }) => letter.id === id)).toMatchObject({ owner: 'bordeaux:user:133', queue: '@inbox:acme-slack', error: 'the platform is down', attempts: MATCH_TRIES })
    expect((await api(owner, 'GET', '/admin/health')).body.dead.count).toBeGreaterThan(0)

    expect((await api(owner, 'POST', `/admin/dead-letters/${encodeURIComponent(id)}/retry`)).body).toEqual({ retried: id })
    const [again] = (await api(token, 'GET', '/inbox/acme-slack/next')).body.items
    expect(again).toMatchObject({ id, attempt: 0 })
    expect((await api(owner, 'GET', '/admin/dead-letters')).body.dead.some((letter: { id: string }) => letter.id === id)).toBe(false)
    expect((await api(owner, 'POST', `/admin/dead-letters/${encodeURIComponent(id)}/retry`)).status).toBe(404)
  })

  it('shows dead letters only to someone who manages every channel', async () => {
    expect((await api(await tokenFor(1, 'owner'), 'GET', '/admin/dead-letters', undefined, { 'x-board-can': 'ops=read' })).status).toBe(403)
  })
})

describe('discovery', () => {
  it("lists a service's sync, whose access comes from its token's facts", async () => {
    const person = await tokenFor(134, 'ops')
    const minted = await SELF.fetch(`${BASE}/admin/tokens`, { method: 'POST', headers: { authorization: `Bearer ${person}` }, body: JSON.stringify({ service: 'bridge', env: 'production' }) })
    const { token } = (await minted.json()) as { token: string }
    expect((await api(token, 'POST', '/watchers', { watch: {}, sync: [{ key: 'svc-slack', platform: 'slack' }] })).status).toBe(200)
    const listed = (await api(person, 'GET', '/')).body.sync as { key: string }[]
    expect(listed.map((entry) => entry.key)).toContain('svc-slack')
  })
})
