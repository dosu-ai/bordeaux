// Hosted sync as data (spec 09, "Sync, later"): two teams on one Worker, each with its own rows,
// its own installation of the sync App, and its own Linear and Slack workspaces, every platform answered
// by vitest.hosted.config.ts.
import { env, runDurableObjectAlarm, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { githubTeamSync, linearTeamSync, slackTeamSync } from '../../src/sync/index.ts'
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
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'jira', external: 'OPS', channel: 'ops' })).status).toBe(400)
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
    expect((await call(a.url, ownerA, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'github', linked: true, install: 'https://github.com/apps/bordeaux-ai-sync/installations/new' })

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

  it("refuses a repo the team's sync App can't see, and takes any of its repos before the App is installed", async () => {
    const at = await team('sync-seen', 6351)
    const owner = await person(at, 76, true)
    // Not installed yet: nothing to ask, so the row waits for the install.
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-seen/unseen-early', channel: 'prs' })).status).toBe(201)
    await deliver('installation', { action: 'created', installation: { id: 7351, account: { id: 6351, login: 'sync-seen', type: 'Organization' } } })
    const unseen = await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-seen/unseen-docs', channel: 'prs' })
    expect(unseen).toMatchObject({ status: 400, body: { error: { code: 'invalid_request', message: expect.stringContaining("the sync App can't see sync-seen/unseen-docs") } } })
    // GitHub finds a repo whatever its case, and upstream matches it only as GitHub writes it.
    expect(await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-seen/Web', channel: 'prs' })).toMatchObject({ status: 400, body: { error: { message: 'external: GitHub writes it sync-seen/web, so add that' } } })
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-seen/web', channel: 'prs' })).status).toBe(201)
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.sync.map((row: { external: string }) => row.external).sort()).toEqual(['sync-seen/unseen-early', 'sync-seen/web'])
  })

  it("refuses a public repo an App given only some repos wasn't given, and says in bdx health when one is taken away", async () => {
    const at = await team('sync-picked', 6352)
    const owner = await person(at, 77, true)
    await deliver('installation', { action: 'created', installation: { id: 7352, account: { id: 6352, login: 'sync-picked', type: 'Organization' } } })
    // sync-picked/docs is public, so GitHub shows it to any token; the App was given only web.
    expect(await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-picked/docs', channel: 'prs' })).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("the sync App can't see sync-picked/docs") } } })
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-picked/web', channel: 'prs' })).status).toBe(201)
    expect((await call(at.url, owner, 'GET', '/admin/health')).body.sync).toEqual([{ key: 'github', platform: 'github', ok: true }])
    // An admin takes web out of the App's repositories.
    await fetch('https://outbound.test/revoke', { method: 'POST', body: 'repo:sync-picked/web' })
    expect((await call(at.url, owner, 'GET', '/admin/health')).body.sync).toEqual([{ key: 'github', platform: 'github', ok: false, error: "the sync App can't see sync-picked/web: give it the repo" }])
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
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual(expect.objectContaining({ provider: 'github', linked: false }))
  })

  it('takes the first event after a link made on another isolate, which this one never heard of', async () => {
    const at = await team('sync-elsewhere', 6701)
    const owner = await person(at, 77, true)
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-elsewhere/web', channel: 'prs' })
    // This isolate keeps the team as it is now, with no link...
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual(expect.objectContaining({ provider: 'github', linked: false }))
    // ...and another isolate takes the installation event, which forgets the host only there.
    await registry(env).link('github', 7701, 6701)
    expect((await deliver('issues', opened(7701, 'sync-elsewhere/web', 10, 'Right after'))).status).toBe(200)
    await until(at.id, async () => (await roots(at.url, owner, 'prs')).find((m) => m.text.includes('Right after')))
  })

  it('shows an owner a link another isolate made at once: bdx sync add, link, and list, and bdx health', async () => {
    /** A team with a row, kept by this isolate with no link, then linked to the sync App by another isolate. */
    const linkedElsewhere = async (login: string, account: number, user: number) => {
      const at = await team(login, account)
      const owner = await person(at, user, true)
      expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: `${login}/web`, channel: 'prs' })).body).toMatchObject({ created: true, linked: false })
      // This isolate keeps the team as it is now, with no link...
      expect((await call(at.url, owner, 'GET', '/admin/boards')).status).toBe(200)
      // ...and another isolate takes the sync App's installation event, which forgets the host only there.
      await registry(env).link('github', account + 1000, account)
      return { at, owner }
    }

    // bdx sync add asks the App whether it sees the repo, and doesn't ask the owner to install it.
    const adding = await linkedElsewhere('sync-fresh-add', 6711, 81)
    expect(await call(adding.at.url, adding.owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-fresh-add/unseen-docs', channel: 'prs' })).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("the sync App can't see sync-fresh-add/unseen-docs") } } })
    const added = await linkedElsewhere('sync-fresh-added', 6712, 82)
    const answer = await call(added.at.url, added.owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-fresh-added/api', channel: 'prs' })
    expect(answer).toMatchObject({ status: 201, body: { created: true, linked: true } })
    expect(answer.body.install).toBeUndefined()

    const linking = await linkedElsewhere('sync-fresh-link', 6713, 83)
    expect((await call(linking.at.url, linking.owner, 'POST', '/admin/sync/link', { provider: 'github' })).body).toMatchObject({ linked: true })
    const listing = await linkedElsewhere('sync-fresh-list', 6714, 84)
    expect((await call(listing.at.url, listing.owner, 'GET', '/admin/sync')).body.providers).toContainEqual(expect.objectContaining({ provider: 'github', linked: true }))
    const checking = await linkedElsewhere('sync-fresh-health', 6715, 85)
    expect((await call(checking.at.url, checking.owner, 'GET', '/admin/health')).body.sync).toEqual([{ key: 'github', platform: 'github', ok: true }])
  })

  it('shows an owner an unlink another isolate made at once: bdx sync add and bdx health', async () => {
    /** A team with a row, kept by this isolate linked to the sync App, then unlinked by another isolate. */
    const unlinkedElsewhere = async (login: string, account: number, user: number) => {
      const at = await team(login, account)
      const owner = await person(at, user, true)
      await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: `${login}/web`, channel: 'prs' })
      await registry(env).link('github', account + 1000, account)
      // This isolate keeps the team linked...
      expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual(expect.objectContaining({ provider: 'github', linked: true }))
      // ...and another isolate takes the sync App's uninstall, which forgets the host only there.
      await registry(env).unlink('github', account + 1000)
      return { at, owner }
    }

    const adding = await unlinkedElsewhere('sync-gone-add', 6721, 86)
    expect(await call(adding.at.url, adding.owner, 'POST', '/admin/sync', { provider: 'github', external: 'sync-gone-add/api', channel: 'prs' })).toMatchObject({ status: 201, body: { created: true, linked: false, install: 'https://github.com/apps/bordeaux-ai-sync/installations/new' } })
    const checking = await unlinkedElsewhere('sync-gone-health', 6722, 87)
    expect((await call(checking.at.url, checking.owner, 'GET', '/admin/health')).body.sync).toEqual([{ key: 'github', platform: 'github', ok: false, error: 'not linked: bdx sync link github' }])
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

/** An event from the Linear app, signed as Linear signs it, `age` milliseconds old (or with no time, unless `stamped`), to the hub or straight to `url`. */
async function linearEvent(payload: Record<string, unknown>, { secret = 'linear-hook-secret', url = `${HUB}/__bordeaux/linear/events`, age = 0, stamped = true } = {}) {
  const body = JSON.stringify({ ...(stamped ? { webhookTimestamp: Date.now() - age } : {}), webhookId: 'wh-test', ...payload })
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, '0')).join('')
  const headers = { 'linear-signature': mac, 'linear-delivery': crypto.randomUUID(), 'linear-event': String(payload.type), 'content-type': 'application/json' }
  return SELF.fetch(url, { method: 'POST', headers, body })
}

/** Linear's `Issue` `create` for issue `identifier` of workspace `org`, made by a person. */
const issueCreated = (org: string, identifier: string, title: string) => ({
  type: 'Issue',
  action: 'create',
  organizationId: org,
  url: `https://linear.app/${org}/issue/${identifier}`,
  actor: { id: 'user-ada', name: 'Ada', type: 'user' },
  data: { id: crypto.randomUUID(), identifier, title, description: `${title}, in detail`, url: `https://linear.app/${org}/issue/${identifier}`, team: { id: 'team-id', key: identifier.split('-')[0] }, state: { name: 'Todo', type: 'unstarted' }, priority: 0, labels: [], creatorId: 'user-ada' },
})

/** Links a team to Linear workspace `org` as its owner would: asks for a link, and Linear sends the admin back with `code`. */
async function linkLinear(at: { url: string }, owner: string, code: string) {
  const { body } = await call(at.url, owner, 'POST', '/admin/sync/link', { provider: 'linear' })
  const state = new URL(body.install).searchParams.get('state')!
  return SELF.fetch(`${HUB}/sync/linear/callback?code=${code}&state=${state}`)
}

/** What the Linear app sent Linear: comments, and token requests. */
const toLinear = async () => ((await (await fetch('https://outbound.test/sent')).json()) as { url: string; token: string; body: string }[]).filter((one) => one.url.startsWith('https://api.linear.app/'))

describe('hosted Linear sync', () => {
  it('stays off quietly before the Linear app is set up, and says which setting is missing when some are', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(linearTeamSync({} as never)).toBeNull()
      expect(errors).not.toHaveBeenCalled()
      expect(linearTeamSync({ LINEAR_SYNC_CLIENT_ID: 'x' } as never)).toBeNull()
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('LINEAR_SYNC_CLIENT_SECRET, LINEAR_SYNC_WEBHOOK_SECRET, BORDEAUX_SYNC_KEY'))
    } finally {
      errors.mockRestore()
    }
  })

  it("takes Linear team keys as Linear writes them, and gives owners alone a link of their own", async () => {
    const at = await team('linear-rows', 8001)
    const member = await person(at, 81, false)
    const owner = await person(at, 82, true)
    for (const external of ['eng', 'ENG-1', 'acme/eng']) expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'linear', external, channel: 'eng' })).status, external).toBe(400)
    const added = await call(at.url, owner, 'POST', '/admin/sync', { provider: 'linear', external: 'ENG', channel: 'eng' })
    expect(added).toMatchObject({ status: 201, body: { created: true, linked: false } })
    const install = new URL(added.body.install)
    expect(install.origin + install.pathname).toBe('https://linear.app/oauth/authorize')
    expect(Object.fromEntries(install.searchParams)).toMatchObject({ client_id: 'linear-test-client', redirect_uri: 'https://board.test/sync/linear/callback', actor: 'app', response_type: 'code' })
    expect(install.searchParams.get('state')).toMatch(new RegExp(`^${at.id}\\.[0-9a-f]{64}$`))
    // Each link is its own: one asked for again has another ticket.
    const again = (await call(at.url, owner, 'POST', '/admin/sync/link', { provider: 'linear' })).body.install
    expect(new URL(again).searchParams.get('state')).not.toBe(install.searchParams.get('state'))
    // Anyone on the board sees whether it's linked, and no link to approve.
    expect(await call(at.url, member, 'POST', '/admin/sync/link', { provider: 'linear' })).toMatchObject({ status: 403 })
    expect((await call(at.url, member, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'linear', linked: false })
  })

  it("links the workspace whose admin approved an owner's link, once per link", async () => {
    const at = await team('linear-link', 8002)
    const owner = await person(at, 83, true)
    const { body } = await call(at.url, owner, 'POST', '/admin/sync/link', { provider: 'linear' })
    const state = new URL(body.install).searchParams.get('state')!
    // A ticket the team's directory never made links nothing.
    expect((await SELF.fetch(`${HUB}/sync/linear/callback?code=code-linka&state=${at.id}.${'0'.repeat(64)}`)).status).toBe(400)
    const linked = await SELF.fetch(`${HUB}/sync/linear/callback?code=code-linka&state=${state}`)
    expect(linked.status).toBe(200)
    expect(await linked.text()).toContain('Workspace linka')
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'linear', linked: true })
    // The same link twice is refused: its ticket was taken.
    expect((await SELF.fetch(`${HUB}/sync/linear/callback?code=code-linka&state=${state}`)).status).toBe(400)
  })

  it("lands a workspace's issue on its own team's board only, and only by that team's rows", async () => {
    const a = await team('linear-a', 8101)
    const b = await team('linear-b', 8102)
    const ownerA = await person(a, 84, true)
    const ownerB = await person(b, 85, true)
    expect((await linkLinear(a, ownerA, 'code-orga')).status).toBe(200)
    expect((await linkLinear(b, ownerB, 'code-orgb')).status).toBe(200)
    // Both map their workspace's ENG to channel `eng`.
    await call(a.url, ownerA, 'POST', '/admin/sync', { provider: 'linear', external: 'ENG', channel: 'eng' })
    await call(b.url, ownerB, 'POST', '/admin/sync', { provider: 'linear', external: 'ENG', channel: 'eng' })

    expect((await linearEvent(issueCreated('orga', 'ENG-1', 'A is broken'))).status).toBe(200)
    expect((await linearEvent(issueCreated('orgb', 'ENG-2', 'B is broken'))).status).toBe(200)
    // A team key A has no row for lands nowhere.
    expect((await linearEvent(issueCreated('orga', 'OPS-3', 'A ops'))).status).toBe(200)
    const root = await until(a.id, async () => (await roots(a.url, ownerA, 'eng')).find((m) => m.text.includes('A is broken')))
    expect(root.text).toContain('ENG-1')
    // A row is `into` unless it says `mirror`: a reply on the board stays there.
    await call(a.url, ownerA, 'POST', '/messages', { re: root.id, text: 'into only' })
    await until(b.id, async () => (await roots(b.url, ownerB, 'eng')).find((m) => m.text.includes('B is broken')))
    await until(a.id, async () => true)
    expect((await roots(a.url, ownerA, 'eng')).map((m) => m.text).join('\n')).not.toMatch(/B is broken|A ops/)
    expect((await roots(b.url, ownerB, 'eng')).map((m) => m.text).join('\n')).not.toMatch(/A is broken|A ops/)
    expect((await toLinear()).some((one) => one.body.includes('into only'))).toBe(false)
  })

  it("mirrors a board reply back with the team's own token, refreshed once when it's about to expire", async () => {
    const at = await team('linear-mirror', 8201)
    const owner = await person(at, 86, true)
    // Linked with a token that expires within the minute: the first call to Linear refreshes it.
    await linkLinear(at, owner, 'code-orgm-expiring')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'linear', external: 'MIR', channel: 'mir', direction: 'mirror' })
    await linearEvent(issueCreated('orgm', 'MIR-1', 'Mirror me'))
    const root = await until(at.id, async () => (await roots(at.url, owner, 'mir')).find((m) => m.text.includes('Mirror me')))

    await call(at.url, owner, 'POST', '/messages', { re: root.id, text: 'looking into it' })
    const comment = await until(at.id, async () => (await toLinear()).find((one) => one.url.endsWith('#commentCreate') && one.body.includes('looking into it')))
    expect(comment.token).toBe('lin_orgm_2')
    // A new row builds the board again, with an adapter that asks the team's directory afresh: it
    // kept the tokens the refresh gave, so there's no refresh to do.
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'linear', external: 'OPS', channel: 'ops' })
    await call(at.url, owner, 'POST', '/messages', { re: root.id, text: 'fixed it' })
    const second = await until(at.id, async () => (await toLinear()).find((one) => one.url.endsWith('#commentCreate') && one.body.includes('fixed it')))
    expect(second.token).toBe('lin_orgm_2')
    // One refresh: the refresh token Linear took once was never sent again.
    expect((await toLinear()).filter((one) => one.url.endsWith('/oauth/token') && one.token.startsWith('ref_orgm_'))).toHaveLength(1)
  })

  it("uses a token while it lasts once Linear refuses its refresh, never asks again, and tells the team's owners to link again", async () => {
    const at = await team('linear-dead', 8202)
    const owner = await person(at, 87, true)
    // Linked with a token about to expire whose refresh token Linear won't take.
    await linkLinear(at, owner, 'code-orgd-dead')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'linear', external: 'DED', channel: 'ded', direction: 'mirror' })
    await linearEvent(issueCreated('orgd', 'DED-1', 'Dead refresh'))
    const root = await until(at.id, async () => (await roots(at.url, owner, 'ded')).find((m) => m.text.includes('Dead refresh')))
    for (const text of ['first reply', 'second reply']) {
      await call(at.url, owner, 'POST', '/messages', { re: root.id, text })
      const comment = await until(at.id, async () => (await toLinear()).find((one) => one.url.endsWith('#commentCreate') && one.body.includes(text)))
      expect(comment.token, text).toBe('lin_orgd_1')
    }
    // Every call to Linear asked the directory for a token about to expire: Linear was asked to refresh it once.
    expect((await toLinear()).filter((one) => one.url.endsWith('/oauth/token') && one.token.startsWith('ref_orgd_'))).toHaveLength(1)
    // The link is over, though its last token still works: bdx sync list and bdx health say so.
    const relink = 'Linear refused the refresh token: bdx sync link linear'
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'linear', linked: true, refused: relink })
    expect((await call(at.url, owner, 'GET', '/admin/health')).body.sync).toContainEqual({ key: 'linear', platform: 'linear', ok: false, error: relink })
    // An owner links it again: it syncs, and nothing says otherwise.
    await linkLinear(at, owner, 'code-orgd')
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'linear', linked: true })
    expect((await call(at.url, owner, 'GET', '/admin/health')).body.sync).toContainEqual({ key: 'linear', platform: 'linear', ok: true })
  })

  it("never uses one workspace's tokens for another the team is linked to", async () => {
    const at = await team('linear-crossed', 8203)
    const owner = await person(at, 92, true)
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'linear', external: 'ENG', channel: 'eng', direction: 'mirror' })
    await linkLinear(at, owner, 'code-orgy')
    // Two links approved at once can leave the registry naming one workspace and the directory
    // holding the other's tokens: here, the registry links orgz, and the tokens are orgy's.
    await registry(env).linkTeam('linear', 'orgz', at.id)
    const before = (await toLinear()).length
    expect((await linearEvent(issueCreated('orgz', 'ENG-1', 'Crossed'))).status).toBe(200)
    for (let run = 0; run < 3; run++) await until(at.id, async () => true)
    // orgz's issue doesn't come in through orgy's token, and nothing goes to Linear as orgy.
    expect((await toLinear()).slice(before).filter((one) => one.token.startsWith('lin_orgy_'))).toEqual([])
    expect((await roots(at.url, owner, 'eng')).map((m) => m.text).join('\n')).not.toContain('Crossed')
  })

  it("unlinks a workspace that removes the app, and moves one linked again to the team that linked it", async () => {
    const a = await team('linear-left', 8301)
    const b = await team('linear-took', 8302)
    const ownerA = await person(a, 88, true)
    const ownerB = await person(b, 89, true)
    await call(a.url, ownerA, 'POST', '/admin/sync', { provider: 'linear', external: 'ENG', channel: 'eng' })
    await call(b.url, ownerB, 'POST', '/admin/sync', { provider: 'linear', external: 'ENG', channel: 'eng' })
    await linkLinear(a, ownerA, 'code-orgx')
    // B's owner links the same workspace: it syncs with B now, and A loses it.
    await linkLinear(b, ownerB, 'code-orgx')
    expect((await call(a.url, ownerA, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'linear', linked: false })
    expect((await linearEvent(issueCreated('orgx', 'ENG-7', 'Moved'))).status).toBe(200)
    await until(b.id, async () => (await roots(b.url, ownerB, 'eng')).find((m) => m.text.includes('Moved')))
    await until(a.id, async () => true)
    expect((await roots(a.url, ownerA, 'eng')).map((m) => m.text).join('\n')).not.toContain('Moved')

    // The app removed from the workspace, in an event with no time of its own: B is unlinked, and its events go nowhere.
    expect(await (await linearEvent({ type: 'OAuthApp', action: 'revoked', organizationId: 'orgx', oauthClientId: 'linear-test-client' }, { stamped: false })).json()).toEqual({ ok: true, team: b.id })
    expect((await call(b.url, ownerB, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'linear', linked: false })
    expect(await (await linearEvent(issueCreated('orgx', 'ENG-8', 'Too late'))).json()).toEqual({ ok: true, team: null })
  })

  it('answers 200 to an event for a team that maps none of its Linear teams yet', async () => {
    const at = await team('linear-none', 8401)
    const owner = await person(at, 90, true)
    await linkLinear(at, owner, 'code-orgn')
    expect(await (await linearEvent(issueCreated('orgn', 'ENG-1', 'Nowhere'))).json()).toEqual({ ok: true, team: at.id, synced: false })
  })

  it("refuses a Linear event that isn't signed with the app's secret, one over a minute old, and one sent straight to a team", async () => {
    const at = await team('linear-forged', 8501)
    const owner = await person(at, 91, true)
    await linkLinear(at, owner, 'code-orgf')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'linear', external: 'ENG', channel: 'eng' })
    expect((await linearEvent(issueCreated('orgf', 'ENG-1', 'Forged'), { secret: 'not-the-secret' })).status).toBe(401)
    expect((await linearEvent(issueCreated('orgf', 'ENG-2', 'Stale'), { age: 120_000 })).status).toBe(401)
    expect((await linearEvent(issueCreated('orgf', 'ENG-3', 'Direct'), { url: `${at.url}/webhooks/linear` })).status).toBe(404)
  })
})

/** A request from the Slack app, signed as Slack signs it, `age` seconds old, to the hub or straight to `url`. */
async function slackEvent(payload: Record<string, unknown>, { secret = 'slack-signing-secret', url = `${HUB}/__bordeaux/slack/events`, age = 0 } = {}) {
  const body = JSON.stringify(payload)
  const timestamp = String(Math.floor(Date.now() / 1000) - age)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`))), (b) => b.toString(16).padStart(2, '0')).join('')
  const headers = { 'x-slack-signature': `v0=${mac}`, 'x-slack-request-timestamp': timestamp, 'content-type': 'application/json' }
  return SELF.fetch(url, { method: 'POST', headers, body })
}

let slackTs = 0
/** Slack's event for workspace `team`: `inner` in the envelope Slack sends it in. */
const slackEnvelope = (team: string, inner: Record<string, unknown>) => ({
  token: 'legacy',
  team_id: team,
  api_app_id: 'A0SLACK',
  type: 'event_callback',
  event_id: `Ev${++slackTs}`,
  event_time: Math.floor(Date.now() / 1000),
  authorizations: [{ team_id: team, user_id: 'UBOT', is_bot: true, enterprise_id: null }],
  event: inner,
})

/** A message by person UADA in channel `channel` of workspace `team`: the envelope, and the message's ts. */
function slackMessage(team: string, channel: string, text: string) {
  const ts = `${Math.floor(Date.now() / 1000)}.${String(++slackTs).padStart(6, '0')}`
  return { ts, payload: slackEnvelope(team, { type: 'message', channel, channel_type: 'channel', user: 'UADA', text, ts, event_ts: ts, team }) }
}

/** Links a team to Slack workspace `code-<team>` names, as its owner would: asks for a link, and Slack sends the admin back with `code`. */
async function linkSlack(at: { url: string }, owner: string, code: string) {
  const { body } = await call(at.url, owner, 'POST', '/admin/sync/link', { provider: 'slack' })
  const state = new URL(body.install).searchParams.get('state')!
  return SELF.fetch(`${HUB}/sync/slack/callback?code=${code}&state=${state}`)
}

/** What the Slack app sent Slack's Web API. */
const toSlack = async () => ((await (await fetch('https://outbound.test/sent')).json()) as { url: string; token: string; body: string }[]).filter((one) => one.url.startsWith('https://slack.com/api/'))
/** The messages the Slack app posted, as Slack's Web API took them: their text is `markdown_text`, or `text`. */
const slackPosts = async (method = 'chat.postMessage') =>
  (await toSlack())
    .filter((one) => one.url.endsWith(`/${method}`))
    .map((one) => Object.fromEntries(new URLSearchParams(one.body)) as Record<string, string>)
    .map((form) => ({ ...form, text: form.markdown_text ?? form.text ?? '' }) as Record<string, string> & { text: string })

describe('hosted Slack sync', () => {
  it('stays off quietly before the Slack app is set up, and says which setting is missing when some are', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(slackTeamSync({} as never)).toBeNull()
      expect(errors).not.toHaveBeenCalled()
      expect(slackTeamSync({ SLACK_SYNC_CLIENT_ID: 'x' } as never)).toBeNull()
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('SLACK_SYNC_CLIENT_SECRET, SLACK_SYNC_SIGNING_SECRET, BORDEAUX_SYNC_KEY'))
    } finally {
      errors.mockRestore()
    }
  })

  it("takes Slack channels by ID or #name, and gives owners alone a link to install the app with", async () => {
    const at = await team('slack-rows', 9001)
    const member = await person(at, 101, false)
    const owner = await person(at, 102, true)
    for (const external of ['support', '#Support', 'c0abcdefgh', 'acme/web', '#has space']) expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external, channel: 'support' })).status, external).toBe(400)
    expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external: 'C0ABCDEFGH', channel: 'support' })).status).toBe(201)
    const added = await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external: '#support', channel: 'support' })
    expect(added).toMatchObject({ status: 201, body: { created: true, linked: false } })
    const install = new URL(added.body.install)
    expect(install.origin + install.pathname).toBe('https://slack.com/oauth/v2/authorize')
    expect(Object.fromEntries(install.searchParams)).toMatchObject({ client_id: 'slack-test-client', redirect_uri: 'https://board.test/sync/slack/callback' })
    expect(install.searchParams.get('scope')!.split(',')).toEqual(expect.arrayContaining(['channels:history', 'chat:write', 'reactions:read']))
    expect(install.searchParams.get('state')).toMatch(new RegExp(`^${at.id}\\.[0-9a-f]{64}$`))
    expect(await call(at.url, member, 'POST', '/admin/sync/link', { provider: 'slack' })).toMatchObject({ status: 403 })
    expect((await call(at.url, member, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'slack', linked: false })
  })

  it("refuses a channel the linked app can't see or isn't in, saying how to fix it, and takes any before it's linked", async () => {
    const at = await team('slack-unseen', 9004)
    const owner = await person(at, 113, true)
    const add = (external: string) => call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external, channel: 'unseen' })
    // Before the app is linked there's no token to ask with: the row is taken, and health says it later.
    expect((await add('C0OUTSIDE1')).status).toBe(201)
    await call(at.url, owner, 'DELETE', '/admin/sync?provider=slack&external=C0OUTSIDE1')
    await linkSlack(at, owner, 'code-TU')
    // No such channel, no such name, or archived: Slack has none the app can see.
    for (const external of ['C0MISSING1', '#nowhere', 'C0ARCHIVE1']) {
      expect(await add(external), external).toMatchObject({ status: 400, body: { error: { code: 'invalid_request', message: expect.stringContaining(`Slack has no channel ${external} the app can see`) } } })
    }
    // A channel the bot isn't in, by ID or by name: invite it, by the bot's own name.
    expect(await add('C0OUTSIDE1')).toMatchObject({ status: 400, body: { error: { message: "external: the app isn't in #outside (C0OUTSIDE1). /invite @bordeaux there, then add it again" } } })
    expect(await add('#outside')).toMatchObject({ status: 400, body: { error: { message: "external: the app isn't in #outside. /invite @bordeaux there, then add it again" } } })
    expect((await add('C0NAMED001')).status).toBe(201)
    expect((await add('#support')).status).toBe(201)
    // Slack not answering takes the row: the owner shouldn't wait out an outage.
    await fetch('https://outbound.test/revoke', { method: 'POST', body: 'down:xoxb-TU-1' })
    expect((await add('C0MISSING1')).status).toBe(201)
  })

  it("answers Slack's URL check itself, only when the app signed it", async () => {
    const check = { token: 'legacy', type: 'url_verification', challenge: 'c-hosted-1' }
    const answer = await slackEvent(check)
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ challenge: 'c-hosted-1' })
    expect((await slackEvent(check, { secret: 'not-the-secret' })).status).toBe(401)
  })

  it("links the workspace that installed the app from an owner's link, once per link", async () => {
    const at = await team('slack-link', 9002)
    const owner = await person(at, 103, true)
    const { body } = await call(at.url, owner, 'POST', '/admin/sync/link', { provider: 'slack' })
    const state = new URL(body.install).searchParams.get('state')!
    expect((await SELF.fetch(`${HUB}/sync/slack/callback?code=code-TLINK&state=${at.id}.${'0'.repeat(64)}`)).status).toBe(400)
    // An admin who cancels comes back with Slack's error.
    expect((await SELF.fetch(`${HUB}/sync/slack/callback?error=access_denied&state=${state}`)).status).toBe(400)
    const linked = await SELF.fetch(`${HUB}/sync/slack/callback?code=code-TLINK&state=${state}`)
    expect(linked.status).toBe(200)
    expect(await linked.text()).toContain('Workspace TLINK')
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'slack', linked: true })
    expect((await SELF.fetch(`${HUB}/sync/slack/callback?code=code-TLINK&state=${state}`)).status).toBe(400)
  })

  it('refuses an install on a whole Grid org, and a token that expires, saying what to do instead of asking again', async () => {
    const at = await team('slack-refused', 9003)
    const owner = await person(at, 111, true)
    const grid = await linkSlack(at, owner, 'code-grid')
    expect(grid.status).toBe(400)
    expect(await grid.text()).toContain('install it on one workspace')
    const rotating = await linkSlack(at, owner, 'code-TROT-rotating')
    expect(rotating.status).toBe(400)
    expect(await rotating.text()).toContain('token rotation is on')
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'slack', linked: false })
  })

  it("lands a workspace's message on its own team's board only, by that team's rows, by ID or #name", async () => {
    const a = await team('slack-a', 9101)
    const b = await team('slack-b', 9102)
    const ownerA = await person(a, 104, true)
    const ownerB = await person(b, 105, true)
    expect((await linkSlack(a, ownerA, 'code-TA')).status).toBe(200)
    expect((await linkSlack(b, ownerB, 'code-TB')).status).toBe(200)
    // A maps a channel by its ID, B by its name; the same channel ID in each workspace.
    await call(a.url, ownerA, 'POST', '/admin/sync', { provider: 'slack', external: 'C0NAMED001', channel: 'support' })
    await call(b.url, ownerB, 'POST', '/admin/sync', { provider: 'slack', external: '#support', channel: 'support' })

    expect((await slackEvent(slackMessage('TA', 'C0NAMED001', 'A needs help').payload)).status).toBe(200)
    expect((await slackEvent(slackMessage('TB', 'C0NAMED001', 'B needs help').payload)).status).toBe(200)
    // A channel A has no row for lands nowhere.
    expect((await slackEvent(slackMessage('TA', 'C0OTHER0001', 'A elsewhere').payload)).status).toBe(200)
    const root = await until(a.id, async () => (await roots(a.url, ownerA, 'support')).find((m) => m.text.includes('A needs help')))
    // A row is `into` unless it says `mirror`: a reply on the board stays there.
    await call(a.url, ownerA, 'POST', '/messages', { re: root.id, text: 'into only' })
    await until(b.id, async () => (await roots(b.url, ownerB, 'support')).find((m) => m.text.includes('B needs help')))
    await until(a.id, async () => true)
    expect((await roots(a.url, ownerA, 'support')).map((m) => m.text).join('\n')).not.toMatch(/B needs help|A elsewhere/)
    expect((await roots(b.url, ownerB, 'support')).map((m) => m.text).join('\n')).not.toMatch(/A needs help|A elsewhere/)
    expect((await slackPosts()).some((post) => post.text.includes('into only'))).toBe(false)
  })

  it("mirrors a board reply into the Slack thread with the team's own bot token", async () => {
    const at = await team('slack-mirror', 9201)
    const owner = await person(at, 106, true)
    await linkSlack(at, owner, 'code-TM')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external: 'C0MIRROR01', channel: 'mir', direction: 'mirror' })
    const { ts, payload } = slackMessage('TM', 'C0MIRROR01', 'Mirror me')
    await slackEvent(payload)
    const root = await until(at.id, async () => (await roots(at.url, owner, 'mir')).find((m) => m.text.includes('Mirror me')))
    await call(at.url, owner, 'POST', '/messages', { re: root.id, text: 'looking into it' })
    const post = await until(at.id, async () => (await slackPosts()).find((one) => one.text.includes('looking into it')))
    expect(post).toMatchObject({ token: 'xoxb-TM-1', channel: 'C0MIRROR01', thread_ts: ts })
    expect(post.text).toContain('looking into it')
  })

  it("lands a Slack reaction on the board at once while Slack limits the channel's history reads", async () => {
    const at = await team('slack-react', 9202)
    const owner = await person(at, 112, true)
    await linkSlack(at, owner, 'code-TR')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external: 'C0LIMITED1', channel: 'busy' })
    const { ts, payload } = slackMessage('TR', 'C0LIMITED1', 'React to me')
    await slackEvent(payload)
    const root = await until(at.id, async () => (await roots(at.url, owner, 'busy')).find((m) => m.text.includes('React to me')))
    // The adapter asks conversations.replies for the reacted message's thread; Slack says wait a minute.
    await slackEvent(slackEnvelope('TR', { type: 'reaction_added', user: 'UADA', reaction: 'eyes', item: { type: 'message', channel: 'C0LIMITED1', ts }, item_user: 'UADA', event_ts: ts }))
    const reacted = await until(at.id, async () => {
      const found = (await roots(at.url, owner, 'busy')).find((m) => m.id === root.id) as { reactions?: Record<string, string[]> } | undefined
      return found?.reactions?.eyes?.length ? found : null
    })
    expect(Object.keys(reacted.reactions!)).toEqual(['eyes'])
  })

  it("unlinks a workspace that uninstalls the app or revokes its bot token, and moves one installed again to the team that linked it", async () => {
    const a = await team('slack-left', 9301)
    const b = await team('slack-took', 9302)
    const ownerA = await person(a, 107, true)
    const ownerB = await person(b, 108, true)
    await call(a.url, ownerA, 'POST', '/admin/sync', { provider: 'slack', external: 'C0MOVED001', channel: 'moved' })
    await call(b.url, ownerB, 'POST', '/admin/sync', { provider: 'slack', external: 'C0MOVED001', channel: 'moved' })
    await linkSlack(a, ownerA, 'code-TX')
    await linkSlack(b, ownerB, 'code-TX')
    expect((await call(a.url, ownerA, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'slack', linked: false })
    expect((await slackEvent(slackMessage('TX', 'C0MOVED001', 'Moved').payload)).status).toBe(200)
    await until(b.id, async () => (await roots(b.url, ownerB, 'moved')).find((m) => m.text.includes('Moved')))
    await until(a.id, async () => true)
    expect((await roots(a.url, ownerA, 'moved')).map((m) => m.text).join('\n')).not.toContain('Moved')

    // A person's token revoked leaves the link; the app's bot token revoked ends it.
    expect((await slackEvent(slackEnvelope('TX', { type: 'tokens_revoked', tokens: { oauth: ['UADA'], bot: [] } }))).status).toBe(200)
    expect((await call(b.url, ownerB, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'slack', linked: true })
    expect(await (await slackEvent(slackEnvelope('TX', { type: 'tokens_revoked', tokens: { bot: ['UBOT'] } }))).json()).toEqual({ ok: true, team: b.id })
    expect((await call(b.url, ownerB, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'slack', linked: false })
    expect(await (await slackEvent(slackMessage('TX', 'C0MOVED001', 'Too late').payload)).json()).toEqual({ ok: true, team: null })

    // Installed again, then uninstalled.
    await linkSlack(b, ownerB, 'code-TX')
    expect(await (await slackEvent(slackEnvelope('TX', { type: 'app_uninstalled' }))).json()).toEqual({ ok: true, team: b.id })
    expect((await call(b.url, ownerB, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'slack', linked: false })
  })

  it('answers 200 to an event for a team that maps none of its Slack channels yet', async () => {
    const at = await team('slack-none', 9401)
    const owner = await person(at, 109, true)
    await linkSlack(at, owner, 'code-TN')
    expect(await (await slackEvent(slackMessage('TN', 'C0NOWHERE1', 'Nowhere').payload)).json()).toEqual({ ok: true, team: at.id, synced: false })
  })

  it("refuses a Slack event that isn't signed with the app's secret, one over 5 minutes old, and one sent straight to a team", async () => {
    const at = await team('slack-forged', 9501)
    const owner = await person(at, 110, true)
    await linkSlack(at, owner, 'code-TF')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external: 'C0FORGED01', channel: 'forged' })
    // An uninstall the hub acts on itself: forged, or replayed after 5 minutes, it unlinks nothing.
    expect((await slackEvent(slackEnvelope('TF', { type: 'app_uninstalled' }), { secret: 'not-the-secret' })).status).toBe(401)
    expect((await slackEvent(slackEnvelope('TF', { type: 'app_uninstalled' }), { age: 360 })).status).toBe(401)
    expect((await call(at.url, owner, 'GET', '/admin/sync')).body.providers).toContainEqual({ provider: 'slack', linked: true })
    expect((await slackEvent(slackMessage('TF', 'C0FORGED01', 'Forged').payload, { secret: 'not-the-secret' })).status).toBe(401)
    expect((await slackEvent(slackMessage('TF', 'C0FORGED01', 'Stale').payload, { age: 360 })).status).toBe(401)
    expect((await slackEvent(slackMessage('TF', 'C0FORGED01', 'Direct').payload, { url: `${at.url}/webhooks/slack` })).status).toBe(404)
    await until(at.id, async () => true)
    expect(await roots(at.url, owner, 'forged')).toEqual([])
  })
})

describe("a hosted team's health and redaction, by its own sync", () => {
  it("shows an owner whether each platform the team syncs still answers its link, and says which doesn't and why", async () => {
    const at = await team('health-rows', 9601)
    const owner = await person(at, 120, true)
    const checked = async () => ((await call(at.url, owner, 'GET', '/admin/health')).body.sync as { key: string; ok: boolean; error?: string }[]).sort((a, b) => a.key.localeCompare(b.key))
    // A row on a platform the team hasn't linked reaches nothing yet.
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'linear', external: 'HLT', channel: 'hlt' })
    expect(await checked()).toEqual([{ key: 'linear', platform: 'linear', ok: false, error: 'not linked: bdx sync link linear' }])
    await deliver('installation', { action: 'created', installation: { id: 7601, account: { id: 9601, login: 'health-rows', type: 'Organization' } } })
    await linkLinear(at, owner, 'code-orgh')
    await linkSlack(at, owner, 'code-TH')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'github', external: 'health-rows/web', channel: 'hlt' })
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external: 'C0HEALTH01', channel: 'hlt' })
    expect((await checked()).map(({ key, ok }) => ({ key, ok }))).toEqual([{ key: 'github', ok: true }, { key: 'linear', ok: true }, { key: 'slack', ok: true }])
    // Linear down, Slack rate-limiting: nothing for an owner to link again.
    for (const token of ['down:lin_orgh_1', 'down:xoxb-TH-1']) await fetch('https://outbound.test/revoke', { method: 'POST', body: token })
    expect((await checked()).filter((one) => !one.ok)).toEqual([
      { key: 'linear', platform: 'linear', ok: false, error: "Linear didn't answer: Service unavailable" },
      { key: 'slack', platform: 'slack', ok: false, error: "Slack didn't answer: ratelimited" },
    ])
    // Each platform's admin takes the app away: the App uninstalled, the tokens revoked.
    for (const token of ['installation:7601', 'lin_orgh_1', 'xoxb-TH-1']) await fetch('https://outbound.test/revoke', { method: 'POST', body: token })
    expect(await checked()).toEqual([
      { key: 'github', platform: 'github', ok: false, error: "the sync App isn't installed: bdx sync link github" },
      { key: 'linear', platform: 'linear', ok: false, error: 'Linear refused the token: bdx sync link linear' },
      { key: 'slack', platform: 'slack', ok: false, error: 'Slack refused the token: bdx sync link slack' },
    ])
    // Each fits bdx health's row in 80 columns.
    for (const { error } of await checked()) expect(`sync      ${'github'.padEnd(12)} ${error}`.length).toBeLessThanOrEqual(80)
  })

  it("shows an owner each Slack channel the app can't see or isn't in, as added before it was linked", async () => {
    const at = await team('health-slack', 9603)
    const owner = await person(at, 122, true)
    const slack = async () => ((await call(at.url, owner, 'GET', '/admin/health')).body.sync as { key: string; error?: string }[]).find((one) => one.key === 'slack')
    for (const external of ['C0MISSING1', 'C0OUTSIDE1', '#support']) expect((await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external, channel: 'hlt' })).status).toBe(201)
    await linkSlack(at, owner, 'code-THS')
    expect(await slack()).toEqual({ key: 'slack', platform: 'slack', ok: false, error: "no Slack channel C0MISSING1 the app can see; the app isn't in #outside: /invite @bordeaux there" })
    await call(at.url, owner, 'DELETE', '/admin/sync?provider=slack&external=C0MISSING1')
    const outside = await slack()
    expect(outside).toEqual({ key: 'slack', platform: 'slack', ok: false, error: "the app isn't in #outside: /invite @bordeaux there" })
    expect(`sync      ${'slack'.padEnd(12)} ${outside?.error}`.length).toBeLessThanOrEqual(80)
    await call(at.url, owner, 'DELETE', '/admin/sync?provider=slack&external=C0OUTSIDE1')
    expect(await slack()).toEqual({ key: 'slack', platform: 'slack', ok: true })
  })

  it('asks the platform a synced message came from to delete it there, with the team’s own token', async () => {
    const at = await team('redact-rows', 9602)
    const owner = await person(at, 121, true)
    await linkSlack(at, owner, 'code-TD')
    await call(at.url, owner, 'POST', '/admin/sync', { provider: 'slack', external: 'C0REDACT01', channel: 'leaks' })
    const { ts, payload } = slackMessage('TD', 'C0REDACT01', 'my key is hunter2')
    await slackEvent(payload)
    const leaked = await until(at.id, async () => (await roots(at.url, owner, 'leaks')).find((m) => m.text.includes('hunter2')))
    const { body } = await call(at.url, owner, 'POST', `/admin/messages/${leaked.id}/redact`, { reason: 'a secret', everywhere: true })
    // Slack lets a bot delete only its own messages, and says so: the owner deletes it there.
    expect(body.everywhere).toMatchObject({ deleted: false, target: `slack:C0REDACT01:${ts}`, error: expect.stringContaining('cant_delete_message') })
    expect((await slackPosts('chat.delete')).find((one) => one.ts === ts)).toMatchObject({ token: 'xoxb-TD-1', channel: 'C0REDACT01' })
  })
})
