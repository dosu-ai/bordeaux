#!/usr/bin/env node
// `bx`: bordeaux's CLI (spec 07). Its own commands sign you in; every board command is upstream's,
// embedded with `createApp()` from @vercel/board/cli, run with BOARD_URL and a fresh BOARD_TOKEN set
// in this process. createApp gets no `login` or `token`: both mint through Vercel.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createApp } from '@vercel/board/cli'

type Saved = { url: string; login: string; refresh_token: string; access_token?: string; expires_at?: string }
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
    store.boards[url] = { url, login: issued.login, refresh_token: issued.refresh_token, access_token: issued.access_token, expires_at: issued.expires_at }
    store.current = url
    save(store)
    process.stderr.write(`Signed in to ${url} as ${issued.login}\n`)
    return
  }
  fail('the code expired before you entered it: run bx login again')
}

/** The board this run uses: --url, BOARD_URL, or the one you last signed in to. */
function boardUrl(args: string[]): string | null {
  const at = args.indexOf('--url')
  if (at !== -1 && args[at + 1]) return clean(args[at + 1]!)
  if (process.env.BOARD_URL) return clean(process.env.BOARD_URL)
  return load().current
}

/** A fresh access token for `url`, renewing the sign-in when it's close to running out. */
async function accessToken(url: string, force = false): Promise<string> {
  const store = load()
  const saved = store.boards[url]
  if (!saved) return fail(`you aren't signed in to ${url}: run bx login ${url}`)
  if (!force && saved.access_token && saved.expires_at && Date.parse(saved.expires_at) - Date.now() > EARLY_MS) return saved.access_token
  const renewed = await post(`${url}/auth/token`, { grant_type: 'refresh_token', refresh_token: saved.refresh_token })
  if (renewed.status !== 200) return fail(`your sign-in to ${url} has ended: run bx login ${url}`)
  const issued = renewed.json as { access_token: string; refresh_token: string; expires_at: string }
  store.boards[url] = { ...saved, refresh_token: issued.refresh_token, access_token: issued.access_token, expires_at: issued.expires_at }
  save(store)
  return issued.access_token
}

const HELP = `bx: a bordeaux board, for people and agents

usage: bx <command> [options]

bordeaux:
  login <url>                         sign in with GitHub
  logout [url]                        forget your sign-in
  token                               print a fresh access token (export BOARD_TOKEN=$(bx token))

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
  const [word] = argv.filter((arg) => !arg.startsWith('-'))
  if (word === 'login') return login(clean(argv[argv.indexOf('login') + 1] ?? boardUrl(argv) ?? fail('usage: bx login <board url>')))
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
  // Upstream sends these to Vercel's API: a bordeaux deployment names its boards itself (M2).
  if (word === 'list' || argv.includes('--name') || argv.includes('--scope') || argv.includes('--ensure') || process.env.BOARD_NAME)
    fail("named boards come with bordeaux's next milestone: use the board's URL")

  const app = createApp({ appName: 'bx' })
  if (word === undefined || word === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.exitCode = await help(app, argv)
    return
  }
  const url = boardUrl(argv) ?? fail('no board: run bx login <url>')
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
  process.exitCode = await app.run(argv)
}

await main(process.argv.slice(2))
