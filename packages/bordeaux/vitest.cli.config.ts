import { defineConfig } from 'vitest/config'

// bdx runs in Node, not workerd: its tests start it as a person does, from its source, one
// process per run, so a test that starts many gets more than vitest's 5 s.
export default defineConfig({
  test: { include: ['test/cli/*.test.ts'], testTimeout: 30_000 },
})
