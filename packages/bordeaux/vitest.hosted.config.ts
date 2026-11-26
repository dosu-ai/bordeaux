// Hosted mode's tests (spec 09): every team on one Worker, at its own subdomain of the hub.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * GitHub's web sign-in, as the hub's shared callback uses it: the code is exchanged only with
 * the redirect URI it was issued for, the hub's, and whoever signs in is a member of every org.
 */
async function github(request: Request): Promise<Response> {
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
