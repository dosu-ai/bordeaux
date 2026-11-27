import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { hub } from '../../src/worker/hub.ts'
import { registry } from '../../src/worker/registry.ts'
import { configure } from '../../src/worker/config.ts'
import { githubTeamSync, linearTeamSync, slackTeamSync } from '../../src/sync/index.ts'

const HUB = new URL('https://board.test')

/** An RSA key in PKCS#1, as GitHub hands out an App's. */
async function appKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer)
  return `-----BEGIN RSA PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8.slice(26)))}\n-----END RSA PRIVATE KEY-----`
}

/** GitHub's App API, faked at `fetch`: installations it knows, by ID. */
function github(installations: Record<number, { id: number; login: string; type: string }>) {
  const asked: string[] = []
  const send = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    asked.push(url)
    const found = /^https:\/\/api\.github\.com\/app\/installations\/(\d+)$/.exec(url)
    if (found && installations[Number(found[1])]) return Response.json({ id: Number(found[1]), account: installations[Number(found[1])] })
    return Response.json({ message: 'Not Found' }, { status: 404 })
  }) as typeof fetch
  return { send, asked }
}

const setup = async (query: string, send: typeof fetch) => hub(new Request(`${HUB.origin}/setup?${query}`), { ...env, GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: await appKey() }, HUB, send)

/** An installation event, signed as GitHub signs it with the App's webhook secret. */
async function deliver(kind: string, payload: unknown, secret = 'hub-test-secret') {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), (b) => b.toString(16).padStart(2, '0')).join('')
  return SELF.fetch(`${HUB.origin}/__bordeaux/github/events`, { method: 'POST', headers: { 'x-github-event': kind, 'x-hub-signature-256': `sha256=${mac}`, 'content-type': 'application/json' }, body })
}

describe('signing up', () => {
  it('shows a page at the hub that links to installing the App', async () => {
    const response = await SELF.fetch(`${HUB.origin}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('https://github.com/apps/bordeaux-ai/installations/new')
  })

  it('shows the steps from installing the App to a first post, with the hub’s own hosts', async () => {
    const page = await (await SELF.fetch(`${HUB.origin}/`)).text()
    for (const step of ['a board for your GitHub org at <code>https://&#60;github-org&#62;.board.test</code>', 'npm i -g @dosu/bordeaux', 'bdx login https://&#60;login&#62;.board.test', 'bdx post general', 'href="/llms.txt"']) expect(page).toContain(step)
  })

  it('gives an agent the same steps at /llms.txt, saying which two the person does', async () => {
    const response = await SELF.fetch(`${HUB.origin}/llms.txt`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const text = await response.text()
    for (const step of ['curl -s https://<login>.board.test/', 'https://github.com/apps/bordeaux-ai/installations/new', 'npm i -g @dosu/bordeaux', 'bdx login https://<login>.board.test', 'bdx doctor']) expect(text).toContain(step)
    expect(text).toContain('Two steps need the person: installing the GitHub App, and approving the sign-in.')
    const named = { ...env, BORDEAUX_TERMS_URL: 'https://board.test/terms', BORDEAUX_PRIVACY_URL: 'https://board.test/privacy' }
    expect(await (await hub(new Request(`${HUB.origin}/llms.txt`), named, HUB)).text()).toContain('Terms of Service (https://board.test/terms) and Privacy Policy (https://board.test/privacy)')
    expect(text).not.toContain('Terms of Service')
  })

  it('shows an owner how to sync each platform the deployment syncs with, on the page and at /llms.txt', async () => {
    const page = await (await SELF.fetch(`${HUB.origin}/`)).text()
    expect(page).toContain('<h2>Sync GitHub, Linear, or Slack</h2>')
    for (const row of ['bdx sync add github acme/web prs --mirror', 'bdx sync add linear ENG eng', 'bdx sync add slack support support --mirror', 'bdx sync list']) expect(page).toContain(row)
    const text = await (await SELF.fetch(`${HUB.origin}/llms.txt`)).text()
    expect(text).toContain('## Sync GitHub, Linear, or Slack')
    for (const step of ['bdx sync add github <owner/repo> <channel> [--mirror]', 'bdx sync add linear <team key> <channel> [--mirror]', 'bdx sync add slack <name or C0…> <channel> [--mirror]', '- Slack: a workspace admin opens it within 10 minutes and installs the app, then someone in the channel invites', 'bdx health']) expect(text).toContain(step)

    try {
      configure((env) => ({ teamSync: { github: githubTeamSync(env), linear: null } }))
      const github = await (await hub(new Request(`${HUB.origin}/llms.txt`), env, HUB)).text()
      expect(github).toContain('## Sync GitHub\n')
      expect(github).not.toContain('Linear')
      configure({})
      expect(await (await hub(new Request(`${HUB.origin}/`), env, HUB)).text()).not.toContain('bdx sync')
      expect(await (await hub(new Request(`${HUB.origin}/llms.txt`), env, HUB)).text()).not.toContain('bdx sync')
    } finally {
      configure((env) => ({ teamSync: { github: githubTeamSync(env), linear: linearTeamSync(env), slack: slackTeamSync(env) } }))
    }
  })

  it('says installing agrees to the terms and privacy policy, when the deployment names both', async () => {
    const named = { ...env, BORDEAUX_TERMS_URL: 'https://board.test/terms', BORDEAUX_PRIVACY_URL: 'https://board.test/privacy' }
    const page = await (await hub(new Request(`${HUB.origin}/`), named, HUB)).text()
    expect(page).toContain('By installing the App, you agree to the <a href="https://board.test/terms">Terms of Service</a> and <a href="https://board.test/privacy">Privacy Policy</a>.')
    for (const one of [{ ...env, BORDEAUX_TERMS_URL: 'https://board.test/terms' }, env]) {
      expect(await (await hub(new Request(`${HUB.origin}/`), one, HUB)).text()).not.toContain('you agree')
    }
  })

  it('makes the team from /setup by asking GitHub, as the App, whose installation it is, then sends the owner to it', async () => {
    const fake = github({ 9001: { id: 3001, login: 'Setup-Org', type: 'Organization' } })
    const response = await setup('installation_id=9001&setup_action=install', fake.send)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://setup-org.board.test/')
    expect(fake.asked).toEqual(['https://api.github.com/app/installations/9001'])
    expect(await registry(env).byInstallation(9001)).toMatchObject({ github: { id: 3001, login: 'Setup-Org', type: 'Organization' }, state: 'active' })
  })

  it("makes no team for an installation that isn't the App's", async () => {
    const response = await setup('installation_id=9404&setup_action=install', github({}).send)
    expect(response.status).toBe(404)
    expect(await registry(env).byInstallation(9404)).toBeNull()
  })

  it('makes one team whether /setup or the installation event comes first', async () => {
    const account = { id: 3002, login: 'race', type: 'Organization' }
    expect((await deliver('installation', { action: 'created', installation: { id: 9002, account } })).status).toBe(200)
    const fake = github({ 9002: account })
    const response = await setup('installation_id=9002&setup_action=install', fake.send)
    expect(response.headers.get('location')).toBe('https://race.board.test/')
    // The team was there already: GitHub wasn't asked.
    expect(fake.asked).toEqual([])

    const other = { id: 3003, login: 'race-two', type: 'User' }
    await setup('installation_id=9003&setup_action=install', github({ 9003: other }).send)
    const before = await registry(env).byInstallation(9003)
    await deliver('installation', { action: 'created', installation: { id: 9003, account: other } })
    expect(await registry(env).byInstallation(9003)).toEqual(before)
  })

  it("refuses an event that isn't signed with the App's webhook secret", async () => {
    const response = await deliver('installation', { action: 'created', installation: { id: 9004, account: { id: 3004, login: 'forged', type: 'Organization' } } }, 'not-the-secret')
    expect(response.status).toBe(401)
    expect(await registry(env).byInstallation(9004)).toBeNull()
  })

  it('suspends, restores, and uninstalls a team as its installation does', async () => {
    const account = { id: 3005, login: 'lifecycle', type: 'Organization' }
    await deliver('installation', { action: 'created', installation: { id: 9005, account } })
    const board = 'https://lifecycle.board.test/channels'
    await deliver('installation', { action: 'suspend', installation: { id: 9005 } })
    expect(await (await SELF.fetch(board)).json()).toMatchObject({ error: { code: 'team_suspended' } })
    await deliver('installation', { action: 'unsuspend', installation: { id: 9005 } })
    expect((await SELF.fetch(board)).status).toBe(401)
    await deliver('installation', { action: 'deleted', installation: { id: 9005 } })
    expect(await (await SELF.fetch(board)).json()).toMatchObject({ error: { code: 'team_uninstalled' } })
  })

  it('applies the newest of an installation\'s events, whichever order they arrive in', async () => {
    const account = { id: 3007, login: 'ordered', type: 'Organization' }
    await deliver('installation', { action: 'created', installation: { id: 9007, account } })
    await deliver('installation', { action: 'suspend', installation: { id: 9007, updated_at: '2026-11-26T10:00:02Z' } })
    // The unsuspend that came before the suspend, delivered late.
    await deliver('installation', { action: 'unsuspend', installation: { id: 9007, updated_at: '2026-11-26T10:00:01Z' } })
    expect(await registry(env).byInstallation(9007)).toMatchObject({ state: 'suspended' })
  })

  it('makes no team for an enterprise account', async () => {
    const enterprise = { id: 3008, login: 'big-co', type: 'Enterprise' }
    const response = await setup('installation_id=9008&setup_action=install', github({ 9008: enterprise }).send)
    expect(response.status).toBe(400)
    await deliver('installation', { action: 'created', installation: { id: 9008, account: enterprise } })
    expect(await registry(env).byInstallation(9008)).toBeNull()
  })

  it("asks the person to try /setup again when GitHub doesn't answer", async () => {
    const down = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch
    const response = await setup('installation_id=9009&setup_action=install', down)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('/setup?installation_id=9009')
  })

  it("refuses a signed event whose body isn't JSON", async () => {
    expect((await deliver('installation', 'payload=%7B%7D')).status).toBe(400)
  })

  it("follows a person's rename, which comes as installation_target", async () => {
    await deliver('installation', { action: 'created', installation: { id: 9010, account: { id: 3010, login: 'old-me', type: 'User' } } })
    await deliver('installation_target', { action: 'renamed', target_type: 'User', account: { id: 3010, login: 'new-me' }, installation: { id: 9010 } })
    expect(await registry(env).byInstallation(9010)).toMatchObject({ host: 'old-me.board.test', github: { login: 'new-me', type: 'User' } })
  })

  it("follows an org's rename without moving its host", async () => {
    await deliver('installation', { action: 'created', installation: { id: 9006, account: { id: 3006, login: 'before', type: 'Organization' } } })
    await deliver('organization', { action: 'renamed', organization: { id: 3006, login: 'after' }, installation: { id: 9006 } })
    expect(await registry(env).byInstallation(9006)).toMatchObject({ host: 'before.board.test', github: { login: 'after' } })
  })
})
