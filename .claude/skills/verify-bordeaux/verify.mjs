#!/usr/bin/env node
// Drives a local bordeaux board the way a person does: through `bdx` and the board's HTTP API.
// Each run gets its own port, its own Durable Object state, and its own signed-in people, and
// records every command it drives under .verify/<run>/ in the repo, which `down` keeps.
//
//   verify.mjs up                                  start a board; prints the run's export line
//   verify.mjs doctor                              is this run's board worth driving?
//   verify.mjs bdx [--as <id>:<login>] -- <args>   run the built bdx as a person (default 1:ada)
//   verify.mjs http [--as <id>:<login>] <METHOD> <path> [json body]
//   verify.mjs note <text>                         add a line to the run's evidence log
//   verify.mjs down                                stop what `up` started; keeps the evidence
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const PKG = join(REPO, 'packages/bordeaux')
const BDX = join(PKG, 'dist/bdx.mjs')
const EVIDENCE_ROOT = join(REPO, '.verify')
const DEFAULT_PERSON = '1:ada'

const fail = (message) => {
  process.stderr.write(`verify: ${message}\n`)
  process.exit(1)
}

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Tokens never land in evidence: a JWT or a refresh token reads as a placeholder.
const scrub = (text) => text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<jwt>').replace(/("refresh_token"\s*:\s*")[^"]+/g, '$1<refresh>')

function current() {
  const id = process.env.BORDEAUX_VERIFY_RUN ?? fail('no run: set BORDEAUX_VERIFY_RUN to the id `verify.mjs up` printed')
  const dir = join(tmpdir(), `bordeaux-verify-${id}`)
  if (!existsSync(join(dir, 'run.json'))) fail(`run ${id} has no state at ${dir}: it was torn down, or never started`)
  return { id, dir, run: JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')), evidence: join(EVIDENCE_ROOT, id) }
}

/** The next evidence file's name: 001-<label>.txt, in the order the run drove things. */
function record(evidence, label, body) {
  mkdirSync(evidence, { recursive: true })
  const n = readdirSync(evidence).filter((name) => /^\d{3}-/.test(name)).length + 1
  const file = join(evidence, `${String(n).padStart(3, '0')}-${label.replace(/[^\w.-]+/g, '_').slice(0, 60)}.txt`)
  writeFileSync(file, scrub(body))
  appendFileSync(join(evidence, 'log.txt'), `${new Date().toISOString()} ${file.slice(evidence.length + 1)}\n`)
  return file
}

/** A dev person's own config dir, signed in to the run's board through POST /__dev/token. */
async function person(dir, run, who) {
  const [id, login] = who.split(':')
  if (!/^\d+$/.test(id ?? '') || !login) fail(`--as: <github id>:<login>, like 2:bea, got ${who}`)
  const config = join(dir, `config-${id}`)
  const file = join(config, 'bordeaux', 'credentials.json')
  if (!existsSync(file)) {
    const response = await fetch(`${run.url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: Number(id), login, ttl: 12 * 3600 }) })
    if (!response.ok) fail(`the dev sign-in refused ${who}: ${response.status} ${await response.text()}`)
    const issued = await response.json()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const store = { current: run.url, boards: { [run.url]: { url: run.url, login: issued.login, refresh_token: issued.refresh_token, tokens: { [run.url]: { access_token: issued.access_token, expires_at: issued.expires_at } } } } }
    writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  }
  return { config, token: () => JSON.parse(readFileSync(file, 'utf8')).boards[run.url].tokens[run.url].access_token }
}

/** Takes `--as <id>:<login>` off the front of the args. */
function as(args) {
  if (args[0] !== '--as') return { who: DEFAULT_PERSON, rest: args }
  return { who: args[1] ?? fail('--as needs <id>:<login>'), rest: args.slice(2) }
}

async function up() {
  const id = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${process.pid}`
  const dir = join(tmpdir(), `bordeaux-verify-${id}`)
  mkdirSync(dir, { recursive: true })
  const state = join(dir, 'state')
  mkdirSync(state)
  process.stderr.write('building bdx…\n')
  execFileSync('node', ['scripts/build.mjs'], { cwd: PKG, stdio: ['ignore', 'ignore', 'inherit'] })
  const [port, inspector] = [await freePort(), await freePort()]
  const url = `http://127.0.0.1:${port}`
  const log = openSync(join(dir, 'wrangler.log'), 'a')
  const dev = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspector), '--persist-to', state, '--var', `BORDEAUX_URL:${url}`, '--var', 'BORDEAUX_DEV:1'], {
    cwd: PKG,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', log, log],
    detached: true,
  })
  dev.unref()
  const revision = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  const run = { id, url, port, pid: dev.pid, state, revision, started: new Date().toISOString() }
  writeFileSync(join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`)

  // Ready means a board answers discovery at its own URL, not just that a port is open.
  for (let tries = 0; ; tries++) {
    try {
      const found = await (await fetch(`${url}/`)).json()
      if (found?.audience && found.url === url) break
    } catch {}
    if (!alive(dev.pid)) fail(`wrangler dev exited: see ${join(dir, 'wrangler.log')}`)
    if (tries > 90) fail(`no board at ${url} after 90 s: see ${join(dir, 'wrangler.log')}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  process.env.BORDEAUX_VERIFY_RUN = id
  await person(dir, run, DEFAULT_PERSON)
  record(join(EVIDENCE_ROOT, id), 'up', `${JSON.stringify(run, null, 2)}\n`)
  process.stderr.write(`board ${url} (pid ${dev.pid}, ${revision}); evidence in .verify/${id}/\n`)
  process.stdout.write(`export BORDEAUX_VERIFY_RUN=${id}\n`)
}

async function doctor() {
  const { dir, run, evidence } = current()
  const rows = []
  const add = (check, ok, says) => rows.push([check, ok ? 'ok' : 'fix', says])
  add('process', alive(run.pid), alive(run.pid) ? `wrangler dev, pid ${run.pid}` : `pid ${run.pid} is gone: verify.mjs down, then up`)
  const listener = spawnSync('lsof', ['-ti', `tcp:${run.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
  const group = (pid) => spawnSync('ps', ['-o', 'pgid=', '-p', pid], { encoding: 'utf8' }).stdout.trim()
  const ours = listener.length > 0 && listener.every((pid) => group(pid) === String(run.pid))
  add('port', ours, ours ? `${run.port} is this run's` : listener.length ? `${run.port} belongs to pid ${listener.join(',')}, not this run` : `nothing listens on ${run.port}`)
  let discovery = null
  try {
    discovery = await (await fetch(`${run.url}/`)).json()
  } catch {}
  add('discovery', discovery?.url === run.url, discovery ? `board ${discovery.version} at ${discovery.url}` : `${run.url} doesn't answer`)
  const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  add('revision', true, head === run.revision ? `started at ${run.revision}, HEAD now` : `started at ${run.revision}, HEAD is ${head}: wrangler dev reloads source, but restart for a clean board`)
  if (discovery) {
    const { token } = await person(dir, run, DEFAULT_PERSON)
    const answered = await fetch(`${run.url}/admin/doctor`, { headers: { authorization: `Bearer ${token()}` } })
    const found = answered.ok ? await answered.json() : null
    const missing = found ? Object.entries(found.bindings).filter(([, has]) => !has).map(([name]) => name) : []
    add('bindings', found !== null && missing.length === 0, found ? (missing.length ? `missing ${missing.join(', ')}` : 'board, directory, tail, files, assets, versionMetadata') : `/admin/doctor answered ${answered.status}`)
    add('dev route', found?.dev === true, found?.dev ? 'on: POST /__dev/token signs people in' : 'off: this is not a verification board')
  }
  const out = `${rows.map(([check, status, says]) => `${check.padEnd(10)} ${status.padEnd(4)} ${says}`).join('\n')}\n`
  record(evidence, 'doctor', out)
  process.stdout.write(out)
  process.exitCode = rows.some(([, status]) => status === 'fix') ? 1 : 0
}

async function bdx(args) {
  const { dir, run, evidence } = current()
  const { who, rest } = as(args)
  const argv = rest[0] === '--' ? rest.slice(1) : rest
  if (argv[0] === 'token') fail('bdx token prints a secret: use `verify.mjs http` to call the API as a person')
  const { config } = await person(dir, run, who)
  const env = { ...process.env, XDG_CONFIG_HOME: config }
  for (const name of ['BOARD_URL', 'BOARD_TOKEN', 'BOARD_NAME', 'BOARD_PROFILE']) delete env[name]
  const done = spawnSync('node', [BDX, ...argv], { env, encoding: 'utf8', timeout: 15 * 60_000 })
  const file = record(evidence, `bdx-${argv.slice(0, 2).join('-')}`, `$ bdx ${argv.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(' ')}   # as ${who}\n--- stdout\n${done.stdout}--- stderr\n${done.stderr}--- exit ${done.status ?? done.signal}\n`)
  process.stdout.write(done.stdout)
  process.stderr.write(done.stderr)
  process.stderr.write(`[exit ${done.status ?? done.signal}; ${file.slice(REPO.length + 1)}]\n`)
  process.exitCode = done.status ?? 1
}

async function http(args) {
  const { dir, run, evidence } = current()
  const { who, rest } = as(args)
  const [method, path, body] = rest
  if (!method || !path?.startsWith('/')) fail('usage: verify.mjs http [--as <id>:<login>] <METHOD> </path> [json body]')
  const { token } = await person(dir, run, who)
  const response = await fetch(`${run.url}${path}`, { method, headers: { authorization: `Bearer ${token()}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body } : {}) })
  const text = await response.text()
  const file = record(evidence, `http-${method}-${path.split('?')[0]}`, `${method} ${path}   # as ${who}\n${body ? `${body}\n` : ''}--- ${response.status}\n${text}\n`)
  process.stdout.write(`${text}\n`)
  process.stderr.write(`[${response.status}; ${file.slice(REPO.length + 1)}]\n`)
  process.exitCode = response.ok ? 0 : 1
}

function note(args) {
  const { evidence } = current()
  const file = record(evidence, 'note', `${args.join(' ')}\n`)
  process.stderr.write(`[${file.slice(REPO.length + 1)}]\n`)
}

function down() {
  const { id, dir, run, evidence } = current()
  // Only the process group this run started: never by name, never someone else's board.
  if (alive(run.pid)) {
    try {
      process.kill(-run.pid, 'SIGTERM')
    } catch {}
    for (let i = 0; i < 50 && alive(run.pid); i++) spawnSync('sleep', ['0.1'])
    if (alive(run.pid)) process.kill(-run.pid, 'SIGKILL')
  }
  const log = existsSync(join(dir, 'wrangler.log')) ? readFileSync(join(dir, 'wrangler.log'), 'utf8') : ''
  record(evidence, 'wrangler-log', log)
  rmSync(dir, { recursive: true, force: true })
  process.stderr.write(`stopped run ${id}; evidence kept in .verify/${id}/\n`)
}

const [command, ...args] = process.argv.slice(2)
const commands = { up, doctor, bdx: () => bdx(args), http: () => http(args), note: () => note(args), down }
if (!commands[command]) fail('usage: verify.mjs up | doctor | bdx [--as id:login] -- <args> | http [--as id:login] <METHOD> <path> [json] | note <text> | down')
await commands[command]()
