import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { api, BASE, tokenFor } from './helpers.ts'

describe('files', () => {
  it('take a direct upload through the board, and hand it to whoever reads the message that carries it', async () => {
    const author = await tokenFor(40, 'ann')
    const reader = await tokenFor(41, 'ben')
    const bytes = new TextEncoder().encode('a'.repeat(6 * 1024 * 1024))
    const ticket = (await api(author, 'POST', '/attachments/uploads', { name: 'trace.txt', type: 'text/plain', size: bytes.byteLength })).body
    expect(ticket.url).toMatch(new RegExp(`^${BASE}/__bordeaux/uploads/${ticket.id}\\?t=`))

    // The Worker takes exactly the bytes the start said, and nothing until they're there.
    expect((await api(author, 'POST', `/attachments/uploads/${ticket.id}`)).status).toBe(409)
    const short = await SELF.fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes.slice(1) })
    expect(short.status).toBe(400)
    expect((await SELF.fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes })).status).toBe(200)

    // Before a message carries it, it's only its uploader's, and a reader of every channel's.
    const narrowed = { 'x-board-can': 'traces=read' }
    const { attachment } = (await api(author, 'POST', `/attachments/uploads/${ticket.id}`)).body
    expect(attachment).toEqual({ id: ticket.id, name: 'trace.txt', type: 'text/plain', size: bytes.byteLength })
    expect((await SELF.fetch(`${BASE}/attachments/${ticket.id}`, { headers: { authorization: `Bearer ${reader}`, ...narrowed } })).status).toBe(404)

    await api(author, 'POST', '/messages', { channel: 'traces', text: 'the trace', attachments: [ticket.id] })
    const download = await SELF.fetch(`${BASE}/attachments/${ticket.id}`, { headers: { authorization: `Bearer ${reader}`, ...narrowed } })
    expect(download.status).toBe(200)
    expect((await download.arrayBuffer()).byteLength).toBe(bytes.byteLength)
  })

  it("refuses a direct upload's URL without its secret", async () => {
    const author = await tokenFor(42, 'cat')
    const ticket = (await api(author, 'POST', '/attachments/uploads', { name: 'x.txt', type: 'text/plain', size: 3 })).body
    const forged = await SELF.fetch(`${BASE}/__bordeaux/uploads/${ticket.id}?t=nope`, { method: 'PUT', headers: ticket.headers, body: 'abc' })
    expect(forged.status).toBe(404)
  })
})
