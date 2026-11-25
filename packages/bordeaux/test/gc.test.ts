import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RAW_MAX } from '../src/engine/engine.ts'
import { boardKey } from '../src/worker/backend.ts'
import { api, BASE, tokenFor } from './helpers.ts'

const DAY = 86_400_000
const board = () => env.BOARD.get(env.BOARD.idFromName(boardKey(null)))
const sync = [{ key: 'gc-slack', platform: 'slack' }]
const author = { id: 'gc-slack:user:U1', handle: 'kim', name: 'Kim', avatar: null, isBot: false }
const reaction = (thread: string) => ({ kind: 'reaction', channel: 'gc-slack:C1', thread: `gc-slack:C1:${thread}`, subthread: null, message: thread, context: null, emoji: 'eyes', added: true, author })

/** An upload sent with the request, as `vb post --file` sends one. */
async function upload(token: string, name: string) {
  const form = new FormData()
  form.append('file', new File(['bytes'], name, { type: 'text/plain' }))
  const response = await SELF.fetch(`${BASE}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })
  return ((await response.json()) as { attachment: { id: string } }).attachment.id
}

const stored = async () => (await env.FILES!.list({ prefix: 'boards/' })).objects.map((object) => object.key.split('/').at(-1))
const copies = (id: number) => runInDurableObject(board(), async (_instance, state) => state.storage.sql.exec<{ n: number }>('select count(*) as n from board_versions where message_id = ?', id).one().n)

afterEach(() => vi.useRealTimers())

describe('retention', () => {
  it("keeps an inbox's raw payload whole up to 256 KB, and cuts a bigger one short, marked", async () => {
    const token = await tokenFor(160, 'pusher')
    await api(token, 'POST', '/watchers', { watch: {}, sync })
    const big = { blob: 'x'.repeat(RAW_MAX + 10) }
    await api(token, 'POST', '/inbox/gc-slack', { events: [{ id: 'small', event: reaction('1'), raw: { ok: true } }, { id: 'big', event: reaction('2'), raw: big }] })
    const { items } = (await api(token, 'GET', '/inbox/gc-slack/next?limit=10')).body
    expect(items.find((item: { thread: string }) => item.thread.endsWith(':1')).raw).toEqual({ ok: true })
    const cut = items.find((item: { thread: string }) => item.thread.endsWith(':2')).raw
    expect(cut).toMatchObject({ truncated: true, bytes: JSON.stringify(big).length })
    expect(cut.json.length).toBeLessThanOrEqual(RAW_MAX)
  })

  it('after 30 days, removes deleted messages’ files, unused uploads, and old copies of messages, and keeps the messages', async () => {
    let owner = await tokenFor(1, 'owner')
    const kept = await upload(owner, 'kept.txt')
    const deleted = await upload(owner, 'deleted.txt')
    const unused = await upload(owner, 'unused.txt')
    const recent = await upload(owner, 'recent.txt')
    const { message: keeper } = (await api(owner, 'POST', '/messages', { channel: 'gc', text: 'v1', attachments: [kept] })).body
    for (const text of ['v2', 'v3']) expect((await api(owner, 'POST', `/messages/${keeper.id}/edit`, { text })).status).toBe(200)
    const { message: gone } = (await api(owner, 'POST', '/messages', { channel: 'gc', text: 'oops', attachments: [deleted] })).body
    expect((await api(owner, 'POST', `/messages/${gone.id}/delete`, {})).status).toBe(200)
    const keeperIndex = Number(String(keeper.id).replace(/\D/g, ''))
    const before = await copies(keeperIndex)
    expect(before).toBe(3)

    // A day from now, nothing is old enough.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + DAY })
    owner = await tokenFor(1, 'owner')
    expect((await api(owner, 'POST', '/admin/gc')).body.collected).toMatchObject({ files: 0, messageCopies: 0 })

    vi.setSystemTime(Date.now() + 30 * DAY)
    owner = await tokenFor(1, 'owner')
    // Something new after the cutoff: its copy, and its upload, stay.
    await api(owner, 'POST', `/messages/${keeper.id}/edit`, { text: 'v4' })
    await api(owner, 'POST', '/messages', { channel: 'gc', text: 'new', attachments: [recent] })
    const { collected } = (await api(owner, 'POST', '/admin/gc')).body
    // Two of the kept message's three old copies, and the deleted one's copy from before its delete.
    expect(collected).toMatchObject({ files: 2, messageCopies: 3 })
    const left = await stored()
    expect(left).toEqual(expect.arrayContaining([kept, recent]))
    expect(left).not.toContain(deleted)
    expect(left).not.toContain(unused)
    // The latest copy from before the cutoff, and the one after it.
    expect(await copies(keeperIndex)).toBe(2)
    expect((await api(owner, 'GET', `/messages/${keeper.id}`)).body.message.text).toBe('v4')
    expect((await SELF.fetch(`${BASE}/attachments/${kept}`, { headers: { authorization: `Bearer ${owner}` } })).status).toBe(200)
  })

  it('is for someone who manages every channel', async () => {
    expect((await api(await tokenFor(161, 'someone'), 'POST', '/admin/gc', undefined, { 'x-board-can': 'ops=read' })).status).toBe(403)
  })
})
