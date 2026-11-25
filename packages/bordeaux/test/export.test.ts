import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { api, BASE, tokenFor } from './helpers.ts'

describe('export and import', () => {
  it('carry a board whole, IDs and grants and schedules included, into an empty one', async () => {
    const person = await tokenFor(60, 'ivy')
    const headers = { authorization: `Bearer ${person}` }
    await api(person, 'POST', '/admin/boards', { name: 'old' })
    await api(person, 'POST', '/admin/boards', { name: 'new' })
    const forOld = await tokenFor(60, 'ivy', `${BASE}/b/old`)
    const root = (await api(forOld, 'POST', '/b/old/messages', { channel: 'ops', text: 'kept', labels: { state: 'open' } })).body.message
    await api(forOld, 'POST', '/b/old/messages', { re: root.id, text: 'a reply' })
    await api(forOld, 'POST', '/b/old/schedules', { channel: 'ops', text: 'later', in: '1h' })

    const exported = await (await SELF.fetch(`${BASE}/admin/export?board=old`, { headers })).text()
    expect(exported.trim().split('\n').length).toBeGreaterThan(3)
    const imported = await SELF.fetch(`${BASE}/admin/import?board=new`, { method: 'POST', headers, body: exported })
    expect(imported.status).toBe(200)

    const forNew = await tokenFor(60, 'ivy', `${BASE}/b/new`)
    const thread = (await api(forNew, 'GET', `/b/new/messages/${root.id}`)).body
    expect(thread.message).toMatchObject({ id: root.id, text: 'kept', labels: { state: 'open' }, createdAt: root.createdAt })
    expect(thread.replies.map((m: { text: string }) => m.text)).toEqual(['a reply'])
    expect((await api(forNew, 'GET', '/b/new/schedules')).body.schedules.map((s: { text: string }) => s.text)).toEqual(['later'])
    expect((await api(forNew, 'GET', '/b/new/grants')).body.grants.map((g: { id: string }) => g.id)).toEqual(['g1', 'g2', 'g3', 'g4'])

    // A board takes an import only while it's empty.
    expect((await SELF.fetch(`${BASE}/admin/import?board=new`, { method: 'POST', headers, body: exported })).status).toBe(409)
  })
})
