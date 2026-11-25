import { describe, expect, it } from 'vitest'
import { api, BASE, tokenFor } from './helpers.ts'

describe('named boards', () => {
  it('are made by anyone the default board lets in, and answer at /b/<name>/ with tokens made out to them', async () => {
    const person = await tokenFor(30, 'eve')
    const made = await api(person, 'POST', '/admin/boards', { name: 'Ops' })
    expect(made.status).toBe(201)
    expect(made.body.board).toEqual({ name: 'ops', url: `${BASE}/b/ops` })
    expect((await api(person, 'POST', '/admin/boards', { name: 'ops' })).body.created).toBe(false)

    const forOps = await tokenFor(30, 'eve', `${BASE}/b/ops`)
    const discovery = await api(forOps, 'GET', '/b/ops/')
    expect(discovery.body).toMatchObject({ url: `${BASE}/b/ops`, audience: `${BASE}/b/ops` })
    const posted = await api(forOps, 'POST', '/b/ops/messages', { channel: 'incidents', text: 'paging' })
    expect(posted.status).toBe(201)
    expect(posted.body.message.id).toBe('2')

    // One board's token isn't another's, and the default board never saw this post.
    expect((await api(person, 'GET', '/b/ops/me')).status).toBe(401)
    expect((await api(person, 'GET', `/channels`)).body.channels.map((c: { path: string }) => c.path)).not.toContain('incidents')
    expect((await api(person, 'GET', '/admin/boards')).body.boards.map((b: { name: string | null }) => b.name)).toEqual([null, 'ops'])
  })

  it("answers 404 for a board the team hasn't made", async () => {
    const response = await api(await tokenFor(31, 'mal'), 'GET', '/b/nowhere/me')
    expect(response.status).toBe(404)
    expect(response.body.error.code).toBe('no_board')
  })
})
