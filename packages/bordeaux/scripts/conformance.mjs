#!/usr/bin/env node
// Runs upstream's conformance kit (`vb conformance`) against a local bordeaux board and checks the
// groups it must pass (spec 08). Every group's result is printed; only `--groups` decide.
//
//   node scripts/conformance.mjs                      # core, paging, search
//   node scripts/conformance.mjs --groups core,paging,search,grants
//   node scripts/conformance.mjs --hosted             # against a hosted team (spec 09)
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--groups')
const required = (at === -1 ? 'core,paging,search' : process.argv[at + 1]).split(',')
const hosted = process.argv.includes('--hosted')

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

const port = await freePort()
// Hosted, the Worker is the hub, and the board is a team's at its own subdomain of it.
const hub = `http://board.localhost:${port}`
let url = hosted ? hub : `http://127.0.0.1:${port}`
const config = hosted ? ['-c', 'wrangler.hosted.jsonc', '--var', `BORDEAUX_HOSTED_URL:${hub}`] : ['--var', `BORDEAUX_URL:${url}`]
// A board of its own each run: what another run left (its grants, its URL in g4) never carries over.
const state = mkdtempSync(join(tmpdir(), 'bordeaux-conformance-'))
const dev = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, ...config, '--var', 'BORDEAUX_DEV:1'], {
  cwd: root,
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
const stop = () => {
  dev.kill('SIGTERM')
  rmSync(state, { recursive: true, force: true })
}
process.on('exit', stop)

try {
  for (let tries = 0; ; tries++) {
    try {
      if ((await fetch(url)).status < 500) break
    } catch {}
    if (tries > 60) throw new Error(`the board didn't start at ${url}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (hosted) {
    const made = await fetch(`${hub}/__dev/team`, { method: 'POST', body: JSON.stringify({ login: 'conformance' }) })
    if (!made.ok) throw new Error(`the hub made no team: ${made.status} ${await made.text()}`)
    url = (await made.json()).url
    console.log(`hosted team at ${url}`)
  }
  const { access_token: token } = await (await fetch(`${url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: 583231, login: 'conformance' }) })).json()

  const run = spawn('npx', ['vb', 'conformance', '--json'], { cwd: root, env: { ...process.env, BOARD_URL: url, BOARD_TOKEN: token } })
  let out = ''
  run.stdout.on('data', (chunk) => (out += chunk))
  run.stderr.pipe(process.stderr)
  await new Promise((r) => run.on('close', r))
  const report = JSON.parse(out)

  const tally = {}
  for (const check of report.checks) (tally[check.group] ??= { passed: 0, failed: 0, skipped: 0 })[check.status]++
  for (const [group, counts] of Object.entries(tally)) console.log(`${required.includes(group) ? '*' : ' '} ${group.padEnd(12)} ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`)
  const failed = report.checks.filter((check) => required.includes(check.group) && check.status === 'failed')
  for (const check of failed) console.log(`FAIL ${check.group}: ${check.name}\n     ${check.detail}`)
  for (const check of report.checks.filter((c) => required.includes(c.group) && c.status === 'skipped')) console.log(`skip ${check.group}: ${check.name}\n     ${check.detail}`)
  console.log(failed.length === 0 ? `\nok: ${required.join(', ')} pass` : `\n${failed.length} required check(s) failed`)
  process.exitCode = failed.length === 0 ? 0 : 1
} finally {
  stop()
}
