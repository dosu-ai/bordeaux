// Hosted mode's tests (spec 09): every team on one Worker, at its own subdomain of the hub.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/** What each platform was sent, with the token it came with, for a test to read at `https://outbound.test/sent`. */
const sent: { method: string; url: string; token: string; body: string }[] = []

/**
 * Tokens a test revoked, as an admin would on the platform: `POST https://outbound.test/revoke`
 * with the token. `down:<token>` makes the platform fail that token's calls as in an outage.
 */
const revoked = new Set<string>()

/**
 * GitHub's API as the sync App sees it: an installation token for each installation, named by
 * it, its bot from GraphQL's `viewer`, and comments taken and recorded.
 */
async function syncApp(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.href === 'https://outbound.test/sent') return Response.json(sent)
  if (url.href === 'https://outbound.test/revoke' && request.method === 'POST') return revoked.add(await request.text()), new Response(null, { status: 204 })
  // An installation, as the App asks about it; one a test revoked (`installation:<id>`) was uninstalled.
  const installation = /^\/app\/installations\/(\d+)$/.exec(url.pathname)
  if (url.hostname === 'api.github.com' && installation && request.method === 'GET')
    return revoked.has(`installation:${installation[1]}`) ? Response.json({ message: 'Not Found' }, { status: 404 }) : Response.json({ id: Number(installation[1]), account: { id: 1, login: 'acme', type: 'Organization' } })
  const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
  if (url.hostname === 'api.github.com' && minting && request.method === 'POST')
    return Response.json({ token: `ghs_installation_${minting[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'selected' }, { status: 201 })
  if (url.href === 'https://api.github.com/graphql') return Response.json({ data: { viewer: { databaseId: 4242, login: 'bordeaux-ai-sync[bot]' } } })
  if (url.hostname === 'api.github.com' && /^\/repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(url.pathname) && request.method === 'POST') {
    const body = await request.text()
    sent.push({ method: request.method, url: url.href, token: (request.headers.get('authorization') ?? '').replace(/^(token|bearer)\s+/i, ''), body })
    const { body: text } = JSON.parse(body) as { body: string }
    return Response.json({ id: 5000 + sent.length, body: text, html_url: `https://github.com${url.pathname}`, user: { login: 'bordeaux-ai-sync[bot]', id: 4242, type: 'Bot' }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { status: 201 })
  }
  return null
}

/** Refresh tokens Linear has taken: each works once. */
const refreshed = new Set<string>()

/**
 * Linear's API as the hosted Linear app sees it. A code `code-<org>` is workspace `<org>`'s
 * (`code-<org>-expiring` for a token that expires within the minute, `code-<org>-dead` for one
 * whose refresh token Linear refuses), traded only for the hub's redirect URI. Each token names
 * its workspace and its generation (`lin_<org>_<n>`), and each refresh gives the next, refusing a
 * refresh token used before. Every call is recorded, with the token it came with.
 */
async function linearApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.href === 'https://api.linear.app/oauth/token' && request.method === 'POST') {
    const form = new URLSearchParams(await request.text())
    sent.push({ method: 'POST', url: url.href, token: form.get('refresh_token') ?? form.get('code') ?? '', body: form.toString() })
    if (form.get('client_id') !== 'linear-test-client' || form.get('client_secret') !== 'linear-test-secret') return Response.json({ error: 'invalid_client' }, { status: 401 })
    const issue = (org: string, n: number, expires: number) => Response.json({ access_token: `lin_${org}_${n}`, token_type: 'Bearer', expires_in: expires, scope: 'read write', refresh_token: `ref_${org}_${n}` })
    if (form.get('grant_type') === 'authorization_code') {
      const code = /^code-([a-z0-9]+)(-expiring|-dead)?$/.exec(form.get('code') ?? '')
      if (!code || form.get('redirect_uri') !== 'https://board.test/sync/linear/callback') return Response.json({ error: 'invalid_grant', error_description: 'not a code for this redirect URI' }, { status: 400 })
      // A dead code's refresh token is one Linear won't take, as if revoked.
      if (code[2] === '-dead') refreshed.add(`ref_${code[1]}_1`)
      return issue(code[1]!, 1, code[2] ? 30 : 86_400)
    }
    const given = /^ref_([a-z0-9]+)_(\d+)$/.exec(form.get('refresh_token') ?? '')
    if (form.get('grant_type') !== 'refresh_token' || !given || refreshed.has(given[0])) return Response.json({ error: 'invalid_grant', error_description: 'refresh token used or unknown' }, { status: 400 })
    refreshed.add(given[0])
    return issue(given[1]!, Number(given[2]) + 1, 86_400)
  }
  if (url.href !== 'https://api.linear.app/graphql') return null
  const token = (request.headers.get('authorization') ?? '').replace(/^bearer\s+/i, '')
  const org = /^lin_([a-z0-9]+)_\d+$/.exec(token)?.[1]
  if (!org || revoked.has(token)) return Response.json({ errors: [{ message: 'authentication required' }] }, { status: 401 })
  if (revoked.has(`down:${token}`)) return Response.json({ errors: [{ message: 'Service unavailable' }] }, { status: 503 })
  const { query, variables } = (await request.json()) as { query: string; variables?: { id?: string; input?: { body?: string; issueId?: string } } }
  // Every call, by the token it came with: which workspace's token the app used, and when.
  if (!query.includes('commentCreate')) sent.push({ method: 'POST', url: `${url.href}#query`, token, body: query.slice(0, 200) })
  if (query.includes('BordeauxOrganization')) return Response.json({ data: { organization: { id: org, name: `Workspace ${org}` } } })
  if (query.includes('BordeauxCheck')) return Response.json({ data: { viewer: { id: `bot-${org}` } } })
  if (query.includes('LinearAdapterViewerOrganization')) return Response.json({ data: { viewer: { id: `bot-${org}`, displayName: 'bordeaux', organization: { id: org } } } })
  const now = new Date().toISOString()
  // Every workspace has whatever team a test names, by its key.
  const key = (variables as { filter?: { key?: { eq?: string } } } | undefined)?.filter?.key?.eq
  if (/\bteams\(/.test(query) && key) return Response.json({ data: { teams: { nodes: [{ id: `team-${org}-${key}`, key, name: key }], pageInfo: { hasNextPage: false, endCursor: null } } } })
  if (query.includes('commentCreate')) {
    sent.push({ method: 'POST', url: `${url.href}#commentCreate`, token, body: JSON.stringify(variables?.input ?? {}) })
    return Response.json({ data: { commentCreate: { success: true, lastSyncId: sent.length, comment: { id: `cmt-${sent.length}` } } } })
  }
  if (/\bcomment\(/.test(query) && variables?.id) return Response.json({ data: { comment: { id: variables.id, body: 'posted', createdAt: now, updatedAt: now, reactions: [], reactionData: [], url: `https://linear.app/${org}/comment/${variables.id}` } } })
  return Response.json({ errors: [{ message: `the test's Linear doesn't answer ${query.slice(0, 80)}` }] })
}

/** How many times each Slack workspace has installed the app: each install's bot token is the next. */
const installs = new Map<string, number>()

/**
 * Slack's Web API as the hosted Slack app sees it. A code `code-<team>` installs the app on
 * workspace `<team>` (`T…`), traded only for the hub's redirect URI, for bot token
 * `xoxb-<team>-<n>`, the workspace's `n`th install (`code-<team>-rotating` for one that expires,
 * `code-grid` for a Grid org's). Every call with a token is recorded with it; every workspace has
 * channel `#support`, `C0NAMED001`, person `UADA`, and `C0LIMITED1`, whose history reads are over
 * Slack's rate limit.
 */
async function slackApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.hostname !== 'slack.com' || !url.pathname.startsWith('/api/')) return null
  const method = url.pathname.slice('/api/'.length)
  const text = await request.text()
  const form: Record<string, string> = (request.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text || '{}') : Object.fromEntries(new URLSearchParams(text))
  if (method === 'oauth.v2.access') {
    sent.push({ method: 'POST', url: url.href, token: form.code ?? '', body: text })
    if (form.client_id !== 'slack-test-client' || form.client_secret !== 'slack-test-secret') return Response.json({ ok: false, error: 'invalid_client_id' })
    const code = /^code-(T[A-Z0-9]+|grid)(-rotating)?$/.exec(form.code ?? '')
    if (!code || form.redirect_uri !== 'https://board.test/sync/slack/callback') return Response.json({ ok: false, error: 'invalid_code' })
    // An Enterprise Grid org-wide install names the org, and no workspace.
    if (code[1] === 'grid') return Response.json({ ok: true, access_token: 'xoxb-EGRID-1', token_type: 'bot', bot_user_id: 'UBOT', app_id: 'A0SLACK', team: null, enterprise: { id: 'EGRID', name: 'Grid' }, is_enterprise_install: true })
    const n = (installs.get(code[1]!) ?? 0) + 1
    installs.set(code[1]!, n)
    // With the app's token rotation on, the token expires in 12 hours and comes with a refresh token.
    const rotating = code[2] ? { expires_in: 43_200, refresh_token: `xoxe-1-${code[1]}` } : {}
    return Response.json({ ok: true, access_token: `xoxb-${code[1]}-${n}`, token_type: 'bot', scope: 'chat:write', bot_user_id: 'UBOT', app_id: 'A0SLACK', team: { id: code[1], name: `Workspace ${code[1]}` }, enterprise: null, is_enterprise_install: false, ...rotating })
  }
  const token = (request.headers.get('authorization') ?? '').replace(/^bearer\s+/i, '') || form.token || ''
  const team = /^xoxb-(T[A-Z0-9]+)-\d+$/.exec(token)?.[1]
  if (!team) return Response.json({ ok: false, error: 'invalid_auth' })
  if (revoked.has(token)) return Response.json({ ok: false, error: 'token_revoked' })
  if (revoked.has(`down:${token}`)) return Response.json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': '60' } })
  sent.push({ method: 'POST', url: url.href, token, body: text })
  if (method === 'auth.test') return Response.json({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: team, user: 'bordeaux' })
  if (method === 'chat.postMessage') return Response.json({ ok: true, channel: form.channel, ts: `${Math.floor(Date.now() / 1000)}.${String(sent.length).padStart(6, '0')}`, message: { text: form.text, user: 'UBOT', bot_id: 'BBOT' } })
  if (method === 'users.info') return Response.json({ ok: true, user: { id: form.user, name: 'ada', real_name: 'Ada', team_id: team, profile: { display_name: 'ada', real_name: 'Ada', image_72: 'https://avatars.test/ada' } } })
  if (method === 'conversations.list') return Response.json({ ok: true, channels: [{ id: 'C0NAMED001', name: 'support', is_member: true }], response_metadata: { next_cursor: '' } })
  if (method === 'conversations.info') return Response.json({ ok: true, channel: { id: form.channel, name: form.channel === 'C0NAMED001' ? 'support' : 'other', is_member: true } })
  // A channel whose history reads are over Slack's limit for an app outside its Marketplace.
  if (method === 'conversations.replies' && form.channel === 'C0LIMITED1') return Response.json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': '60' } })
  // A bot deletes only its own messages, and every message in these workspaces is a person's.
  if (method === 'chat.delete') return Response.json({ ok: false, error: 'cant_delete_message' })
  if (method === 'chat.getPermalink') return Response.json({ ok: true, permalink: `https://${team.toLowerCase()}.slack.com/archives/${form.channel}/p${(form.message_ts ?? '').replace('.', '')}` })
  return Response.json({ ok: true, messages: [] })
}

/**
 * GitHub's web sign-in, as the hub's shared callback uses it: the code is exchanged only with
 * the redirect URI it was issued for, the hub's, and whoever signs in is a member of every org.
 */
async function github(request: Request): Promise<Response> {
  const synced = (await syncApp(request)) ?? (await linearApi(request)) ?? (await slackApi(request))
  if (synced) return synced
  const url = new URL(request.url)
  if (url.href === 'https://github.com/login/oauth/access_token') {
    const form = new URLSearchParams(await request.text())
    if (form.get('redirect_uri') !== 'https://board.test/inspect/callback') return Response.json({ error: 'redirect_uri_mismatch', error_description: 'not the redirect URI the code was issued for' })
    return Response.json({ access_token: 'gho_web', token_type: 'bearer' })
  }
  if (url.href === 'https://api.github.com/user') return Response.json({ id: 11, login: 'web-ada' })
  if (url.href.startsWith('https://api.github.com/user/memberships/orgs/')) return Response.json({ state: 'active', role: 'member' })
  return new Response(null, { status: 202 })
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/hosted/wrangler.jsonc' },
      // Nothing leaves the test runner: GitHub, Linear, Slack, and a registrant's wake URL are answered here.
      miniflare: { outboundService: github },
    }),
  ],
  resolve: { alias: { '@vercel/connect/chat': new URL('./src/sync/connect-chat.ts', import.meta.url).pathname } },
  test: { include: ['test/hosted/*.test.ts'] },
})
