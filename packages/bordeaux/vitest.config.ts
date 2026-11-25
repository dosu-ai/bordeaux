import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { BORDEAUX_URL: 'http://board.test', BORDEAUX_GITHUB_ORG: 'acme', GITHUB_CLIENT_ID: 'Iv1.test', BORDEAUX_DEV: '1' } },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
})
