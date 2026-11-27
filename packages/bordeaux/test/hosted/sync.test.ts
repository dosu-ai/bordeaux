// Hosted sync as data (spec 09, "Sync, later"): two teams on one Worker, each with its own rows
// and its own installation of the sync App, GitHub answered by vitest.hosted.config.ts.
import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { githubTeamSync } from '../../src/sync/index.ts'
import { directory, personId } from '../../src/worker/auth.ts'
import { boardKey } from '../../src/worker/backend.ts'
import { registry } from '../../src/worker/registry.ts'
import { newerSync, type Team } from '../../src/worker/team.ts'

const HUB = 'https://board.test'
const SYNC_APP = '77'

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

/** An event from the sync App, signed as GitHub signs it, to the hub or straight to `url`. */
async function deliver(kind: string, payload: unknown, { secret = 'sync-test-secret', url = `${HUB}/__bordeaux/github/events` } = {}) {
  const body = JSON.stringify(payload)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, '0')).join('')
  const headers = { 'x-github-event': kind, 'x-github-delivery': crypto.randomUUID(), 'x-github-hook-installation-target-id': SYNC_APP, 'x-hub-signature-256': `sha256=${mac}`, 'content-type': 'application/json' }
  return SELF.fetch(url, { method: 'POST', headers, body })
}

/** GitHub's `issues.opened` for issue `number` of `repo`, on installation `installation`. */
const opened = (installation: number, repo: string, number: number, title: string) => {
  const [owner, name] = repo.split('/') as [string, string]
  const user = { login: 'ada', id: 5, type: 'User', avatar_url: 'https://avatars.test/5' }
  return {
    action: 'opened',
    issue: { number, title, html_url: `https://github.com/${repo}/issues/${number}`, body: `${title}, in detail`, state: 'open', user, labels: [], assignees: [] },
    repository: { id: 900, full_name: repo, name, owner: { login: owner, id: 1 } },
    sender: user,
    installation: { id: installation },
  }
}

/** Runs a team's default board's own work until `done` holds, as its alarm would. */
async function until<T>(teamId: string, done: () => Promise<T | undefined | null | false>): Promise<T> {
  const board = env.BOARD.get(env.BOARD.idFromName(boardKey(teamId, null)))
  for (const deadline = Date.now() + 4000; Date.now() < deadline; ) {
    await runDurableObjectAlarm(board)
    const found = await done()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('timed out')
}

/** Every root in a team's channel. */
const roots = async (url: string, token: string, channel: string) => ((await call(url, token, 'GET', `/messages?channel=${channel}`)).body?.messages ?? []) as { id: string; text: string }[]

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

describe('hosted GitHub sync', () => {
  it("lands a webhook for one team's installation on that team's board only, and only by that team's rows", async () => {
    const a = await team('sync-a', 6101)
    const b = await team('sync-b', 6102)
    const ownerA = await person(a, 71, true)
    const ownerB = await person(b, 72, true)
    // Both teams map a repo to channel `prs`; B's row is for its own repo.
    await call(a.url, ownerA, 'POST', '/admin/sync', { provider: 'github', external: 'sync-a/web', channel: 'prs' })
    await call(b.url, ownerB, 'POST', '/admin/sync', { provider: 'github', external: 'sync-b/web', channel: 'prs' })
    // Each installs the sync App on its account.
    expect(await (await deliver('installation', { action: 'created', installation: { id: 7101, account: { id: 6101, login: 'sync-a', type: 'Organization' } } })).json()).toEqual({ ok: true, team: a.id })
    expect(await (await deliver('installation', { action: 'created', installation: { id: 7102, account: { id: 6102, login: 'sync-b', type: 'Organization' } } })).json()).toEqual({ ok: true, team: b.id })
    expect((await call(a.url, ownerA, 'GET', '/admin/sync')).body.providers).toEqual([{ provider: 'github', linked: true, install: 'https://github.com/apps/bordeaux-ai-sync/installations/new' }])

    expect((await deliver('issues', opened(7101, 'sync-a/web', 1, 'A is broken'))).status).toBe(200)
    const root = await until(a.id, async () => (await roots(a.url, ownerA, 'prs')).find((m) => m.text.includes('A is broken')))
    expect(root.text).toContain('Issue #1')

    // B's installation, naming A's repo: B has no row for it, so it lands nowhere, and not on A's board.
    expect((await deliver('issues', opened(7102, 'sync-a/web', 2, 'B names A'))).status).toBe(200)
    expect((await deliver('issues', opened(7102, 'sync-b/web', 3, 'B is broken'))).status).toBe(200)
    await until(b.id, async () => (await roots(b.url, ownerB, 'prs')).find((m) => m.text.includes('B is broken')))
    await until(a.id, async () => true)
    expect((await roots(a.url, ownerA, 'prs')).map((m) => m.text).join('\n')).not.toMatch(/B names A|B is broken/)
    expect((await roots(b.url, ownerB, 'prs')).map((m) => m.text).join('\n')).not.toMatch(/A is broken|B names A/)
  })

  it("mirrors a board reply back as the team's own installation", async () => {
    const at = await team('sync-mirror', 6201)
    const owner = await person(at, 73, true)
    // Installed first, then a row added: the row takes effect at once, in this isolate.
    await deliver('installation', { action: 'created', installation: { id: 7201, account: { id: 6201, login: 'sync-mirror', type: 'Organization' } } })
    await call(at.url, owner, 'GET', '/admin/sync')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-mirror/web', channel: 'prs', direction: 'mirror' })
    await deliver('issues', opened(7201, 'sync-mirror/web', 4, 'Mirror me'))
    const root = await until(at.id, async () => (await roots(at.url, owner, 'prs')).find((m) => m.text.includes('Mirror me')))

    await call(at.url, owner, 'POST', '/messages', { re: root.id, text: 'looking into it' })
    const comment = await until(at.id, async () => ((await (await fetch('https://outbound.test/sent')).json()) as { url: string; token: string; body: string }[]).find((one) => one.body.includes('looking into it')))
    expect(comment.url).toBe('https://api.github.com/repos/sync-mirror/web/issues/4/comments')
    expect(comment.token).toBe('ghs_installation_7201')
  })

  it("drops the sync App's events once it's uninstalled", async () => {
    const at = await team('sync-gone', 6301)
    const owner = await person(at, 74, true)
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-gone/web', channel: 'prs' })
    await deliver('installation', { action: 'created', installation: { id: 7301, account: { id: 6301, login: 'sync-gone', type: 'Organization' } } })
    expect(await (await deliver('installation', { action: 'deleted', installation: { id: 7301, account: { id: 6301, login: 'sync-gone', type: 'Organization' } } })).json()).toEqual({ ok: true, team: at.id })
    expect(await (await deliver('issues', opened(7301, 'sync-gone/web', 5, 'Too late'))).json()).toEqual({ ok: true, team: null })
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toMatchObject([{ provider: 'github', linked: false }])
  })

  it('takes the first event after a link made on another isolate, which this one never heard of', async () => {
    const at = await team('sync-elsewhere', 6701)
    const owner = await person(at, 77, true)
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-elsewhere/web', channel: 'prs' })
    // This isolate keeps the team as it is now, with no link...
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toMatchObject([{ linked: false }])
    // ...and another isolate takes the installation event, which forgets the host only there.
    await registry(env).link('github', 7701, 6701)
    expect((await deliver('issues', opened(7701, 'sync-elsewhere/web', 10, 'Right after'))).status).toBe(200)
    await until(at.id, async () => (await roots(at.url, owner, 'prs')).find((m) => m.text.includes('Right after')))
  })

  it("answers 200 to an event for a team that maps none of its repos yet, and hands it to no board", async () => {
    const at = await team('sync-unmapped', 6801)
    await deliver('installation', { action: 'created', installation: { id: 7801, account: { id: 6801, login: 'sync-unmapped', type: 'Organization' } } })
    const answer = await deliver('issues', opened(7801, 'sync-unmapped/web', 11, 'Not mapped'))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ ok: true, team: at.id, synced: false })
  })

  it("keeps the newer rows and the newer link of two views of a team, as a board's DO does", () => {
    const row = { provider: 'github', external: 'acme/www', channel: 'prs', direction: 'into' as const, by: 'x', created_at: '' }
    const older = { rows: [], version: 1, links: {}, linked_at: 1 }
    const rowsNewer = { rows: [row], version: 2, links: {}, linked_at: 1 }
    const linkNewer = { rows: [], version: 1, links: { github: '7' }, linked_at: 2 }
    // An isolate that kept the team longer hands over older rows or links: the newer of each stays.
    expect(newerSync(older, rowsNewer)).toEqual(rowsNewer)
    expect(newerSync(rowsNewer, linkNewer)).toEqual({ rows: [row], version: 2, links: { github: '7' }, linked_at: 2 })
    expect(newerSync(undefined, linkNewer)).toEqual(linkNewer)
  })

  it("drops events for a suspended team's board", async () => {
    const at = await team('sync-held', 6601)
    const owner = await person(at, 76, true)
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-held/web', channel: 'prs' })
    await deliver('installation', { action: 'created', installation: { id: 7601, account: { id: 6601, login: 'sync-held', type: 'Organization' } } })
    // The sign-in App's installation on the account (a dev team's is the account's ID) is suspended.
    await registry(env).setState(6601, 'suspended')
    expect(await (await deliver('issues', opened(7601, 'sync-held/web', 9, 'While held'))).json()).toEqual({ ok: true, team: null })
  })

  it("links no installation on an account with no team", async () => {
    expect(await (await deliver('installation', { action: 'created', installation: { id: 7401, account: { id: 6401, login: 'nobody', type: 'Organization' } } })).json()).toEqual({ ok: true, team: null })
    expect(await (await deliver('issues', opened(7401, 'nobody/web', 6, 'No team'))).json()).toEqual({ ok: true, team: null })
  })

  it("refuses a sync event that isn't signed with the sync App's secret, and one sent straight to a team", async () => {
    const at = await team('sync-forged', 6501)
    const owner = await person(at, 75, true)
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-forged/web', channel: 'prs' })
    await deliver('installation', { action: 'created', installation: { id: 7501, account: { id: 6501, login: 'sync-forged', type: 'Organization' } } })
    expect((await deliver('issues', opened(7501, 'sync-forged/web', 7, 'Forged'), { secret: 'hub-test-secret' })).status).toBe(401)
    expect((await deliver('issues', opened(7501, 'sync-forged/web', 8, 'Direct'), { url: `${at.url}/webhooks/github` })).status).toBe(404)
    await until(at.id, async () => true)
    expect(await roots(at.url, owner, 'prs')).toEqual([])
  })
})
