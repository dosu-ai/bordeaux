import { defineConfig } from 'vitest/config'

// bdx runs in Node, not workerd: its tests start it as a person does, from its source.
export default defineConfig({
  test: { include: ['test/cli/*.test.ts'] },
})
