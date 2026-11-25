import { describe, expect, it } from 'vitest'
import { api, tokenFor } from './helpers.ts'

const sync = [{ key: 'acme-slack', platform: 'slack' }]
const author = { id: 'acme-slack:user:U1', handle: 'ana', name: 'Ana', avatar: null, isBot: false }

describe('watchers matching', () => {
  it('keeps matching after a pull that found nothing to match', async () => {
    const token = await tokenFor(80, 'wes')
    await api(token, 'POST', '/watchers', { watch: { all: { tail: 'quiet' } } })
    // A pull with nothing new runs matching with nothing to do: it mustn't stop the next run.
    expect((await api(token, 'GET', '/watchers/matches')).body.matches).toEqual([])
    const { message } = (await api(await tokenFor(81, 'other'), 'POST', '/messages', { channel: 'quiet', text: 'now' })).body
    const { matches } = (await api(token, 'GET', '/watchers/matches?wait=2')).body
    expect(matches.map((m: { event: { message?: { id: string } } }) => m.event.message?.id)).toEqual([message.id])
  })
})

describe('a sync elsewhere', () => {
  it('imports as a profile of itself, records where it delivered, and gets every change as @sync', async () => {
    const token = await tokenFor(82, 'bridge')
    await api(token, 'POST', '/watchers', { watch: {}, sync })
    const origin = { channel: 'acme-slack:C1', thread: 'acme-slack:C1:100', subthread: null, message: '100', context: null }
    const imported = await api(token, 'POST', '/sync/imports', { op: 'post', author, from: 'acme-slack', channel: 'support', text: 'help!', origin, id: 'slack-100' })
    expect(imported.status).toBe(200)
    const { message } = (await api(token, 'GET', `/messages/${imported.body.message}`)).body
    expect(message).toMatchObject({ text: 'help!', from: 'acme-slack', by: { principal: 'bordeaux:user:82', actor: 'bordeaux:user:82+acme-slack:user:U1' } })

    // Sent again, it lands once; another root can't take its platform thread.
    expect((await api(token, 'POST', '/sync/imports', { op: 'post', author, from: 'acme-slack', channel: 'support', text: 'help!', origin, id: 'slack-100' })).body.message).toBe(message.id)
    const second = await api(token, 'POST', '/sync/imports', { op: 'post', author, from: 'acme-slack', channel: 'support', text: 'again', origin: { ...origin, message: '101' } })
    expect(second.body.error.code).toBe('already_synced')

    // A reply on the board goes to the sync as a match of its @sync watcher, and its receipt is a copy.
    const reply = (await api(await tokenFor(83, 'agent'), 'POST', '/messages', { re: message.id, text: 'on it' })).body.message
    // A thread's matches come one at a time: the import's own, then, once that's acked, the reply's.
    const first = (await api(token, 'GET', '/watchers/matches?wait=2')).body.matches[0]
    expect(first).toMatchObject({ watcher: '@sync', event: { type: 'message.posted', message: { id: message.id } } })
    await api(token, 'POST', `/watchers/matches/${first.id}/ack`, { lease: first.lease })
    const next = (await api(token, 'GET', '/watchers/matches?wait=2')).body.matches[0]
    expect(next).toMatchObject({ watcher: '@sync', event: { type: 'message.posted', message: { id: reply.id } } })
    await api(token, 'POST', '/sync/receipts', { kind: 'message', message: reply.id, target: 'acme-slack:C1:100', external: { thread: 'acme-slack:C1:100', message: '102' } })
    expect((await api(token, 'GET', `/sync/copies?message=${reply.id}`)).body.copies[reply.id]['acme-slack:C1:100']).toEqual({ thread: 'acme-slack:C1:100', message: '102' })
  })
})
