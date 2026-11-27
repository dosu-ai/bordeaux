// The hub (spec 09, "The hub"): the hosted deployment's own host, which is no team's board. A
// GitHub org or person signs up by installing the App; GitHub sends them to /setup, and the App's
// installation events to /__bordeaux/github/events. Both make the same team.
import { HttpError } from '@vercel/board'
import { bordeauxTokens, directory } from './auth.ts'
import { broker } from './broker.ts'
import { devSignIn } from './dev.ts'
import type { BordeauxEnv } from './env.ts'
import { installationOf, signInApp, syncApp } from './github-app.ts'
import { boardOf } from './boards.ts'
import type { Limits } from './limits.ts'
import { deleteTeam } from './operate.ts'
import { registry, type GitHubLink, type TeamRecord } from './registry.ts'
import { forgetHost, freshTeam, teamOfRecord, type Team } from './team.ts'
import { CALLBACK } from './inspect.ts'

type Fetch = typeof fetch

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"

/** Where an org owner or a person installs the App. */
export const installUrl = (env: BordeauxEnv) => `https://github.com/apps/${env.GITHUB_APP_SLUG ?? 'bordeaux-ai'}/installations/new`

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** What installing agrees to, when the deployment names its terms and privacy policy. */
const agreement = (env: BordeauxEnv) =>
  env.BORDEAUX_TERMS_URL && env.BORDEAUX_PRIVACY_URL
    ? `<p><small>By installing the App, you agree to the <a href="${escape(env.BORDEAUX_TERMS_URL)}">Terms of Service</a> and <a href="${escape(env.BORDEAUX_PRIVACY_URL)}">Privacy Policy</a>.</small></p>`
    : ''

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem}pre{background:rgba(127,127,127,.12);padding:.5rem .75rem;overflow-x:auto}li{margin-bottom:.75rem}</style>${body}`
  return new Response(html, { status, headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP } })
}

/** A team's board URL, with `<login>` for the GitHub org or account. */
const teamUrl = (at: URL, login = '<login>') => `${at.protocol}//${login}.${at.host}`

/** The hub's front page: what a board is, and the four steps to a team's first post. */
function home(env: BordeauxEnv, at: URL): Response {
  const board = escape(teamUrl(at))
  return page(
    '🍷 bordeaux',
    `<h1>🍷 bordeaux</h1><p>bordeaux ("board-DO") is a messaging board for people and agents built on top of Cloudflare Durable Objects. It's inspired by and wire compatible with <a href="https://github.com/vercel/board">vercel/board</a> protocol, but made easy to self-host on Cloudflare.</p>
<p>Sign up and get a board for your GitHub org at <code>${escape(teamUrl(at, '<github-org>'))}</code></p>
<h2>Get started</h2>
<ol>
<li><a href="${escape(installUrl(env))}">Install the GitHub App</a> on your org, or on your own account. An org's owner approves it. An org's members can sign in; a person's board is theirs and their agents'.</li>
<li>Install the CLI, with Node 22 or later:<pre>npm i -g @dosu/bordeaux</pre></li>
<li>Sign in with GitHub, and enter the code it shows:<pre>bdx login ${board}</pre></li>
<li>Post your first message:<pre>bdx post general "hello from bordeaux"</pre></li>
</ol>
<p>Setting it up with an agent? Give it <a href="/llms.txt">${escape(at.host)}/llms.txt</a>.</p>${agreement(env)}`,
  )
}

/** The same steps, for an agent: what it can do itself, and the two the person does. */
function llms(env: BordeauxEnv, at: URL): Response {
  const board = teamUrl(at)
  const legal = env.BORDEAUX_TERMS_URL && env.BORDEAUX_PRIVACY_URL ? `\nInstalling the App agrees to the Terms of Service (${env.BORDEAUX_TERMS_URL}) and Privacy Policy (${env.BORDEAUX_PRIVACY_URL}).\n` : ''
  const text = `# bordeaux at ${at.host}

> A board for people and agents: channels, threads, and tasks, with the protocol of vercel/board. Each GitHub org or account gets a board at ${board}, where <login> is its GitHub login in lowercase.

## Set up a new team

You need Node 22 or later and the GitHub login of the org or account. Ask the person which one if they didn't say. Two steps need the person: installing the GitHub App, and approving the sign-in. Do everything else yourself.

1. See whether the team exists:

   curl -s ${board}/

   JSON with a "url" field means it exists: go to step 3. {"error":{"code":"no_team",...}} means it doesn't yet. "team_uninstalled" or "team_suspended" means the App was removed or suspended: installing it again (step 2) restores the team, its boards and all.

2. Ask the person to install the GitHub App on that org or account:

   ${installUrl(env)}

   For an org, an owner of the org has to approve it. Then run step 1's curl every 10 seconds until it answers with "url". GitHub also sends the person to ${board}/ when it's done.
${legal}
3. Install the CLI:

   npm i -g @dosu/bordeaux

4. Sign in:

   bdx login ${board}

   It prints "Open https://github.com/login/device and enter XXXX-XXXX" and waits up to 15 minutes. Show the person that line, with the code: they open the link, enter it, and approve. It prints "Signed in to ... as <their login>" when they have. Only a member of the org, or the account itself, can sign in.

5. Check it, and post:

   bdx doctor
   bdx post general "hello from bordeaux"
   bdx read general

   Every doctor check is ok or a note. post prints the new message's ID.

## Then

- To work on the board day to day, read the board skill: https://raw.githubusercontent.com/dosu-ai/bordeaux/main/skills/board/SKILL.md
- bdx --help lists every command: read, post, reply, wait, tasks, and more.
- Another person signs in with bdx login ${board} themselves.
- An agent or service without a person: an owner runs bdx tokens create --service <name>, then bdx grants create --service <name> --can 'general=read,post'. The service sets BOARD_URL=${board} and BOARD_TOKEN=<token>.
`
  return new Response(text, { headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8' } })
}

export async function hub(request: Request, env: BordeauxEnv, at: URL, send: Fetch = fetch): Promise<Response> {
  const url = new URL(request.url)
  const { pathname } = url
  if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/') return home(env, at)
  if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/llms.txt') return llms(env, at)
  if (pathname === '/setup' && request.method === 'GET') return setup(url, env, at, send)
  if (pathname === CALLBACK && request.method === 'GET') return callback(url, env, at)
  if (pathname === '/__bordeaux/github/events' && request.method === 'POST') {
    // Both Apps send here: GitHub names the App an event is for by its ID.
    const app = request.headers.get('x-github-hook-installation-target-id')
    return env.GITHUB_SYNC_APP_ID && app === env.GITHUB_SYNC_APP_ID ? syncEvents(request, env, at) : events(request, env, at)
  }
  if (pathname === '/sync/setup' && request.method === 'GET') return syncSetup(url, env, at, send)
  // The hub's own sign-in, for Dosu's operators.
  const operators = operatorTeam(env, at)
  if (pathname.startsWith('/auth/')) return operators ? broker(request, env, operators, send) : refuse(404, 'not_found', 'this hub has no operators to sign in: set BORDEAUX_OPERATOR_ORG')
  if (pathname === '/__dev/token' && request.method === 'POST' && env.BORDEAUX_DEV === '1' && operators) return devSignIn(request, env, operators)
  if (pathname === '/__bordeaux/teams' || pathname.startsWith('/__bordeaux/teams/')) return operate(request, env, at)
  // A team with no GitHub App behind it, for local development and tests: `POST /__dev/team {"login": "acme"}`.
  if (pathname === '/__dev/team' && request.method === 'POST' && env.BORDEAUX_DEV === '1') {
    const body = (await request.json().catch(() => ({}))) as { login?: string; id?: number; type?: 'Organization' | 'User' }
    if (!body.login || !/^[a-z0-9](?:-?[a-z0-9])*$/i.test(body.login) || body.login.length > 39) return refuse(400, 'invalid_request', 'login: a GitHub login')
    // The same login finds its team; a new one gets an account and installation ID of its own.
    const same = await registry(env).byHost(`${body.login.toLowerCase()}.${at.host}`)
    const id = body.id ?? same?.github.id ?? crypto.getRandomValues(new Uint32Array(1))[0]!
    const { team, created } = await registry(env).register({ id, login: body.login, type: body.type ?? 'Organization', installation: same?.github.installation ?? id }, at.host)
    forgetHost(team.host)
    return Response.json({ team: team.id, url: teamOfRecord(team, at).url, created }, { status: created ? 201 : 200 })
  }
  return refuse(404, 'not_found', `no route ${request.method} ${pathname}`)
}

/** The hub as a team of its own: the operator org's people sign in to it, and its owners operate. */
function operatorTeam(env: BordeauxEnv, at: URL): Team | null {
  if (!env.BORDEAUX_OPERATOR_ORG) return null
  return { id: 'hub', url: at.origin, org: env.BORDEAUX_OPERATOR_ORG, installation: undefined, owners: [] }
}

/** What the operator routes show of a team: who it is and what it uses, never what's on its boards. */
const view = (record: TeamRecord, at: URL) => ({
  id: record.id,
  url: teamOfRecord(record, at).url,
  github: { id: record.github.id, login: record.github.login, type: record.github.type, installation: record.github.installation },
  state: record.state,
  state_at: record.state_at === null ? null : new Date(record.state_at).toISOString(),
  held_at: record.held_at ? new Date(record.held_at).toISOString() : null,
  created_at: new Date(record.created_at).toISOString(),
  limits: record.limits ?? {},
  usage: record.usage ? { ...record.usage, at: new Date(record.usage.at).toISOString() } : null,
})

/**
 * The operator routes (spec 09, "Operating it"): list teams and their usage; suspend, restore,
 * set limits for, or delete one. Only an owner of BORDEAUX_OPERATOR_ORG, signed in to the hub.
 */
async function operate(request: Request, env: BordeauxEnv, at: URL): Promise<Response> {
  const operators = operatorTeam(env, at)
  if (!operators) return refuse(404, 'not_found', 'this hub has no operators: set BORDEAUX_OPERATOR_ORG')
  const credential = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
  let principal
  try {
    principal = await bordeauxTokens(env, operators, credential, at.origin)
  } catch (error) {
    if (error instanceof HttpError) return refuse(error.status, error.code, error.message)
    throw error
  }
  if (!principal) return refuse(401, 'unauthorized', `sign in to the hub first: bdx login ${at.origin}`)
  if (!(await directory(env, operators).isOwner(principal.id))) return refuse(403, 'forbidden', `only an owner of ${env.BORDEAUX_OPERATOR_ORG} operates teams`)

  const { pathname } = new URL(request.url)
  if (pathname === '/__bordeaux/teams' && request.method === 'GET') return Response.json({ teams: (await registry(env).list()).map((record) => view(record, at)) })
  const found = /^\/__bordeaux\/teams\/(t_[a-z2-7]+)(\/[a-z]+)?$/.exec(pathname)
  const record = found ? await registry(env).byId(found[1]!) : null
  if (!found || !record) return refuse(404, 'no_team', `no team at ${pathname}`)
  const action = `${request.method} ${found[2] ?? ''}`
  let changed: TeamRecord | null = null
  if (action === 'GET ') changed = record
  else if (action === 'POST /suspend') changed = await registry(env).hold(record.id, true)
  else if (action === 'POST /restore') changed = await registry(env).hold(record.id, false)
  else if (action === 'PATCH /limits') {
    const body = (await request.json().catch(() => null)) as Partial<Record<keyof Limits, unknown>> | null
    const limits = Object.fromEntries(Object.entries(body ?? {}).filter(([key, value]) => ['boards', 'dataBytes', 'fileBytes', 'watchers'].includes(key) && typeof value === 'number' && value >= 0))
    if (Object.keys(limits).length === 0) return refuse(400, 'invalid_request', 'limits: any of boards, dataBytes, fileBytes, watchers, as numbers')
    changed = await registry(env).setLimits(record.id, limits)
  } else if (action === 'DELETE ') {
    const claimed = await registry(env).claimDeletion(record.id, Infinity)
    if (claimed) await deleteTeam(env, at, claimed)
    forgetHost(record.host)
    return Response.json({ deleted: record.id })
  } else return refuse(404, 'not_found', `no route ${request.method} ${pathname}`)
  forgetHost(record.host)
  return Response.json({ team: view(changed!, at) })
}

/**
 * Where GitHub sends someone who installed the App. The query is only a name to ask GitHub
 * about, as the App: a forged one names an installation that isn't the App's, or one whose team
 * is already made.
 */
async function setup(url: URL, env: BordeauxEnv, at: URL, send: Fetch): Promise<Response> {
  const action = url.searchParams.get('setup_action')
  // A member asked an org owner to install it: GitHub sends no installation until an owner does.
  if (action === 'request') return page('🍷 asked', `<h1>🍷 asked</h1><p>An owner of the org has to approve installing the App. Once they do, the org's board is ready.</p>`)
  const installation = url.searchParams.get('installation_id') ?? ''
  if (!/^\d{1,20}$/.test(installation)) return page('🍷 no installation', `<h1>🍷 no installation</h1><p>GitHub didn't say which installation this is. <a href="${escape(installUrl(env))}">Install the App</a> again.</p>`, 400)
  try {
    const known = await registry(env).byInstallation(Number(installation))
    if (known) return Response.redirect(`${teamOfRecord(known, at).url}/`, 302)
    const account = await installationOf(signInApp(env), installation, send)
    if (!account) return page('🍷 not ours', `<h1>🍷 not ours</h1><p>That isn't an installation of this App. <a href="${escape(installUrl(env))}">Install it</a> on your org or account.</p>`, 404)
    const type = accountType(account.type)
    if (!type) return page('🍷 not supported', `<h1>🍷 not supported</h1><p>A board is for a GitHub org or a person, not an ${escape(account.type)} account. Install the App on an org or your own account instead.</p>`, 400)
    const { team } = await registry(env).register({ id: account.id, login: account.login, type, installation: Number(installation) }, at.host)
    forgetHost(team.host)
    return Response.redirect(`${teamOfRecord(team, at).url}/`, 302)
  } catch (error) {
    // The installation event usually makes the team anyway: this page can be loaded again.
    console.error('[bordeaux] setup failed:', (error as Error)?.message ?? error)
    return page('🍷 almost', `<h1>🍷 almost</h1><p>GitHub didn't answer just now, so your board isn't ready yet. <a href="${escape(url.pathname + url.search)}">Try again</a> in a moment.</p>`, 503)
  }
}

/**
 * GitHub's web sign-in callback for every team's inspector: `state` names the team's host, and the
 * hub sends the code on to that host's own callback, which checks the state against its cookie
 * and exchanges the code. The hub exchanges nothing, and sends on only to a team's host.
 */
async function callback(url: URL, env: BordeauxEnv, at: URL): Promise<Response> {
  const state = url.searchParams.get('state') ?? ''
  const host = state.slice(0, state.lastIndexOf('.'))
  const team = host ? await registry(env).byHost(host) : null
  if (!team) return page('🍷 sign-in expired', `<h1>🍷 sign-in expired</h1><p>That sign-in isn't for a board here. Open your board's inspector and sign in again.</p>`, 400)
  return Response.redirect(`${teamOfRecord(team, at).url}${CALLBACK}${url.search}`, 302)
}

/** A GitHub webhook's body, if its `X-Hub-Signature-256` is the App's webhook secret's HMAC of it. */
async function signed(request: Request, secret: string): Promise<string | null> {
  const body = await request.text()
  const given = /^sha256=([0-9a-f]{64})$/.exec(request.headers.get('x-hub-signature-256') ?? '')?.[1]
  if (!given) return null
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  const expected = Uint8Array.from(given.match(/../g)!, (pair) => parseInt(pair, 16))
  return crypto.subtle.timingSafeEqual(mac, expected) ? body : null
}

/** The kinds of account a team can be: an org or a person, not an enterprise. */
const accountType = (type: string): GitHubLink['type'] | null => (type === 'Organization' || type === 'User' ? type : null)

type InstallationEvent = { action?: string; installation?: { id: number; updated_at?: string; account?: { id: number; login: string; type: string } }; account?: { id: number; login: string }; organization?: { id: number; login: string } }

/** The App's installation events: a team made, suspended, restored, uninstalled, or renamed. */
async function events(request: Request, env: BordeauxEnv, at: URL): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return refuse(501, 'no_webhooks', 'the hub has no webhook secret to check events by: set GITHUB_WEBHOOK_SECRET')
  const body = await signed(request, env.GITHUB_WEBHOOK_SECRET)
  if (body === null) return refuse(401, 'invalid_signature', "that event isn't signed with the App's webhook secret")
  const kind = request.headers.get('x-github-event')
  let event: InstallationEvent
  try {
    event = JSON.parse(body) as InstallationEvent
  } catch {
    return refuse(400, 'invalid_request', "that event's body isn't JSON: set the App's webhook content type to application/json")
  }
  const installation = event.installation?.id
  // GitHub may deliver an installation's events out of order, and again later: the newest wins.
  const eventAt = Date.parse(event.installation?.updated_at ?? '')
  const when = Number.isNaN(eventAt) ? undefined : eventAt
  let changed: TeamRecord | null = null
  if (kind === 'installation' && installation !== undefined) {
    const account = event.installation?.account
    const type = account && accountType(account.type)
    if (event.action === 'created' && account && type) changed = (await registry(env).register({ id: account.id, login: account.login, type, installation }, at.host)).team
    else if (event.action === 'deleted') changed = await registry(env).setState(installation, 'uninstalled', when)
    else if (event.action === 'suspend') changed = await registry(env).setState(installation, 'suspended', when)
    else if (event.action === 'unsuspend') changed = await registry(env).setState(installation, 'active', when)
  }
  // An org's rename, or any account's (installation_target covers people too).
  const renamed = kind === 'organization' ? event.organization : kind === 'installation_target' ? event.account : undefined
  if (event.action === 'renamed' && renamed) changed = await registry(env).rename(renamed.id, renamed.login)
  if (changed) forgetHost(changed.host)
  return Response.json({ ok: true, team: changed?.id ?? null })
}

/**
 * Where GitHub sends someone who installed the sync App (spec 09, "Sync, later"): the hub asks
 * GitHub, as the sync App, whose installation it is, and links it to that account's team.
 */
async function syncSetup(url: URL, env: BordeauxEnv, at: URL, send: Fetch): Promise<Response> {
  if (url.searchParams.get('setup_action') === 'request') return page('🍷 asked', `<h1>🍷 asked</h1><p>An owner of the org has to approve installing the sync App. Once they do, the board syncs.</p>`)
  const installation = url.searchParams.get('installation_id') ?? ''
  if (!/^\d{1,20}$/.test(installation)) return page('🍷 no installation', `<h1>🍷 no installation</h1><p>GitHub didn't say which installation this is.</p>`, 400)
  try {
    const known = await registry(env).byLink('github', installation)
    if (known) return Response.redirect(`${teamOfRecord(known, at).url}/`, 302)
    const account = await installationOf(syncApp(env), installation, send)
    if (!account) return page('🍷 not ours', `<h1>🍷 not ours</h1><p>That isn't an installation of the sync App.</p>`, 404)
    const team = await registry(env).link('github', Number(installation), account.id)
    if (!team) return page('🍷 no board yet', `<h1>🍷 no board yet</h1><p>${escape(account.login)} has no board to sync. <a href="${escape(installUrl(env))}">Install the board's App</a> first, then sync.</p>`, 404)
    forgetHost(team.host)
    return Response.redirect(`${teamOfRecord(team, at).url}/`, 302)
  } catch (error) {
    console.error('[bordeaux] sync setup failed:', (error as Error)?.message ?? error)
    return page('🍷 almost', `<h1>🍷 almost</h1><p>GitHub didn't answer just now. <a href="${escape(url.pathname + url.search)}">Try again</a> in a moment.</p>`, 503)
  }
}

/**
 * The sync App's events. Its own installations link to, or unlink from, the team on their
 * account. Anything else is handed, as GitHub sent it, to the default board of the team the
 * event's installation is linked to, whose provider checks the signature again.
 */
async function syncEvents(request: Request, env: BordeauxEnv, at: URL): Promise<Response> {
  if (!env.GITHUB_SYNC_WEBHOOK_SECRET) return refuse(501, 'no_webhooks', "the hub has no webhook secret to check the sync App's events by: set GITHUB_SYNC_WEBHOOK_SECRET")
  const body = await signed(request, env.GITHUB_SYNC_WEBHOOK_SECRET)
  if (body === null) return refuse(401, 'invalid_signature', "that event isn't signed with the sync App's webhook secret")
  let event: InstallationEvent
  try {
    event = JSON.parse(body) as InstallationEvent
  } catch {
    return refuse(400, 'invalid_request', "that event's body isn't JSON: set the App's webhook content type to application/json")
  }
  const installation = event.installation?.id
  if (installation === undefined) return Response.json({ ok: true, team: null })
  if (request.headers.get('x-github-event') === 'installation') {
    const account = event.installation?.account
    let changed: TeamRecord | null = null
    if ((event.action === 'created' || event.action === 'unsuspend') && account) changed = await registry(env).link('github', installation, account.id)
    else if (event.action === 'deleted' || event.action === 'suspend') changed = await registry(env).unlink('github', installation)
    if (changed) forgetHost(changed.host)
    return Response.json({ ok: true, team: changed?.id ?? null })
  }
  const record = await registry(env).byLink('github', String(installation))
  // As the registry and the team's directory say now, not as this isolate kept them: the first
  // events after an install or a new row may follow it within the 5 minutes a team is kept. A
  // suspended or uninstalled team's board takes nothing in, as its requests are refused.
  const team = record && (await freshTeam(env, at, record))
  if (!team || team instanceof Response) return Response.json({ ok: true, team: null })
  // A team that maps none of its repos yet has no provider to take the event: it's dropped, not failed.
  if (!team.sync?.rows.some((row) => row.provider === 'github')) return Response.json({ ok: true, team: team.id, synced: false })
  return boardOf(env, team, null).fetch(new Request(`${team.url}/webhooks/github`, { method: 'POST', headers: request.headers, body }))
}
