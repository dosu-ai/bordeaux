#!/usr/bin/env node
// `bx`: bordeaux's CLI (spec 07). Its own commands sign you in; every board command is upstream's,
// embedded with `createApp()` from @vercel/board/cli, run with BOARD_URL and a fresh BOARD_TOKEN set
// in this process. createApp gets no `login` or `token`: both mint through Vercel.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createApp } from '@vercel/board/cli'
import type { Collected, DeadLetter, Health as BoardHealth } from '../engine/engine.ts'
import type { SyncHealth } from '../worker/health.ts'

/** What `GET /admin/health` answers. */
type Health = BoardHealth & {
  board: string | null
  /** The Worker version the board's Durable Object runs, and the one that answered. */
  version: string | null
  worker: string | null
  sync: SyncHealth[]
}

/** A sign-in to a deployment, and the access tokens it got for each of the team's boards. */
type Saved = { url: string; login: string; refresh_token: string; tokens?: Record<string, { access_token: string; expires_at: string }> }
type Store = { current: string | null; boards: Record<string, Saved> }

const FILE = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'bordeaux', 'credentials.json')
/** Refresh this long before an access token runs out: upstream re-reads BOARD_TOKEN 60 s before. */
const EARLY_MS = 5 * 60_000

function fail(message: string, code = 1): never {
  process.stderr.write(`bx: ${message}\n`)
  process.exit(code)
  throw new Error(message)
}

function load(): Store {
  try {
    return JSON.parse(readFileSync(FILE, 'utf8')) as Store
  } catch {
    return { current: null, boards: {} }
  }
}

/** Writes the store whole, readable only by you, so a crash never leaves half a file. */
function save(store: Store) {
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 })
  const temp = `${FILE}.${process.pid}`
  writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temp, 0o600)
  renameSync(temp, FILE)
}

const clean = (url: string) => url.replace(/\/+$/, '')

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> }
}

/** `bx login <url>`: GitHub's device flow, through the board's broker. */
async function login(url: string) {
  const started = await post(`${url}/auth/device`, {})
  if (started.status !== 200) fail(`${url} can't sign you in: ${started.json.error_description ?? started.status}`)
  const { device_code, user_code, verification_uri, interval = 5, expires_in = 900 } = started.json as { device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in?: number }
  process.stderr.write(`Open ${verification_uri} and enter ${user_code}\nWaiting for GitHub…\n`)
  let wait = Number(interval)
  for (const deadline = Date.now() + Number(expires_in) * 1000; Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, wait * 1000))
    const polled = await post(`${url}/auth/token`, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code })
    const { error } = polled.json as { error?: string }
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      wait = Number((polled.json as { interval?: number }).interval ?? wait + 5)
      continue
    }
    if (polled.status !== 200) fail(String(polled.json.error_description ?? error ?? `sign-in failed: ${polled.status}`))
    const issued = polled.json as { access_token: string; refresh_token: string; expires_at: string; login: string }
    const store = load()
    store.boards[url] = { url, login: issued.login, refresh_token: issued.refresh_token, tokens: { [url]: { access_token: issued.access_token, expires_at: issued.expires_at } } }
    store.current = url
    save(store)
    process.stderr.write(`Signed in to ${url} as ${issued.login}\n`)
    return
  }
  fail('the code expired before you entered it: run bx login again')
}

/** The deployment a board's URL is on: a named board is at `<deployment>/b/<name>`. */
const deploymentOf = (url: string) => url.replace(/\/b\/[^/]+$/, '')

/** The deployment this run uses: --url, BOARD_URL, or the one you last signed in to. */
function deploymentUrl(args: string[]): string | null {
  const at = args.indexOf('--url')
  if (at !== -1 && args[at + 1]) return deploymentOf(clean(args[at + 1]!))
  if (process.env.BOARD_URL) return deploymentOf(clean(process.env.BOARD_URL))
  return load().current
}

/** The board this run uses: a named one with --name (or BOARD_NAME), or the URL it was given. */
function boardUrl(args: string[]): string | null {
  const name = flag(args, '--name') ?? process.env.BOARD_NAME
  const deployment = deploymentUrl(args)
  if (name !== undefined && deployment !== null) return `${deployment}/b/${name.toLowerCase()}`
  const at = args.indexOf('--url')
  if (at !== -1 && args[at + 1]) return clean(args[at + 1]!)
  if (process.env.BOARD_URL) return clean(process.env.BOARD_URL)
  return deployment
}

/**
 * A fresh access token for the board at `url`, made out to it (a token for one board isn't
 * another's), renewing the sign-in when the one kept is close to running out.
 */
async function accessToken(url: string, force = false): Promise<string> {
  const deployment = deploymentOf(url)
  const store = load()
  const saved = store.boards[deployment]
  if (!saved) return fail(`you aren't signed in to ${deployment}: run bx login ${deployment}`)
  const kept = saved.tokens?.[url]
  if (!force && kept && Date.parse(kept.expires_at) - Date.now() > EARLY_MS) return kept.access_token
  const renewed = await post(`${deployment}/auth/token`, { grant_type: 'refresh_token', refresh_token: saved.refresh_token, ...(url !== deployment ? { audience: url } : {}) })
  if (renewed.status !== 200) return fail(String((renewed.json as { error_description?: string }).error_description ?? `your sign-in to ${deployment} has ended: run bx login ${deployment}`))
  const issued = renewed.json as { access_token: string; refresh_token: string; expires_at: string }
  store.boards[deployment] = { ...saved, refresh_token: issued.refresh_token, tokens: { ...saved.tokens, [url]: { access_token: issued.access_token, expires_at: issued.expires_at } } }
  save(store)
  return issued.access_token
}

/** A request to the deployment's admin routes as you, with your default board's token (spec 07). */
async function asYou(url: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  url = deploymentOf(url)
  const response = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken(url)}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } }
  if (!response.ok) fail(json.error?.message ?? `${method} ${path}: ${response.status}`)
  return json
}

/** A flag's value: `--env production`. */
const flag = (args: string[], name: string) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

/** A duration as days: `90d`, `12h`, or seconds. */
const seconds = (value: string) => {
  const found = /^(\d+)([dhm]?)$/.exec(value) ?? fail(`--ttl: a number of days (90d), hours (12h), or minutes (30m), got ${value}`)
  return Number(found[1]) * ({ d: 86400, h: 3600, m: 60, '': 1 } as Record<string, number>)[found[2]!]!
}

/** `bx list` and `bx boards create|delete <name>`: the team's boards (spec 07). */
async function boards(url: string, args: string[]) {
  const [word, action, name] = args.filter((arg) => !arg.startsWith('-'))
  if (word === 'list' || action === 'list' || action === undefined) {
    const { boards: found } = (await asYou(url, 'GET', '/admin/boards')) as { boards: { name: string | null; url: string }[] }
    for (const board of found) process.stdout.write(`${(board.name ?? '(default)').padEnd(24)} ${board.url}\n`)
    return
  }
  if (!name) fail(`usage: bx boards ${action} <name>`)
  if (action === 'create') {
    const { created } = await asYou(url, 'POST', '/admin/boards', { name })
    process.stderr.write(created ? `made ${name}\n` : `${name} is there already\n`)
    return
  }
  if (action === 'delete') {
    const { deleted } = await asYou(url, 'DELETE', `/admin/boards/${encodeURIComponent(name!)}`)
    if (!deleted) fail(`this team has no board named ${name}`)
    return
  }
  fail('usage: bx list | bx boards create <name> | bx boards delete <name>')
}

/** `bx export [--name <board>] > board.jsonl` and `bx import <file> [--name <board>]`: a board's whole log. */
async function exporting(url: string, args: string[]) {
  const deployment = deploymentOf(url)
  const board = flag(args, '--name') ?? process.env.BOARD_NAME
  const query = board ? `?board=${encodeURIComponent(board)}` : ''
  const headers = { authorization: `Bearer ${await accessToken(deployment)}` }
  if (args.includes('export')) {
    const response = await fetch(`${deployment}/admin/export${query}`, { headers })
    if (!response.ok || !response.body) fail(((await response.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? `export: ${response.status}`)
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) process.stdout.write(chunk)
    return
  }
  const file = args[args.indexOf('import') + 1] ?? fail('usage: bx import <file.jsonl> [--name <board>]')
  const response = await fetch(`${deployment}/admin/import${query}`, { method: 'POST', headers, body: readFileSync(file, 'utf8') })
  const json = (await response.json().catch(() => ({}))) as { events?: number; error?: { message?: string } }
  if (!response.ok) fail(json.error?.message ?? `import: ${response.status}`)
  process.stderr.write(`imported ${json.events} events\n`)
}

/** `bx health [--name <board>] [--json]`: how a board stands, and whether its sync reaches each platform. */
async function health(url: string, args: string[]) {
  const board = flag(args, '--name') ?? process.env.BOARD_NAME
  const found = (await asYou(url, 'GET', `/admin/health${board ? `?board=${encodeURIComponent(board)}` : ''}`)) as unknown as Health
  if (args.includes('--json')) return void process.stdout.write(`${JSON.stringify(found)}\n`)
  const rows: [string, string][] = []
  for (const queue of found.queues) rows.push(['queue', `${queue.owner}  ${queue.pending} pending, ${queue.leased} leased, ${queue.retrying} retrying`])
  if (found.queues.length === 0) rows.push(['queue', 'nothing waiting'])
  rows.push(['dead', found.dead.count === 0 ? 'none' : `${found.dead.count}, latest ${found.dead.latest} (bx dead-letters)`])
  const failed = found.failures.latest
  rows.push(['failed', failed ? `${failed.at}  ${failed.queue}  ${failed.error}` : 'nothing lately'])
  rows.push(['timers', `${found.timers.count}${found.timers.next ? `, next ${found.timers.next}` : ''}${found.timers.late ? `, ${found.timers.late} late: the alarm isn't running them` : ''}`])
  for (const sync of found.sync) rows.push(['sync', `${sync.key.padEnd(12)} ${sync.ok ? 'ok' : sync.error}`])
  if (found.board === null && found.sync.length === 0) rows.push(['sync', 'none configured'])
  if (found.version !== null) rows.push(['code', found.version === found.worker ? found.version : `${found.version} (the Worker that answered runs ${found.worker})`])
  for (const [label, text] of rows) process.stdout.write(`${label.padEnd(7)} ${text}\n`)
  if (found.sync.some((sync) => !sync.ok) || found.timers.late > 0) process.exitCode = 1
}

/** `bx dead-letters [--consumer <owner>] [--retry <id>] [--name <board>] [--json]`: what a board's queues gave up on. */
async function deadLetters(url: string, args: string[]) {
  const board = flag(args, '--name') ?? process.env.BOARD_NAME
  const query = board ? `?board=${encodeURIComponent(board)}` : ''
  const retry = flag(args, '--retry')
  if (retry !== undefined) {
    await asYou(url, 'POST', `/admin/dead-letters/${encodeURIComponent(retry)}/retry${query}`)
    process.stderr.write(`${retry} is back on its queue\n`)
    return
  }
  const consumer = flag(args, '--consumer')
  const { dead } = (await asYou(url, 'GET', `/admin/dead-letters${query}`)) as unknown as { dead: DeadLetter[] }
  const found = consumer === undefined ? dead : dead.filter((letter) => letter.owner === consumer)
  if (args.includes('--json')) return void process.stdout.write(`${JSON.stringify({ dead: found })}\n`)
  if (found.length === 0) return void process.stderr.write('no dead letters\n')
  for (const letter of found) process.stdout.write(`${letter.id}  ${letter.at}  ${letter.queue}  ${letter.owner}  ${letter.attempts} tries  ${letter.error}\n`)
}

/** `bx gc [--name <board>]`: runs a board's retention now (it also runs daily). */
async function gc(url: string, args: string[]) {
  const board = flag(args, '--name') ?? process.env.BOARD_NAME
  const { collected } = (await asYou(url, 'POST', `/admin/gc${board ? `?board=${encodeURIComponent(board)}` : ''}`)) as unknown as { collected: Collected }
  if (args.includes('--json')) return void process.stdout.write(`${JSON.stringify(collected)}\n`)
  const rows: [string, number][] = [['dead letters', collected.deadLetters], ['inbox ids', collected.inboxIds], ['message copies', collected.messageCopies], ['files', collected.files]]
  for (const [label, count] of rows) process.stdout.write(`${label.padEnd(15)} ${count} removed\n`)
}

/** `bx tokens create|list|revoke`: service tokens (spec 03), for someone who manages every channel. */
async function tokens(url: string, args: string[]) {
  const [, action, ...rest] = args.slice(args.indexOf('tokens'))
  if (action === 'create') {
    const service = flag(rest, '--service') ?? fail('usage: bx tokens create --service <name> [--env <env>] [--ttl 90d]')
    const ttl = flag(rest, '--ttl')
    const board = flag(rest, '--name') ?? process.env.BOARD_NAME
    const made = await asYou(url, 'POST', '/admin/tokens', { service, env: flag(rest, '--env') ?? 'production', ...(ttl ? { ttl: seconds(ttl) } : {}), ...(board ? { board } : {}) })
    process.stderr.write(`${made.sub}, until ${made.expires_at} (revoke with: bx tokens revoke ${made.jti})\n`)
    process.stdout.write(`${made.token}\n`)
    return
  }
  if (action === 'list') {
    const { tokens: found } = (await asYou(url, 'GET', '/admin/tokens')) as { tokens: { jti: string; sub: string; expires_at: string; revoked: boolean; by: string }[] }
    for (const token of found) process.stdout.write(`${token.jti}  ${token.sub}  until ${token.expires_at}${token.revoked ? '  revoked' : ''}  by ${token.by}\n`)
    return
  }
  if (action === 'revoke' && rest[0]) {
    const { revoked } = await asYou(url, 'DELETE', `/admin/tokens/${encodeURIComponent(rest[0])}`)
    if (!revoked) fail(`no token ${rest[0]} on this board`)
    return
  }
  fail('usage: bx tokens create --service <name> [--env <env>] | list | revoke <id>')
}

/**
 * `bx grants create` with bordeaux's own principals, as upstream's flags: `--service www [--env
 * production]` is an oidc grant on the board's own issuer, and `--github-user ada` is ada's GitHub
 * user ID, which a bordeaux person's ID is (spec 03).
 */
async function grantArgs(url: string, argv: string[]): Promise<string[]> {
  const args = [...argv]
  for (let at = args.indexOf('--github-user'); at !== -1; at = args.indexOf('--github-user')) {
    const login = args[at + 1] ?? fail('--github-user: a GitHub login')
    const found = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'bordeaux-bx' } })
    if (!found.ok) fail(`GitHub has no user ${login}`)
    args.splice(at, 2, '--user', String(((await found.json()) as { id: number }).id))
  }
  const service = flag(args, '--service')
  if (service !== undefined) {
    const environment = flag(args, '--env')
    for (const name of ['--service', '--env']) if (args.includes(name)) args.splice(args.indexOf(name), 2)
    args.push('--oidc', url, '--claim', `sub=service:${service}:${environment ?? '*'}`)
  }
  return args
}

const HELP = `bx: a bordeaux board, for people and agents

usage: bx <command> [options]

bordeaux:
  login <url>                         sign in with GitHub
  logout [url]                        forget your sign-in
  list                                the team's boards (--name <board> picks one for any command)
  boards create|delete <name>         make or delete a named board
  export > board.jsonl                a board's whole log (--name <board> for a named one)
  import <file>                       an export, into a board that has nothing yet
  token                               print a fresh access token (export BOARD_TOKEN=$(bx token))
  health                              a board's queues, dead letters, and sync [--json]
  dead-letters [--retry <id>]         what its queues gave up on [--consumer <owner>], or retry one
  gc                                  run a board's retention now (it also runs daily)
  tokens create --service <name>      a service's token, up to 90 days [--env <env>] [--ttl 30d]
  tokens list | revoke <id>           the service tokens, and revoking one
  grants create --service <name>      let a service's tokens in [--env <env>], or
  grants create --github-user <login> a person by their GitHub login, with --can

board commands (upstream's, unchanged):
`

/** Upstream's help, under bordeaux's header: its own first line names Vercel. */
async function help(app: { run(args: string[]): Promise<number> }, args: string[]) {
  process.stdout.write(HELP)
  const write = process.stdout.write.bind(process.stdout)
  let first = true
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (!first) return write(chunk as string, ...(rest as []))
    first = false
    // Its header line, and its usage line, which bordeaux's header has already said.
    const text = String(chunk).replace(/^.*\n\n?(usage:.*\n\n?)?/, '')
    return write(text, ...(rest as []))
  }) as typeof process.stdout.write
  try {
    return await app.run(args)
  } finally {
    process.stdout.write = write
  }
}

async function main(argv: string[]) {
  argv = [...argv]
  const [word] = argv.filter((arg) => !arg.startsWith('-'))
  if (word === 'login') return login(deploymentOf(clean(argv[argv.indexOf('login') + 1] ?? deploymentUrl(argv) ?? fail('usage: bx login <board url>'))))
  if (word === 'logout') {
    const store = load()
    const url = clean(argv[argv.indexOf('logout') + 1] ?? store.current ?? fail("you aren't signed in"))
    delete store.boards[url]
    if (store.current === url) store.current = null
    save(store)
    return
  }
  if (word === 'token') {
    const url = boardUrl(argv) ?? fail('no board: run bx login <url>')
    process.stdout.write(`${await accessToken(url, argv.includes('--fresh'))}\n`)
    return
  }
  // Upstream sends these to Vercel's API; a bordeaux deployment keeps its team's boards itself.
  if (argv.includes('--scope')) fail('--scope names a Vercel team: a bordeaux deployment is one team')
  if (word === 'list' || word === 'boards') return boards(deploymentUrl(argv) ?? fail('no board: run bx login <url>'), argv)
  if (word === 'export' || word === 'import') return exporting(deploymentUrl(argv) ?? fail('no board: run bx login <url>'), argv)
  if (word === 'dead-letters') return deadLetters(deploymentUrl(argv) ?? fail('no board: run bx login <url>'), argv)
  if (word === 'gc') return gc(deploymentUrl(argv) ?? fail('no board: run bx login <url>'), argv)
  if (word === 'health') return health(deploymentUrl(argv) ?? fail('no board: run bx login <url>'), argv)
  if (word === 'tokens') return tokens(deploymentUrl(argv) ?? fail('no board: run bx login <url>'), argv)

  const app = createApp({ appName: 'bx' })
  if (word === undefined || word === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.exitCode = await help(app, argv)
    return
  }
  const url = boardUrl(argv) ?? fail('no board: run bx login <url>')
  const name = flag(argv, '--name') ?? process.env.BOARD_NAME
  if (name !== undefined && argv.includes('--ensure')) await asYou(url, 'POST', '/admin/boards', { name })
  // The board is BOARD_URL alone: upstream reads --name, --ensure, and BOARD_NAME as Vercel's.
  argv = argv.filter((arg, at) => arg !== '--ensure' && arg !== '--name' && argv[at - 1] !== '--name')
  delete process.env.BOARD_NAME
  process.env.BOARD_URL = url
  // A token you set yourself goes as it is, as with vb; otherwise your sign-in's.
  if (!process.env.BOARD_TOKEN) {
    process.env.BOARD_TOKEN = await accessToken(url)
    // A long `tail` or `wait` outlives one token: upstream re-reads BOARD_TOKEN when its own runs out.
    const timer = setInterval(async () => {
      process.env.BOARD_TOKEN = await accessToken(url).catch(() => process.env.BOARD_TOKEN!)
    }, 60_000)
    timer.unref()
  }
  const args = word === 'grants' && (argv.includes('--service') || argv.includes('--github-user')) ? await grantArgs(url, argv) : argv
  process.exitCode = await app.run(args)
}

// A reader that stops early (`bx --help | head`) ends the run, not with a stack trace.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

await main(process.argv.slice(2))
