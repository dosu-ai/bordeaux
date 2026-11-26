import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { directory, personId } from '../src/worker/auth.ts'
import { envTeam } from '../src/worker/team.ts'
import { api, BASE, tokenFor } from './helpers.ts'

async function serviceToken(managerToken: string, service: string, environment = 'production') {
  const response = await SELF.fetch(`${BASE}/admin/tokens`, { method: 'POST', headers: { authorization: `Bearer ${managerToken}` }, body: JSON.stringify({ service, env: environment }) })
  return { status: response.status, body: (await response.json()) as { token: string; jti: string; sub: string } }
}

describe('service tokens', () => {
  it("let a service in as its board's own OIDC principal, with g4's reach, until revoked", async () => {
    const person = await tokenFor(10, 'ops')
    const minted = await serviceToken(person, 'www')
    expect(minted.status).toBe(201)
    const me = (await api(minted.body.token, 'GET', '/me')).body
    expect(me.principal).toBe('oidc:board.test:service:www:production')
    expect(me.can['*']).toEqual(['read', 'post', 'react', 'label', 'sync'])
    expect((await api(minted.body.token, 'POST', '/messages', { channel: 'deploys', text: 'www deployed' })).status).toBe(201)

    const revoked = await SELF.fetch(`${BASE}/admin/tokens/${minted.body.jti}`, { method: 'DELETE', headers: { authorization: `Bearer ${person}` } })
    expect(await revoked.json()).toEqual({ revoked: true })
    const after = await api(minted.body.token, 'GET', '/me')
    expect(after.status).toBe(401)
    expect(after.body.error.code).toBe('token_revoked')
  })

  it("are only made by someone who manages every channel", async () => {
    const person = await tokenFor(11, 'dev')
    const response = await SELF.fetch(`${BASE}/admin/tokens`, { method: 'POST', headers: { authorization: `Bearer ${person}`, 'x-board-can': 'ops=read,post' }, body: JSON.stringify({ service: 'www' }) })
    expect(response.status).toBe(403)
  })
})

describe('grants', () => {
  it("let an owner manage them after revoking everyone's, and leave the rest of the team out", async () => {
    const owner = await tokenFor(20, 'boss')
    const member = await tokenFor(21, 'member')
    await directory(env, envTeam(env)).setOwner(personId(20), true, Date.now() + 3_600_000)

    const { grants } = (await api(owner, 'GET', '/grants')).body
    expect(grants.map((grant: { id: string }) => grant.id)).toEqual(['g1', 'g2', 'g3', 'g4'])
    expect((await api(owner, 'POST', '/grants/g1/revoke', { lockMeOut: true })).status).toBe(200)

    expect((await api(member, 'POST', '/messages', { channel: 'general', text: 'hello?' })).status).toBe(403)
    const regrant = await api(owner, 'POST', '/grants', { principals: [{ kind: 'user', userId: '21' }], can: { general: ['read', 'post'] } })
    expect(regrant.status).toBe(200)
    expect((await api(member, 'POST', '/messages', { channel: 'general', text: 'hello!' })).status).toBe(201)
  })
})
