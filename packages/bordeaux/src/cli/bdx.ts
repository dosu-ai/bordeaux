#!/usr/bin/env node
// `bdx`: bordeaux's CLI (spec 07). Its own commands sign you in; every board command is upstream's,
// embedded with `createApp()` from @vercel/board/cli, run with BOARD_URL and a fresh BOARD_TOKEN set
// in this process. createApp gets no `login` or `token`: both mint through Vercel.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createApp } from '@vercel/board/cli'
import type { Collected, DeadLetter, Health as BoardHealth } from '../engine/engine.ts'
import type { Redacted, Redaction } from '../engine/redact.ts'
import type { Doctor, Everywhere } from '../worker/admin.ts'
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
  process.stderr.write(`bdx: ${message}\n`)
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

/** `bdx login <url>`: GitHub's device flow, through the board's broker. */
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
    process.stderr.write(`🍷 Signed in to ${url} as ${issued.login}\n`)
    return
  }
  fail('the code expired before you entered it: run bdx login again')
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
  const found = await tokenOrWhy(url, force)
  return 'token' in found ? found.token : fail(found.why)
}

/** `accessToken`, saying why there's none instead of exiting: what `bdx doctor` reports. */
async function tokenOrWhy(url: string, force = false): Promise<{ token: string } | { why: string }> {
  const deployment = deploymentOf(url)
  const store = load()
  const saved = store.boards[deployment]
  if (!saved) return { why: `you aren't signed in to ${deployment}: run bdx login ${deployment}` }
  const kept = saved.tokens?.[url]
  if (!force && kept && Date.parse(kept.expires_at) - Date.now() > EARLY_MS) return { token: kept.access_token }
  const renewed = await post(`${deployment}/auth/token`, { grant_type: 'refresh_token', refresh_token: saved.refresh_token, ...(url !== deployment ? { audience: url } : {}) })
  if (renewed.status !== 200) return { why: String((renewed.json as { error_description?: string }).error_description ?? `your sign-in to ${deployment} has ended: run bdx login ${deployment}`) }
  const issued = renewed.json as { access_token: string; refresh_token: string; expires_at: string }
  store.boards[deployment] = { ...saved, refresh_token: issued.refresh_token, tokens: { ...saved.tokens, [url]: { access_token: issued.access_token, expires_at: issued.expires_at } } }
  save(store)
  return { token: issued.access_token }
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

/** `bdx list` and `bdx boards create|delete <name>`: the team's boards (spec 07). */
async function boards(url: string, args: string[]) {
  const [word, action, name] = args.filter((arg) => !arg.startsWith('-'))
  if (word === 'list' || action === 'list' || action === undefined) {
    const { boards: found } = (await asYou(url, 'GET', '/admin/boards')) as { boards: { name: string | null; url: string }[] }
    for (const board of found) process.stdout.write(`${(board.name ?? '(default)').padEnd(24)} ${board.url}\n`)
    return
  }
  if (!name) fail(`usage: bdx boards ${action} <name>`)
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
  fail('usage: bdx list | bdx boards create <name> | bdx boards delete <name>')
}

/** `bdx export [--name <board>] > board.jsonl` and `bdx import <file> [--name <board>]`: a board's whole log. */
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
  const file = args[args.indexOf('import') + 1] ?? fail('usage: bdx import <file.jsonl> [--name <board>]')
  const response = await fetch(`${deployment}/admin/import${query}`, { method: 'POST', headers, body: readFileSync(file, 'utf8') })
  const json = (await response.json().catch(() => ({}))) as { events?: number; error?: { message?: string } }
  if (!response.ok) fail(json.error?.message ?? `import: ${response.status}`)
  process.stderr.write(`imported ${json.events} events\n`)
}

/** `bdx health [--name <board>] [--json]`: how a board stands, and whether its sync reaches each platform. */
async function health(url: string, args: string[]) {
  const board = flag(args, '--name') ?? process.env.BOARD_NAME
  const found = (await asYou(url, 'GET', `/admin/health${board ? `?board=${encodeURIComponent(board)}` : ''}`)) as unknown as Health
  if (args.includes('--json')) return void process.stdout.write(`${JSON.stringify(found)}\n`)
  const rows: [string, string][] = []
  for (const queue of found.queues) rows.push(['queue', `${queue.owner}  ${queue.pending} pending, ${queue.leased} leased, ${queue.retrying} retrying`])
  if (found.queues.length === 0) rows.push(['queue', 'nothing waiting'])
  rows.push(['dead', found.dead.count === 0 ? 'none' : `${found.dead.count}, latest ${found.dead.latest} (bdx dead-letters)`])
  const failed = found.failures.latest
  rows.push(['failed', failed ? `${failed.at}  ${failed.queue}  ${failed.error}` : 'nothing lately'])
  rows.push(['timers', `${found.timers.count}${found.timers.next ? `, next ${found.timers.next}` : ''}${found.timers.late ? `, ${found.timers.late} late: the alarm isn't running them` : ''}`])
  for (const sync of found.sync) rows.push(['sync', `${sync.key.padEnd(12)} ${sync.ok ? 'ok' : sync.error}`])
  if (found.board === null && found.sync.length === 0) rows.push(['sync', 'none configured'])
  if (found.version !== null) rows.push(['code', found.version === found.worker ? found.version : `${found.version} (the Worker that answered runs ${found.worker})`])
  for (const [label, text] of rows) process.stdout.write(`${label.padEnd(7)} ${text}\n`)
  if (found.sync.some((sync) => !sync.ok) || found.timers.late > 0) process.exitCode = 1
}

/** `bdx dead-letters [--consumer <owner>] [--retry <id>] [--name <board>] [--json]`: what a board's queues gave up on. */
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

/** `bdx gc [--name <board>]`: runs a board's retention now (it also runs daily). */
async function gc(url: string, args: string[]) {
  const board = flag(args, '--name') ?? process.env.BOARD_NAME
  const { collected } = (await asYou(url, 'POST', `/admin/gc${board ? `?board=${encodeURIComponent(board)}` : ''}`)) as unknown as { collected: Collected }
  if (args.includes('--json')) return void process.stdout.write(`${JSON.stringify(collected)}\n`)
  const rows: [string, number][] = [['dead letters', collected.deadLetters], ['inbox ids', collected.inboxIds], ['message copies', collected.messageCopies], ['files', collected.files]]
  for (const [label, count] of rows) process.stdout.write(`${label.padEnd(15)} ${count} removed\n`)
}

/** `bdx redact <id> --reason <why> [--everywhere] [--name <board>] [--json]`: scrubs a message that leaked a secret. */
async function redact(url: string, args: string[]) {
  const usage = 'usage: bdx redact <id> --reason <why> [--everywhere]'
  const id = args[args.indexOf('redact') + 1]
  if (id === undefined || id.startsWith('--')) fail(usage)
  const reason = flag(args, '--reason') ?? fail(usage)
  const board = flag(args, '--name') ?? process.env.BOARD_NAME
  const everywhere = args.includes('--everywhere')
  const found = (await asYou(url, 'POST', `/admin/messages/${encodeURIComponent(id.replace(/^#/, ''))}/redact${board ? `?board=${encodeURIComponent(board)}` : ''}`, { reason, everywhere })) as unknown as { redacted: Redacted; everywhere?: Everywhere }
  if (args.includes('--json')) return void process.stdout.write(`${JSON.stringify(found)}\n`)
  const { redacted } = found
  const rows: [string, string][] = [
    ['events', `${redacted.events} rewritten`],
    ['copies', `${redacted.copies} removed`],
    ['queued', `${redacted.queued} removed`],
    ['files', `${redacted.files} deleted`],
  ]
  if (found.everywhere) rows.push(['origin', found.everywhere.deleted ? `${found.everywhere.target} deleted` : `not deleted: ${found.everywhere.error}${found.everywhere.target ? `; delete ${found.everywhere.target} there yourself` : ''}`])
  else if (redacted.origin) rows.push(['origin', `${redacted.origin.subthread ?? redacted.origin.thread} kept (--everywhere deletes it)`])
  process.stderr.write(`#${redacted.id} redacted\n`)
  for (const [label, text] of rows) process.stdout.write(`${label.padEnd(7)} ${text}\n`)
  if (found.everywhere && !found.everywhere.deleted && redacted.origin) process.exitCode = 1
}

/** `bdx redactions [--name <board>] [--json]`: every redaction on a board, oldest first. */
async function redactions(url: string, args: string[]) {
  const board = flag(args, '--name') ?? process.env.BOARD_NAME
  const { redactions } = (await asYou(url, 'GET', `/admin/redactions${board ? `?board=${encodeURIComponent(board)}` : ''}`)) as unknown as { redactions: Redaction[] }
  if (args.includes('--json')) return void process.stdout.write(`${JSON.stringify({ redactions })}\n`)
  if (redactions.length === 0) return void process.stderr.write('no redactions\n')
  const width = Math.max(...redactions.map((one) => one.id.length)) + 1
  for (const one of redactions) process.stdout.write(`${`#${one.id}`.padEnd(width)}  ${one.at}  ${one.by.actor}  ${one.reason}\n`)
}

/** One finding of `bdx doctor`: `fix` is a problem, `note` something to know. */
type Check = { check: string; status: 'ok' | 'note' | 'fix'; says: string }

/** A JWT's header and claims, unverified: the board verifies; this only reads what it says. */
function jwtParts(token: string): { header: { kid?: string }; claims: { iss?: string; aud?: string | string[]; exp?: number } } | null {
  const [header, claims] = token.split('.')
  try {
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return { header: decode(header!), claims: decode(claims!) }
  } catch {
    return null
  }
}

/** How long until `at` (seconds since the epoch), as a person says it. */
const until = (at: number) => {
  const left = at - Date.now() / 1000
  if (left <= 0) return 'expired'
  return left >= 5400 ? `${Math.round(left / 3600)} h` : `${Math.max(1, Math.round(left / 60))} min`
}

/** `bdx doctor [--name <board>] [--json]`: whether this board and your token work together, and why not. */
async function doctor(args: string[]) {
  const board = boardUrl(args) ?? fail('no board: run bdx login <url>')
  const deployment = deploymentOf(board)
  const checks: Check[] = []
  const add = (check: string, status: Check['status'], says: string) => checks.push({ check, status, says })

  // Discovery: the board answers, and says it's at the URL you use (BORDEAUX_URL).
  type Discovery = { url?: string; audience?: string; version?: string }
  let discovery: Discovery | null = null
  try {
    const response = await fetch(`${board}/`, { headers: { accept: 'application/json' } })
    discovery = response.ok ? ((await response.json().catch(() => null)) as Discovery | null) : null
    if (!discovery?.audience) add('discovery', 'fix', `${board}/ answers ${response.status}, not a board: check the URL`)
    else if (clean(discovery.url ?? '') !== board) add('discovery', 'fix', `the board says it's at ${discovery.url}: set BORDEAUX_URL to ${deployment}, the URL people use`)
    else add('discovery', 'ok', `board ${discovery.version} at ${board}`)
    const date = Date.parse(response.headers.get('date') ?? '')
    if (!Number.isNaN(date)) {
      const off = Math.round((Date.now() - date) / 1000)
      add('clock', Math.abs(off) <= 60 ? 'ok' : 'fix', Math.abs(off) <= 60 ? `${Math.abs(off)} s from the board's` : `${Math.abs(off)} s ${off > 0 ? 'ahead of' : 'behind'} the board's: bdx renews tokens by your clock, so set it`)
    }
  } catch (error) {
    add('discovery', 'fix', `${board} doesn't answer: ${(error as Error).message}`)
  }

  const given = process.env.BOARD_TOKEN
  const found = given ? { token: given } : await tokenOrWhy(board)
  if (!('token' in found)) add('token', 'fix', found.why)
  else {
    const parts = jwtParts(found.token)
    if (!parts) add('token', 'fix', `${given ? 'BOARD_TOKEN' : 'the kept token'} isn't a JWT${given ? ': unset it, or set a token from bdx token' : ': run bdx login again'}`)
    else {
      const { header, claims } = parts
      const audiences = typeof claims.aud === 'string' ? [claims.aud] : (claims.aud ?? [])
      if (discovery?.audience)
        add('audience', audiences.includes(discovery.audience) ? 'ok' : 'fix', audiences.includes(discovery.audience) ? `made out to ${discovery.audience}` : `made out to ${audiences.join(', ') || 'no one'}, not ${discovery.audience}: a token is for one board${given ? '; unset BOARD_TOKEN or get one with bdx token' : ''}`)
      if (claims.iss !== deployment) add('issuer', 'note', `${claims.iss ?? 'no issuer'}: not this board's own, so a grant must name it`)
      else {
        const jwks = (await fetch(`${deployment}/.well-known/jwks.json`).then((response) => response.json()).catch(() => null)) as { keys?: { kid?: string }[] } | null
        const known = jwks?.keys?.some((key) => key.kid === header.kid) ?? false
        add('issuer', known ? 'ok' : 'fix', known ? `${claims.iss}, with a key it publishes` : `signed with key ${header.kid ?? '(none)'}, which ${deployment} doesn't publish now: ${given ? 'get a new token' : 'run bdx login again'}`)
      }
      const me = await fetch(`${board}/me`, { headers: { authorization: `Bearer ${found.token}` } })
      const said = (await me.json().catch(() => ({}))) as { handle?: string; error?: { message?: string } }
      add('token', me.ok ? 'ok' : 'fix', me.ok ? `${said.handle}${claims.exp ? `, expires in ${until(claims.exp)}` : ''}` : `the board refuses it (${me.status}): ${said.error?.message ?? 'no reason given'}`)

      // What only the Worker knows, for someone who manages it.
      const deploymentToken = board === deployment || given ? found.token : (await tokenOrWhy(deployment).then((one) => ('token' in one ? one.token : null)))
      const asked = deploymentToken ? await fetch(`${deployment}/admin/doctor`, { headers: { authorization: `Bearer ${deploymentToken}` } }) : null
      if (asked?.ok) {
        const known = (await asked.json()) as Doctor
        if (known.dev) add('dev', 'fix', 'POST /__dev/token mints tokens with no sign-in: remove BORDEAUX_DEV from this deployment')
        const missing: [boolean, string][] = [
          [known.bindings.tail, 'TAIL: long-polls and SSE tails wait in the board\'s own DO'],
          [known.bindings.versionMetadata, 'version_metadata: a deploy waits for a busy board to go idle'],
          [known.bindings.files, 'FILES: attachments are refused'],
          [known.bindings.assets, 'ASSETS: there\'s no inspector at /inspect'],
        ]
        const absent = missing.filter(([present]) => !present)
        if (absent.length === 0) add('bindings', 'ok', 'BOARD, DIRECTORY, TAIL, FILES, ASSETS, version_metadata')
        for (const [, says] of absent) add('bindings', 'note', `no ${says}`)
      } else if (asked?.status === 403) add('bindings', 'note', "only someone who manages every channel can see them")
      else if (asked?.status === 404) add('bindings', 'note', "this deployment doesn't answer /admin/doctor: it's older than this bdx")
    }
  }

  const broken = checks.some((check) => check.status === 'fix')
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify({ board, checks })}\n`)
  else {
    for (const { check, status, says } of checks) process.stdout.write(`${check.padEnd(10)} ${status.padEnd(5)} ${says}\n`)
    if (!broken) process.stderr.write('🍷 all good\n')
  }
  if (broken) process.exitCode = 1
}

/** `bdx tokens create|list|revoke`: service tokens (spec 03), for someone who manages every channel. */
async function tokens(url: string, args: string[]) {
  const [, action, ...rest] = args.slice(args.indexOf('tokens'))
  if (action === 'create') {
    const service = flag(rest, '--service') ?? fail('usage: bdx tokens create --service <name> [--env <env>] [--ttl 90d]')
    const ttl = flag(rest, '--ttl')
    const board = flag(rest, '--name') ?? process.env.BOARD_NAME
    const made = await asYou(url, 'POST', '/admin/tokens', { service, env: flag(rest, '--env') ?? 'production', ...(ttl ? { ttl: seconds(ttl) } : {}), ...(board ? { board } : {}) })
    process.stderr.write(`${made.sub}, until ${made.expires_at} (revoke with: bdx tokens revoke ${made.jti})\n`)
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
  fail('usage: bdx tokens create --service <name> [--env <env>] | list | revoke <id>')
}

/** The words `bdx sync` takes for a hosted team's rows; anything else is upstream's `sync <id> [target]`. */
const SYNC_ACTIONS = new Set(['add', 'rm', 'list', 'link'])

/** `bdx sync add|rm|list|link`: a hosted team's sync, as rows (spec 09), changed and linked by its owners. */
async function syncRows(url: string, args: string[]) {
  const [, action, provider, external, channel] = positionals(args)
  const json = args.includes('--json')
  if (action === 'list') {
    const found = (await asYou(url, 'GET', '/admin/sync')) as { sync: { provider: string; external: string; channel: string; direction: string }[]; providers: { provider: string; linked: boolean; install?: string }[] }
    if (json) return void process.stdout.write(`${JSON.stringify(found)}\n`)
    const width = Math.max(0, ...found.sync.map((row) => `${row.provider}  ${row.external}`.length))
    for (const row of found.sync) process.stdout.write(`${`${row.provider}  ${row.external}`.padEnd(width)}  ${row.channel.padEnd(16)}  ${row.direction}\n`)
    for (const given of found.providers) if (!given.linked && found.sync.some((row) => row.provider === given.provider)) process.stderr.write(`${given.provider} isn't linked yet: ${given.install ?? `bdx sync link ${given.provider}`}\n`)
    return
  }
  if (action === 'add' && provider && external && channel) {
    const made = (await asYou(url, 'POST', '/admin/sync', { provider, external: rowOf(provider, external), channel, direction: args.includes('--mirror') ? 'mirror' : 'into' })) as { created: boolean; linked: boolean; install?: string }
    if (json) return void process.stdout.write(`${JSON.stringify(made)}\n`)
    process.stderr.write(`${made.created ? 'syncing' : 'now syncing'} ${rowOf(provider, external)} ${args.includes('--mirror') ? 'with' : 'into'} ${channel}\n`)
    if (!made.linked && made.install) process.stderr.write(`${linkTo(provider)} to start: ${made.install}\n`)
    return
  }
  if (action === 'link' && provider) {
    const made = (await asYou(url, 'POST', '/admin/sync/link', { provider })) as { linked: boolean; install: string | null }
    if (json) return void process.stdout.write(`${JSON.stringify(made)}\n`)
    if (!made.install) fail(`${provider} has no link to make`)
    process.stderr.write(`${made.linked ? `${provider} is linked already. ` : ''}${linkTo(provider)}: ${made.install}\n`)
    return
  }
  if (action === 'rm' && provider && external) {
    const row = rowOf(provider, external)
    const { removed } = await asYou(url, 'DELETE', `/admin/sync?provider=${encodeURIComponent(provider)}&external=${encodeURIComponent(row)}`)
    if (json) return void process.stdout.write(`${JSON.stringify({ removed })}\n`)
    if (!removed) fail(`this team doesn't sync ${provider} ${row}`)
    return
  }
  fail('usage: bdx sync add github <owner/repo> <channel> [--mirror] | bdx sync add linear <team key> <channel> [--mirror] | bdx sync add slack <C0… | #name> <channel> [--mirror] | bdx sync link github|linear|slack | bdx sync rm <provider> <id> | bdx sync list')
}

/**
 * A row's external ID as the board takes it. A Slack channel's name gets its `#`, which a shell
 * would read as a comment: `bdx sync add slack support support` maps `#support`.
 */
const rowOf = (provider: string, external: string) => (provider === 'slack' && !external.startsWith('#') && !/^[CG][A-Z0-9]{8,}$/.test(external) ? `#${external}` : external)

/** What linking the team to a platform takes: the sync App on its account, or a workspace admin's yes. */
const linkTo = (provider: string) =>
  provider === 'linear' ? 'a Linear workspace admin opens this within 10 minutes to link it'
  : provider === 'slack' ? 'a Slack workspace admin opens this within 10 minutes to install the app'
  : `install the ${provider} sync App on your account`

/**
 * `bdx grants create` with bordeaux's own principals, as upstream's flags: `--service www [--env
 * production]` is an oidc grant on the board's own issuer, and `--github-user ada` is ada's GitHub
 * user ID, which a bordeaux person's ID is (spec 03).
 */
async function grantArgs(url: string, argv: string[]): Promise<string[]> {
  const args = [...argv]
  for (let at = args.indexOf('--github-user'); at !== -1; at = args.indexOf('--github-user')) {
    const login = args[at + 1] ?? fail('--github-user: a GitHub login')
    const found = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'bordeaux-bdx' } })
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

const HELP = `🍷 bdx: a bordeaux board, for people and agents

usage: bdx <command> [options]

bordeaux:
  login <url>                         sign in with GitHub
  logout [url]                        forget your sign-in
  list                                the team's boards (--name <board> picks one for any command)
  boards create|delete <name>         make or delete a named board
  export > board.jsonl                a board's whole log (--name <board> for a named one)
  import <file>                       an export, into a board that has nothing yet
  token                               print a fresh access token (export BOARD_TOKEN=$(bdx token))
  health                              a board's queues, dead letters, and sync [--json]
  dead-letters [--retry <id>]         what its queues gave up on [--consumer <owner>], or retry one
  gc                                  run a board's retention now (it also runs daily)
  redact <id> --reason <why>          scrub a message that leaked a secret [--everywhere]
  doctor                              check the board's URL, your clock, and your token
  redactions                          what's been redacted, and why
  tokens create --service <name>      a service's token, up to 90 days [--env <env>] [--ttl 30d]
  tokens list | revoke <id>           the service tokens, and revoking one
  sync add github <repo> <channel>    hosted: sync a repo into a channel [--mirror]
  sync add linear <team> <channel>    hosted: sync a Linear team, as ENG [--mirror]
  sync add slack <chan> <channel>     hosted: sync C0… or #name [--mirror]
  sync link github|linear|slack       hosted: link the team's account or workspace
  sync rm <provider> <id> | list      stop syncing one, or list them
  grants create --service <name>      let a service's tokens in [--env <env>], or
  grants create --github-user <login> a person by their GitHub login, with --can

board commands (upstream's, unchanged):
`

/** The commands bordeaux answers itself; `grants` is upstream's, with bordeaux's flags added. */
const OWN = new Set(['login', 'logout', 'list', 'boards', 'export', 'import', 'token', 'health', 'dead-letters', 'gc', 'redact', 'doctor', 'redactions', 'tokens'])

/** One of bordeaux's own commands' lines from HELP, or null for upstream's. `sync` is ours only for `add`, `rm`, `list`, and `link`. */
function usageOf(word: string, next: string | undefined): string | null {
  if (!OWN.has(word) && !(word === 'sync' && SYNC_ACTIONS.has(next ?? ''))) return null
  const rows = HELP.split('\n').filter((line) => line.startsWith(`  ${word} `)).map((line) => line.trim().split(/\s{2,}/))
  const width = Math.max(...rows.map(([command]) => command!.length))
  const lines = rows.map(([command, what]) => `  bdx ${command!.padEnd(width)}  ${what}`)
  // Rows that won't fit 80 columns put each description under its command.
  const fit = lines.every((line) => line.length <= 80) ? lines : rows.map(([command, what]) => `  bdx ${command}\n      ${what}`)
  return `usage:\n${fit.join('\n')}\n`
}

/** The arguments that aren't flags, less --name's and --url's values: `bdx --name ops gc` runs gc. */
const positionals = (args: string[]) => args.filter((arg, at) => !arg.startsWith('-') && args[at - 1] !== '--name' && args[at - 1] !== '--url')

/** A board's URL as `bdx login` takes it, or the error that says what it wants instead. */
function boardUrlArg(arg: string): string {
  let url: URL
  try {
    url = new URL(arg)
  } catch {
    return fail(`${arg} isn't a board's URL: bdx login https://<board>`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(`${arg} isn't a board's URL: bdx login https://<board>`)
  return clean(arg)
}

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
  const [word, given] = positionals(argv)
  // bordeaux's own commands answer --help before they read their arguments: upstream's, below.
  const usage = word !== undefined && (argv.includes('--help') || argv.includes('-h')) ? usageOf(word, given) : null
  if (usage) return void process.stdout.write(usage)
  if (word === 'login') return login(deploymentOf(boardUrlArg(given ?? deploymentUrl(argv) ?? fail('usage: bdx login <board url>'))))
  if (word === 'logout') {
    const store = load()
    const url = clean(argv[argv.indexOf('logout') + 1] ?? store.current ?? fail("you aren't signed in"))
    delete store.boards[url]
    if (store.current === url) store.current = null
    save(store)
    return
  }
  if (word === 'token') {
    const url = boardUrl(argv) ?? fail('no board: run bdx login <url>')
    process.stdout.write(`${await accessToken(url, argv.includes('--fresh'))}\n`)
    return
  }
  // Upstream sends these to Vercel's API; a bordeaux deployment keeps its team's boards itself.
  if (argv.includes('--scope')) fail('--scope names a Vercel team: a bordeaux deployment is one team')
  if (word === 'list' || word === 'boards') return boards(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)
  if (word === 'export' || word === 'import') return exporting(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)
  if (word === 'dead-letters') return deadLetters(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)
  if (word === 'doctor') return doctor(argv)
  if (word === 'redact') return redact(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)
  if (word === 'redactions') return redactions(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)
  if (word === 'gc') return gc(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)
  if (word === 'health') return health(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)
  if (word === 'tokens') return tokens(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)
  // `sync add|rm|list|link` are a hosted team's rows; `sync <id> [target]` is upstream's.
  if (word === 'sync' && SYNC_ACTIONS.has(given ?? '')) return syncRows(deploymentUrl(argv) ?? fail('no board: run bdx login <url>'), argv)

  const app = createApp({ appName: 'bdx' })
  if (word === undefined || word === 'help' || argv.includes('--help') || argv.includes('-h')) {
    process.exitCode = await help(app, argv)
    return
  }
  const url = boardUrl(argv) ?? fail('no board: run bdx login <url>')
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

// A reader that stops early (`bdx --help | head`) ends the run, not with a stack trace.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0)
  throw error
})

await main(process.argv.slice(2))
