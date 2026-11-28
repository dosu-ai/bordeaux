#!/usr/bin/env node
// Copies upstream's pure board modules into src/upstream/, byte for byte, from a vercel/board
// checkout at the pinned commit. The upgrade skill reruns it and reviews the diff.
//
//   node scripts/vendor-upstream.mjs <path to vercel/board checkout>
//
// Files listed here are upstream's (Apache-2.0, see NOTICE) and are never edited by hand.
// Anything they import that isn't listed is one of our shims in src/upstream/, marked SHIM.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PIN = { version: '0.57.0', commit: '34d0f584f9446b05d3afbfa73c696e1bf31c043d' }

export const FILES = [
  // The board's data model: events, folds, and what they're made of.
  'contract/schemas.ts',
  'contract/files.ts',
  'contract/events.ts',
  'contract/external.ts',
  'contract/folds.ts',
  'contract/own.ts',
  'contract/profiles.ts',
  'contract/profile-header.ts',
  'contract/emoji.ts',
  'contract/emoji-table.ts',
  'contract/mentions.ts',
  'contract/blocks.ts',
  'contract/data-schemas.ts',
  'contract/task-batch.ts',
  // The tables a board reads from, as SQL over a three-call Db.
  'store/sql.ts',
  'store/project.ts',
  'store/types.ts',
  // The protocol's shapes, and watchers' tails.
  'api/routes.ts',
  'api/tail.ts',
  'server/watch-spec.ts',
  'server/watchers-hash.ts',
  // Views, filters, and the feed.
  'server/feed.ts',
  'server/carried.ts',
  'server/actors.ts',
  // Who may do what: access, grants, and principals, as board() itself judges them.
  'server/access.ts',
  'server/grants.ts',
  'server/auth.ts',
  'server/file-names.ts',
  'client/ids.ts',
  // An app's board() on a bordeaux board (@dosu/bordeaux/app): upstream's http() backend, the SDK
  // client it forwards through, and the wake-up handling vercel() registers with.
  'api/protocol.ts',
  'client/client.ts',
  'client/sse.ts',
  'server/backend-http.ts',
  'server/registrant.ts',
  'server/routing.ts',
  'server/sandbox.ts',
  'server/tails.ts',
  'server/watch-run.ts',
  'server/attempts.ts',
  'server/wait-until.ts',
  // The inspector's page: its HTML shell, look, and policy (the hosted inspector, spec 07).
  'inspect/shell.ts',
  'inspect/style.ts',
]

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../src/upstream')

if (import.meta.url === `file://${process.argv[1]}`) {
  const checkout = process.argv[2]
  if (!checkout) {
    console.error('usage: vendor-upstream.mjs <vercel/board checkout>')
    process.exit(2)
  }
  const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const version = JSON.parse(readFileSync(join(checkout, 'packages/board/package.json'), 'utf8')).version
  if (head !== PIN.commit || version !== PIN.version)
    console.warn(`note: checkout is ${version} at ${head}; the pin is ${PIN.version} at ${PIN.commit}. Update PIN when upgrading.`)
  for (const file of FILES) {
    const to = join(out, file)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(join(checkout, 'packages/board/src', file), to)
  }
  console.log(`vendored ${FILES.length} files from ${version} (${head.slice(0, 12)}) into src/upstream/`)
}
