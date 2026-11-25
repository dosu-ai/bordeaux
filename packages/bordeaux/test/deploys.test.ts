import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../src/worker/backend.ts'
import { api, BASE, tokenFor } from './helpers.ts'

const board = (name: string) => env.BOARD.get(env.BOARD.idFromName(boardKey(name)))
const OLD = { id: 'v1', tag: '', timestamp: '2026-11-01T00:00:00.000Z' }
const NEW = { id: 'v2', timestamp: '2026-11-25T00:00:00.000Z' }

/** Marks this board's running instance as one running version `OLD`; true once it's marked. */
const runningOld = (stub: ReturnType<typeof board>) =>
  runInDurableObject(stub, async (instance) => {
    const marked = (instance as any).marked === true
    ;(instance as any).marked = true
    ;(instance as any).env = { ...(instance as any).env, CF_VERSION_METADATA: OLD }
    return marked
  })

/** Lets a reload that's waiting for the call to finish happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

describe('a deploy', () => {
  it('reaches a busy board: a call from a newer version resets it once its answer has gone', async () => {
    const stub = board('deploy-newer')
    await runningOld(stub)
    // Any call carries its version, even one the board refuses.
    expect(await stub.call('channels', {} as never, {}, 'deploy-newer', NEW)).toMatchObject({ ok: false })
    await settle()
    expect(await runningOld(board('deploy-newer'))).toBe(false)
  })

  it("reaches a board a client is long-polling: the long-poll waits in the TailDO, so the board resets", async () => {
    const token = await tokenFor(150, 'tailer')
    const stub = board(null as never)
    await runningOld(stub)
    const { cursor } = (await api(token, 'GET', '/events')).body
    const polling = api(token, 'GET', `/events?after=${encodeURIComponent(cursor)}&wait=3`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await stub.call('channels', {} as never, {}, null, NEW)
    await settle()
    expect(await runningOld(board(null as never))).toBe(false)
    expect((await polling).status).toBe(200)
  })

  it("reaches a TailDO: a newer version's long-poll ends the waiting ones at once, and it resets", async () => {
    const token = await tokenFor(151, 'tailer2')
    const tail = env.TAIL!.get(env.TAIL!.idFromName(boardKey(null)))
    const { cursor } = (await api(token, 'GET', '/events')).body
    const started = Date.now()
    const polling = api(token, 'GET', `/events?after=${encodeURIComponent(cursor)}&wait=20`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await runningOld(tail as never)
    const wire = { principal: { id: 'bordeaux:user:151', kind: 'person', handle: 'tailer2', can: { '*': ['read'] } }, author: { id: 'bordeaux:user:151', handle: 'tailer2', name: 'tailer2', avatar: null, profile: null }, actor: { id: 'bordeaux:user:151', kind: 'person', handle: 'tailer2', name: 'tailer2', avatar: null }, request: true }
    expect(await tail.events(wire as never, { after: cursor, wait: 20 } as never, null, NEW)).toMatchObject({ ok: true })
    expect((await polling).status).toBe(200)
    expect(Date.now() - started).toBeLessThan(5000)
    await settle()
    expect(await runningOld(env.TAIL!.get(env.TAIL!.idFromName(boardKey(null))) as never)).toBe(false)
  })

  it("fails no request that's under way when it resets: grants reads included", async () => {
    const token = await tokenFor(152, 'busy')
    const stub = board(null as never)
    await runningOld(stub)
    // A burst of posts, each of which reads the grants first, as a newer version calls.
    const posts = Array.from({ length: 40 }, (_, i) => api(token, 'POST', '/messages', { channel: 'deploy-busy', text: `post ${i}` }))
    await stub.call('channels', {} as never, {}, null, { id: 'v3', timestamp: '2026-11-26T00:00:00.000Z' })
    const more = Array.from({ length: 40 }, (_, i) => api(token, 'POST', '/messages', { channel: 'deploy-busy', text: `more ${i}` }))
    const statuses = (await Promise.all([...posts, ...more])).map((answer) => answer.status)
    expect(statuses.filter((status) => status !== 201)).toEqual([])
    await settle()
    expect(await runningOld(board(null as never))).toBe(false)
  })

  it('resets a board once per version, so one a gradual deployment keeps on the old version settles', async () => {
    const stub = board('deploy-once')
    await runningOld(stub)
    await stub.call('channels', {} as never, {}, 'deploy-once', NEW)
    await settle()
    await runningOld(board('deploy-once'))
    await board('deploy-once').call('channels', {} as never, {}, 'deploy-once', NEW)
    await settle()
    expect(await runningOld(board('deploy-once'))).toBe(true)
  })

  it('leaves a board alone when an older version calls it', async () => {
    const stub = board('deploy-older')
    await runningOld(stub)
    await stub.call('channels', {} as never, {}, 'deploy-older', { id: 'v0', timestamp: '2026-10-01T00:00:00.000Z' })
    await settle()
    expect(await runningOld(board('deploy-older'))).toBe(true)
  })
  it("shows in bdx health which version a board runs, and looking doesn't reload it", async () => {
    const owner = await tokenFor(1, 'owner')
    await api(owner, 'POST', '/admin/boards', { name: 'deploy-health' })
    const stub = board('deploy-health')
    await runningOld(stub)
    const response = await SELF.fetch(`${BASE}/admin/health?board=deploy-health`, { headers: { authorization: `Bearer ${owner}` } })
    expect(((await response.json()) as { version: string }).version).toBe('v1')
    await settle()
    expect(await runningOld(board('deploy-health'))).toBe(true)
  })
})
