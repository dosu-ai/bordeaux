// Hosted sync as data (spec 09, "Sync, later"): each team's rows, set by its owners.
import { env, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { githubTeamSync } from '../../src/sync/index.ts'
import { directory, personId } from '../../src/worker/auth.ts'
import type { Team } from '../../src/worker/team.ts'

const HUB = 'https://board.test'

/** A team, as `POST /__dev/team` makes one, with GitHub account `id`: its URL and ID. */
async function team(login: string, id: number): Promise<{ url: string; id: string }> {
  const response = await SELF.fetch(`${HUB}/__dev/team`, { method: 'POST', body: JSON.stringify({ login, id }) })
  const made = (await response.json()) as { url: string; team: string }
  return { url: made.url, id: made.team }
}

/** A person's token on a team, an owner of it or not. */
async function person(at: { url: string; id: string }, user: number, owner: boolean): Promise<string> {
  const response = await SELF.fetch(`${at.url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: user, login: `user${user}` }) })
  const { access_token } = (await response.json()) as { access_token: string }
  await directory(env, { id: at.id } as Team).setOwner(personId(user), owner, Date.now() + 3_600_000)
  return access_token
}

async function call(url: string, token: string, method: string, path: string, body?: unknown) {
  const response = await SELF.fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: response.status, body: (await response.json().catch(() => null)) as any }
}

describe('hosted sync rows', () => {
  it('stay off quietly before the sync App is set up, and say which setting is missing when some are', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(githubTeamSync({} as never)).toBeNull()
      expect(errors).not.toHaveBeenCalled()
      expect(githubTeamSync({ GITHUB_SYNC_APP_ID: '77' } as never)).toBeNull()
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('GITHUB_SYNC_PRIVATE_KEY, GITHUB_SYNC_WEBHOOK_SECRET'))
    } finally {
      errors.mockRestore()
    }
  })


  it("are changed by the team's owners only", async () => {
    const at = await team('rows-owned', 6001)
    const member = await person(at, 61, false)
    const owner = await person(at, 62, true)
    const row = { provider: 'github', external: 'rows-owned/web', channel: 'prs' }

    expect(await call(at.url, member, 'POST', '/admin/sync', row)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } })
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.sync).toEqual([])
    expect(await call(at.url, owner, 'POST', '/admin/sync', row)).toMatchObject({ status: 201, body: { created: true, linked: false, install: 'https://github.com/apps/bordeaux-ai-sync/installations/new' } })
    expect(await call(at.url, member, 'DELETE', '/admin/sync?provider=github&external=rows-owned/web')).toMatchObject({ status: 403 })
    // Anyone on the board reads them.
    expect((await call(at.url, member, 'GET', '/admin/sync')).body.sync).toMatchObject([row])
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.sync).toMatchObject([{ ...row, direction: 'into', by: personId(62) }])
    expect(await call(at.url, owner, 'DELETE', '/admin/sync?provider=github&external=rows-owned/web')).toMatchObject({ status: 200, body: { removed: true } })
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.sync).toEqual([])
  })

  it("take only the team's own repos, and providers the Worker has", async () => {
    const at = await team('rows-own', 6002)
    const owner = await person(at, 63, true)
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'someone-else/web', channel: 'prs' })).status).toBe(400)
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'rows-own', channel: 'prs' })).status).toBe(400)
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external: '#ops', channel: 'ops' })).status).toBe(400)
    // Upstream matches the owner as GitHub writes it: another case would never sync.
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'Rows-Own/web', channel: 'prs' })).status).toBe(400)
    // Channels as upstream names them: no spaces, capitals, or dots.
    for (const channel of ['Not A Channel', 'prs.v2']) expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'rows-own/web', channel })).status, channel).toBe(400)
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'rows-own/web', channel: 'work/prs', direction: 'mirror' })).status).toBe(201)
  })
})
