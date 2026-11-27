// Hosted mode's tests (spec 09): every team on one Worker, at its own subdomain of the hub.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/** What the sync App sent GitHub, by installation token, for a test to read at `https://outbound.test/sent`. */
const sent: { method: string; url: string; token: string; body: string }[] = []

/**
 * GitHub's API as the sync App sees it: an installation token for each installation, named by
 * it, its bot from GraphQL's `viewer`, and comments taken and recorded.
 */
async function syncApp(request: Request): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.href === 'https://outbound.test/sent') return Response.json(sent)
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
  if (!org) return Response.json({ errors: [{ message: 'authentication required' }] }, { status: 401 })
  const { query, variables } = (await request.json()) as { query: string; variables?: { id?: string; input?: { body?: string; issueId?: string } } }
  // Every call, by the token it came with: which workspace's token the app used, and when.
  if (!query.includes('commentCreate')) sent.push({ method: 'POST', url: `${url.href}#query`, token, body: query.slice(0, 200) })
  if (query.includes('BordeauxOrganization')) return Response.json({ data: { organization: { id: org, name: `Workspace ${org}` } } })
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

/**
 * GitHub's web sign-in, as the hub's shared callback uses it: the code is exchanged only with
 * the redirect URI it was issued for, the hub's, and whoever signs in is a member of every org.
 */
async function github(request: Request): Promise<Response> {
  const synced = (await syncApp(request)) ?? (await linearApi(request))
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
      // Nothing leaves the test runner: GitHub and a registrant's wake URL are answered here.
      miniflare: { outboundService: github },
    }),
  ],
  resolve: { alias: { '@vercel/connect/chat': new URL('./src/sync/connect-chat.ts', import.meta.url).pathname } },
  test: { include: ['test/hosted/*.test.ts'] },
})
