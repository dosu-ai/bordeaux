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

/**
 * GitHub's web sign-in, as the hub's shared callback uses it: the code is exchanged only with
 * the redirect URI it was issued for, the hub's, and whoever signs in is a member of every org.
 */
async function github(request: Request): Promise<Response> {
  const synced = await syncApp(request)
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
