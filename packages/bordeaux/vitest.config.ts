import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.jsonc' },
      // Nothing leaves the test runner: a board's wake of a registrant's URL is answered here, and
      // Slack's Web API as a workspace with nothing in it.
      miniflare: {
        outboundService: (request: Request) =>
          new URL(request.url).hostname === 'slack.com' ? Response.json({ ok: true, user_id: 'UBOT', bot_id: 'BBOT', team_id: 'T1', channels: [], messages: [] }) : new Response(null, { status: 202 }), bindings: { BORDEAUX_URL: 'https://board.test', BORDEAUX_GITHUB_ORG: 'acme', GITHUB_CLIENT_ID: 'Iv1.test', BORDEAUX_DEV: '1', BORDEAUX_RUN_TIMEOUT_MS: '300' },
      },
    }),
  ],
  // As a deployment's wrangler.jsonc aliases it (spec 06, Q7).
  resolve: { alias: { '@vercel/connect/chat': new URL('./src/sync/connect-chat.ts', import.meta.url).pathname } },
  test: { include: ['test/*.test.ts'] },
})
