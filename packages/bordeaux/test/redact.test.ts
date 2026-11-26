import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../src/worker/backend.ts'
import { platform } from './config.ts'
import { api, BASE, tokenFor } from './helpers.ts'

const SECRET = 'sk-live-SECRET'
const leaks = (value: unknown) => JSON.stringify(value).includes(SECRET)

/** Runs the default board's own work until `done` holds, as its alarm would. */
async function until<T>(done: () => Promise<T | undefined | null | false>): Promise<T> {
  const board = env.BOARD.get(env.BOARD.idFromName(boardKey('default', null)))
  for (const deadline = Date.now() + 4000; Date.now() < deadline; ) {
    await runDurableObjectAlarm(board)
    const found = await done()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('timed out')
}

async function redact(token: string, id: string, body: unknown, board?: string) {
  const response = await SELF.fetch(`${BASE}/admin/messages/${id}/redact${board ? `?board=${board}` : ''}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, body: (await response.json()) as any }
}

describe('redaction', () => {
  it('scrubs a message from the log, its copies, the TailDO, watcher matches, files, and exports', async () => {
    const owner = await tokenFor(190, 'rae')
    await api(owner, 'POST', '/admin/boards', { name: 'leaky' })
    await api(owner, 'POST', '/admin/boards', { name: 'leaky-copy' })
    const token = await tokenFor(190, 'rae', `${BASE}/b/leaky`)
    const watcher = await tokenFor(191, 'wanda', `${BASE}/b/leaky`)
    await api(watcher, 'POST', '/b/leaky/watchers', { watch: { ops: { tail: 'ops' } } })
    const before = (await api(token, 'GET', '/b/leaky/events')).body.cursor as string
    // The TailDO follows from here: it keeps each event from now on.
    await api(token, 'GET', `/b/leaky/events?after=${before}&wait=1`)

    const form = new FormData()
    form.append('file', new File([SECRET], 'env.txt', { type: 'text/plain' }))
    const file = ((await (await SELF.fetch(`${BASE}/b/leaky/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })).json()) as { attachment: { id: string } }).attachment.id
    const { message } = (await api(token, 'POST', '/b/leaky/messages', { channel: 'ops', text: `the key is ${SECRET}`, labels: { note: SECRET }, attachments: [file] })).body
    await api(token, 'POST', `/b/leaky/messages/${message.id}/edit`, { text: `really, ${SECRET}` })
    await api(token, 'POST', `/b/leaky/messages/${message.id}/labels`, { set: { note: `${SECRET}-2` } })
    await api(token, 'POST', '/b/leaky/messages', { re: message.id, text: 'rotate it' })
    // A wait is the TailDO's: it now keeps the events that say it.
    expect(leaks((await api(token, 'GET', `/b/leaky/events?after=${before}&wait=5`)).body)).toBe(true)

    const done = await redact(owner, message.id, { reason: 'leaked token' }, 'leaky')
    expect(done.status).toBe(200)
    expect(done.body.redacted).toMatchObject({ id: Number(message.id), events: 3, files: 1, origin: null })
    expect(done.body.redacted.copies).toBeGreaterThan(0)
    expect(done.body.everywhere).toBeUndefined()

    // Gone as a delete goes, its reply kept.
    const thread = (await api(token, 'GET', `/b/leaky/messages/${message.id}`)).body
    expect(thread.message).toMatchObject({ deleted: true, text: '' })
    expect(thread.replies.map((reply: { text: string }) => reply.text)).toEqual(['rotate it'])
    // The feed from before it, from the board and from the TailDO, says nothing of it.
    const fromBoard = (await api(token, 'GET', `/b/leaky/events?after=${before}&all=true`)).body
    expect(fromBoard.events.map((event: { type: string }) => event.type)).toContain('message.deleted')
    expect(leaks(fromBoard)).toBe(false)
    expect(leaks((await api(token, 'GET', `/b/leaky/events?after=${before}&wait=5`)).body)).toBe(false)
    expect(leaks((await api(watcher, 'GET', '/b/leaky/watchers/matches?limit=50')).body)).toBe(false)
    // Its file's bytes are gone now, not in 30 days.
    expect((await SELF.fetch(`${BASE}/b/leaky/attachments/${file}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    expect((await env.FILES!.list({ prefix: 'boards/' })).objects.some((object) => object.key.endsWith(file))).toBe(false)

    // The export holds none of it, and still imports: what's rewritten passes upstream's schema.
    const headers = { authorization: `Bearer ${owner}` }
    const exported = await (await SELF.fetch(`${BASE}/admin/export?board=leaky`, { headers })).text()
    expect(exported).not.toContain(SECRET)
    expect((await SELF.fetch(`${BASE}/admin/import?board=leaky-copy`, { method: 'POST', headers, body: exported })).status).toBe(200)

    // Who redacted what, and why, off the feed.
    const { redactions } = (await api(owner, 'GET', '/admin/redactions?board=leaky')).body
    expect(redactions).toMatchObject([{ id: message.id, reason: 'leaked token', by: { principal: 'bordeaux:user:190' } }])
  })

  it('is for someone who manages every channel, and says why it refuses', async () => {
    const owner = await tokenFor(192, 'sam')
    const { message } = (await api(owner, 'POST', '/messages', { channel: 'redact-refusals', text: 'fine' })).body
    expect((await redact(owner, message.id, {})).body.error.code).toBe('invalid_request')
    expect((await redact(owner, '999999', { reason: 'x' })).status).toBe(404)
    const narrowed = await SELF.fetch(`${BASE}/admin/messages/${message.id}/redact`, { method: 'POST', headers: { authorization: `Bearer ${owner}`, 'x-board-can': 'redact-refusals=read' }, body: JSON.stringify({ reason: 'x' }) })
    expect(narrowed.status).toBe(403)
  })

  it("deletes the board's copies on a platform, and with --everywhere the original it came from", async () => {
    const token = await tokenFor(193, 'pat')
    await SELF.fetch(`${BASE}/webhooks/chat`, { method: 'POST', body: JSON.stringify({ type: 'message', threadId: 'chat:C1:700', id: '700', text: `my password is ${SECRET}`, user: 'U7', name: 'Lou' }) })
    const root = await until(async () => (await api(token, 'GET', '/messages?channel=support')).body.messages?.find((m: { text: string }) => m.text.includes(SECRET)))
    const { message: reply } = (await api(token, 'POST', '/messages', { re: root.id, text: `echoing ${SECRET}` })).body
    await until(async () => platform.posts.find((post) => post.text.includes(`echoing ${SECRET}`)))

    // The board's own reply: upstream's sync deletes the copy it made, as for any delete.
    const kept = await redact(token, reply.id, { reason: 'echoed the password' })
    expect(kept.body.redacted.origin).toBeNull()
    await until(async () => platform.deletes.find((gone) => gone.threadId === 'chat:C1:700' && gone.messageId !== '700'))

    // The platform's own message: only --everywhere deletes it there.
    const everywhere = await redact(token, root.id, { reason: 'a password', everywhere: true })
    expect(everywhere.body.everywhere).toEqual({ deleted: true, target: 'chat:C1:700' })
    expect(platform.deletes).toContainEqual({ threadId: 'chat:C1:700', messageId: '700' })
  })

  it("drops what a sync elsewhere's inbox holds of it, and leaves its original to that sync", async () => {
    const bridge = await tokenFor(194, 'bridge')
    await api(bridge, 'POST', '/watchers', { watch: {}, sync: [{ key: 'leak-slack', platform: 'slack' }] })
    const author = { id: 'leak-slack:user:U1', handle: 'ana', name: 'Ana', avatar: null, isBot: false }
    const origin = { channel: 'leak-slack:C1', thread: 'leak-slack:C1:500', subthread: null, message: '500', context: null }
    const imported = (await api(bridge, 'POST', '/sync/imports', { op: 'post', author, from: 'leak-slack', channel: 'leaks', text: `key ${SECRET}`, origin })).body.message
    const edited = { kind: 'edited', channel: 'leak-slack:C1', thread: 'leak-slack:C1:500', subthread: null, message: '500', text: `still ${SECRET}`, author }
    const other = { ...edited, message: '501', text: 'unrelated' }
    await api(bridge, 'POST', '/inbox/leak-slack', { events: [{ id: 'leak-1', event: edited, raw: { text: SECRET } }, { id: 'leak-2', event: other, raw: {} }] })
    expect(leaks((await api(bridge, 'GET', '/inbox/leak-slack')).body)).toBe(true)

    const done = await redact(await tokenFor(1, 'owner'), String(imported), { reason: 'leaked in slack', everywhere: true })
    expect(done.body.redacted.queued).toBeGreaterThanOrEqual(1)
    expect(done.body.everywhere).toMatchObject({ deleted: false, target: 'leak-slack:C1:500' })
    const { events } = (await api(bridge, 'GET', '/inbox/leak-slack')).body
    expect(leaks(events)).toBe(false)
    expect(events.map((event: { event: { message: string } }) => event.event.message)).toEqual(['501'])
  })
})
