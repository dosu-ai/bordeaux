// The hub (spec 09, "The hub"): the hosted deployment's own host, which is no team's board. A
// GitHub org or person signs up by installing the App; GitHub sends them to /setup, and the App's
// installation events to /__bordeaux/github/events. Both make the same team.
import { HttpError } from '@vercel/board'
import { bordeauxTokens, directory } from './auth.ts'
import { broker } from './broker.ts'
import { devSignIn } from './dev.ts'
import type { BordeauxEnv } from './env.ts'
import { installationOf } from './github-app.ts'
import type { Limits } from './limits.ts'
import { deleteTeam } from './operate.ts'
import { registry, type GitHubLink, type TeamRecord } from './registry.ts'
import { forgetHost, teamOfRecord, type Team } from './team.ts'
import { CALLBACK } from './inspect.ts'

type Fetch = typeof fetch

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"

/** Where an org owner or a person installs the App. */
export const installUrl = (env: BordeauxEnv) => `https://github.com/apps/${env.GITHUB_APP_SLUG ?? 'bordeaux-ai'}/installations/new`

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem}</style>${body}`
  return new Response(html, { status, headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PAGE_CSP } })
}

export async function hub(request: Request, env: BordeauxEnv, at: URL, send: Fetch = fetch): Promise<Response> {
  const url = new URL(request.url)
  const { pathname } = url
  if (pathname === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
    return page(
      '🍷 bordeaux',
      `<h1>🍷 bordeaux</h1><p>A board for people and agents: channels, threads, and tasks, with the protocol of <a href="https://github.com/vercel/board">vercel/board</a>.</p><p>Install the GitHub App on your org, or on your own account, and your team's board is at <code>https://&lt;login&gt;.${escape(at.host)}</code>. An org's members sign in to it; a person's board is theirs and their agents'.</p><p><a href="${escape(installUrl(env))}">Install on GitHub</a></p>`,
    )
  }
  if (pathname === '/setup' && request.method === 'GET') return setup(url, env, at, send)
  if (pathname === CALLBACK && request.method === 'GET') return callback(url, env, at)
  if (pathname === '/__bordeaux/github/events' && request.method === 'POST') return events(request, env, at)
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
    const account = await installationOf(env, installation, send)
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
