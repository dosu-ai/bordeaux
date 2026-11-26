// Hosted mode's tests (spec 09): every team on one Worker, at its own subdomain of the hub.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/hosted/wrangler.jsonc' },
      // Nothing leaves the test runner: GitHub's API and a registrant's wake URL are answered here.
      miniflare: { outboundService: () => new Response(null, { status: 202 }) },
    }),
  ],
  resolve: { alias: { '@vercel/connect/chat': new URL('./src/sync/connect-chat.ts', import.meta.url).pathname } },
  test: { include: ['test/hosted/*.test.ts'] },
})
