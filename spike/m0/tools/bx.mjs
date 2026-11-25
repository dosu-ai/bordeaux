#!/usr/bin/env node
// M0 spike prototype of `bx` (spec 07): our commands first, everything else to upstream's
// createApp() with BOARD_URL and a fresh BOARD_TOKEN set in-process. No login/token options.
// Spike-only: tokens are minted locally with the spike secret instead of `bx login`.
import { createApp } from '@vercel/board/cli'
import { SignJWT, decodeJwt } from 'jose'

const BASE = process.env.BX_BASE ?? 'http://127.0.0.1:8787'
const TTL = Number(process.env.BX_TTL ?? 3600) // seconds; short in the refresh check
const log = (...a) => process.env.BX_DEBUG && console.error('[bx]', ...a)

async function mint(aud) {
  const jti = crypto.randomUUID().slice(0, 8)
  return new SignJWT({ login: 'octocat', jti }).setProtectedHeader({ alg: 'HS256' })
    .setSubject('583231').setAudience(aud).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + TTL)
    .sign(new TextEncoder().encode('spike-only-not-a-secret'))
}

const args = process.argv.slice(2)
const word = args.find((a) => !a.startsWith('-'))

// 1. bordeaux's own commands.
if (word === 'token') { console.log(await mint(BASE)); process.exit(0) }
if (word === 'list') { console.log('default\n(bx list: from the DirectoryDO in the real thing)'); process.exit(0) }

// 2. Flags upstream would send to Vercel's API: --name picks /b/<name>, --scope/--ensure aren't ours.
let url = process.env.BOARD_URL ?? BASE
const named = args.indexOf('--name')
if (named !== -1) { url = `${BASE}/b/${args[named + 1]}`; args.splice(named, 2) }
if (args.includes('--scope')) { console.error('bx: --scope is a Vercel team; a bordeaux deployment is one team'); process.exit(2) }

// 3. Everything else: upstream, in-process.
process.env.BOARD_URL = url
process.env.BOARD_TOKEN = await mint(url)
log('url', url, 'jti', decodeJwt(process.env.BOARD_TOKEN).jti)
// Upstream re-reads BOARD_TOKEN once its cached one is within 60 s of exp: refresh ahead of that.
const refreshEvery = Math.max(5, TTL - 90) * 1000
const timer = setInterval(async () => {
  process.env.BOARD_TOKEN = await mint(url)
  log('refreshed, jti', decodeJwt(process.env.BOARD_TOKEN).jti)
}, refreshEvery)
timer.unref()

const app = createApp({ appName: 'bx' })
process.exitCode = await app.run(args)
