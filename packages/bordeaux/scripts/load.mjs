#!/usr/bin/env node
// Load test (spec 08, "Testing"): post, thread-read, and channel-threads latency on a board of
// 10k and 100k messages, and what 1, 10, and 50 SSE tails add to a post. Runs against a fresh
// local `wrangler dev` board (workerd and its SQLite, on this machine), through the Worker, as
// a client sees it: auth, board(), RPC, and the Durable Object.
//
//   node scripts/load.mjs                                  # 10k and 100k, tails 0,1,10,50
//   node scripts/load.mjs --sizes 2000 --tails 0,10 --samples 50
//   BOARD_TOKEN=… node scripts/load.mjs --url https://board.acme.dev/b/load --sizes 10000
//
// `--url` measures a deployed board instead, as BOARD_TOKEN: use a board of its own, since
// seeding posts thousands of messages to it.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (name, fallback) => {
  const at = process.argv.indexOf(name)
  return at === -1 ? fallback : process.argv[at + 1]
}
const sizes = arg('--sizes', '10000,100000').split(',').map(Number)
const tails = arg('--tails', '0,1,10,50').split(',').map(Number)
const samples = Number(arg('--samples', '200'))
const CHANNELS = 10
// About 1 KB, as upstream's benchmark messages are.
const TEXT = 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(18)

const freePort = () =>
  new Promise((done) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })

const deployed = arg('--url', null)?.replace(/\/+$/, '') ?? null
if (deployed && !process.env.BOARD_TOKEN) throw new Error('--url needs BOARD_TOKEN: a token for that board')
const port = deployed ? 0 : await freePort()
const url = deployed ?? `http://127.0.0.1:${port}`
const state = deployed ? null : mkdtempSync(join(tmpdir(), 'bordeaux-load-'))
const dev = deployed
  ? null
  : spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--var', `BORDEAUX_URL:${url}`, '--var', 'BORDEAUX_DEV:1'], {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
const stop = () => {
  dev?.kill('SIGTERM')
  if (state) rmSync(state, { recursive: true, force: true })
}
process.on('exit', stop)
process.on('SIGINT', () => process.exit(130))

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
const summary = (times) => {
  const sorted = [...times].sort((a, b) => a - b)
  return { p50: percentile(sorted, 50), p99: percentile(sorted, 99) }
}
const ms = (value) => `${value.toFixed(1)} ms`

let token = ''
const request = async (method, path, body) => {
  const send = () => fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  // A server closes a connection now and then (HTTP/2 GOAWAY): that's the network, so send again.
  let response
  for (let tries = 1; ; tries++) {
    try {
      response = await send()
      break
    } catch (error) {
      if (tries === 3) throw error
    }
  }
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

/** Times `once` `samples` times, one after another. */
async function timed(once) {
  const times = []
  for (let i = 0; i < samples; i++) {
    const started = performance.now()
    await once(i)
    times.push(performance.now() - started)
  }
  return summary(times)
}

const roots = []
let posted = 0
/** Posts until the board has `total` messages: a root in every five, the rest replies, across the channels. */
async function seed(total) {
  const width = 16
  const started = performance.now()
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (posted < total) {
        const n = posted++
        const channel = `load-${n % CHANNELS}`
        const re = n % 5 === 0 || roots.length < CHANNELS ? undefined : roots[(roots.length - 1 - (n % CHANNELS)) % roots.length]
        const { message } = await request('POST', '/messages', re ? { re, text: `${n} ${TEXT}` } : { channel, text: `${n} ${TEXT}` })
        if (!re) roots.push(message.id)
      }
    }),
  )
  process.stderr.write(`seeded ${total} messages in ${((performance.now() - started) / 1000).toFixed(0)} s\n`)
}

/** `count` SSE tails on the whole board, in a process of their own (`scripts/tails.mjs`): stopped by the returned function. */
async function openTails(count) {
  if (count === 0) return () => {}
  const child = spawn(process.execPath, [join(root, 'scripts/tails.mjs'), url, String(count)], { env: { ...process.env, BOARD_TOKEN: token }, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve) => child.stdout.once('data', resolve))
  return () => child.kill('SIGTERM')
}

try {
  for (let tries = 0; ; tries++) {
    try {
      if ((await fetch(url)).status < 500) break
    } catch {}
    if (tries > 60) throw new Error(`the board didn't start at ${url}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  token = deployed ? process.env.BOARD_TOKEN : (await (await fetch(`${url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: 1, login: 'load', ttl: 12 * 3600 }) })).json()).access_token

  const rows = []
  for (const size of sizes) {
    await seed(size)
    const post = await timed((i) => request('POST', '/messages', { channel: `load-${i % CHANNELS}`, text: `sample ${i} ${TEXT}` }))
    posted += samples
    const thread = await timed((i) => request('GET', `/messages/${encodeURIComponent(roots[(i * 7919) % roots.length])}`))
    const threads = await timed((i) => request('GET', `/threads?channel=load-${i % CHANNELS}&limit=20`))
    rows.push({ size, post, thread, threads })
  }
  console.log('| Messages | Post p50 / p99 | Thread read p50 / p99 | Channel\'s threads p50 / p99 |')
  console.log('| --- | --- | --- | --- |')
  for (const { size, post, thread, threads } of rows) console.log(`| ${size.toLocaleString('en-US')} | ${ms(post.p50)} / ${ms(post.p99)} | ${ms(thread.p50)} / ${ms(thread.p99)} | ${ms(threads.p50)} / ${ms(threads.p99)} |`)

  console.log(`\n| SSE tails | Post p50 / p99 | p99 added |`)
  console.log('| --- | --- | --- |')
  let base = null
  for (const count of tails) {
    const close = await openTails(count)
    // Let every tail's first page land and its wait start before timing.
    await new Promise((r) => setTimeout(r, 2000))
    const post = await timed((i) => request('POST', '/messages', { channel: `load-${i % CHANNELS}`, text: `tailed ${i} ${TEXT}` }))
    close()
    base ??= post.p99
    console.log(`| ${count} | ${ms(post.p50)} / ${ms(post.p99)} | ${ms(post.p99 - base)} |`)
  }
} finally {
  stop()
}
