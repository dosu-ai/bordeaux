#!/usr/bin/env node
// What `npm pack` and `npm publish` ship beyond src/ (`prepack`): `bdx` as one ES module for Node,
// since Node won't strip types from a file in node_modules, and the license files from the repo root.
import { copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await build({
  entryPoints: [join(root, 'src/cli/bdx.ts')],
  outfile: join(root, 'dist/bdx.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Its dependencies come from the package's own: `@vercel/board/cli` above all.
  packages: 'external',
  logLevel: 'warning',
})
for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(root, '../..', file), join(root, file))
