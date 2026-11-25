import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('makes a board project from the template, filled in', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'create-bordeaux-')), 'acme-board')
  execFileSync('node', [join(import.meta.dirname, 'index.mjs'), dir, '--url', 'https://board.acme.dev/', '--org', 'acme', '--client-id', 'Iv1.abc'], { stdio: 'pipe' })
  const wrangler = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')
  assert.match(wrangler, /"name": "acme-board"/)
  assert.match(wrangler, /"BORDEAUX_URL": "https:\/\/board.acme.dev"/)
  assert.match(wrangler, /"BORDEAUX_GITHUB_ORG": "acme"/)
  assert.match(wrangler, /"bucket_name": "acme-board-files"/)
  assert.doesNotMatch(wrangler, /BORDEAUX_DEV/)
  assert.ok(existsSync(join(dir, '.gitignore')))
  assert.doesNotMatch(readFileSync(join(dir, 'README.md'), 'utf8'), /\{\{/)
})
