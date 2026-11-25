import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../src/worker/backend.ts'
import { api, tokenFor } from './helpers.ts'

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
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('a deploy', () => {
  it('reaches a busy board: a call from a newer version resets it once its answer has gone', async () => {
    const stub = board('deploy-newer')
    await runningOld(stub)
    // Any call carries its version, even one the board refuses.
    expect(await stub.call('channels', {} as never, {}, 'deploy-newer', NEW)).toMatchObject({ ok: false })
    await settle()
    expect(await runningOld(board('deploy-newer'))).toBe(false)
  })

  it("reaches a board a client is long-polling: the poll answers at once, and the board resets", async () => {
    const token = await tokenFor(150, 'tailer')
    const stub = board(null as never)
    await runningOld(stub)
    const { cursor } = (await api(token, 'GET', '/events')).body
    const started = Date.now()
    const polling = api(token, 'GET', `/events?after=${encodeURIComponent(cursor)}&wait=20`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    await stub.call('channels', {} as never, {}, null, NEW)
    const polled = await polling
    expect(polled.status).toBe(200)
    expect(Date.now() - started).toBeLessThan(5000)
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
})
