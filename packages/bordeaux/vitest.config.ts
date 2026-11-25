import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Nothing leaves the test runner: a board's wake of a registrant's URL is answered here.
      miniflare: { outboundService: () => new Response(null, { status: 202 }), bindings: { BORDEAUX_URL: 'https://board.test', BORDEAUX_GITHUB_ORG: 'acme', GITHUB_CLIENT_ID: 'Iv1.test', BORDEAUX_DEV: '1' } },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
})
