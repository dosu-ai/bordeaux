// The hosted inspector (spec 07, "Inspector"): upstream's page at `<board>/inspect`, acting as the
// person signed in to it. Upstream's in-app `inspector()` reads its bundle with node:fs and acts as
// the app under a profile the visitor names; this handler serves the same page and proxy contract,
// with the bundle from Static Assets and the visitor signed in with GitHub (spec 03's web flow).
//
// Δ The page is upstream's in its local mode (`vb inspect`): who it acts as is "you", so it asks
// no one to name themselves before it loads.
import { ATTACHMENT_BYTES_MAX } from '../upstream/contract/schemas.ts'
import { CSP, relative, shell } from '../upstream/inspect/shell.ts'
import { directory } from './auth.ts'
import { member, renewed, tokensFor, REFRESH_TTL_MS } from './broker.ts'
import type { BordeauxEnv } from './env.ts'

/** The page's credential for its proxy: no secret, a header no other site's page can send without asking first (upstream's). */
const TOKEN = 'page'
/** A JSON body the inspector reads whole: everything but an upload. */
const BODY_MAX = 1024 * 1024
/** How long before its access token expires the proxy renews it. */
const RENEW_MS = 10 * 60 * 1000
/** Where GitHub sends a person back to: one URL for every board, which the App names as its callback. */
export const CALLBACK = '/inspect/callback'

const ACCESS_COOKIE = 'bx_inspect'
const REFRESH_COOKIE = 'bx_inspect_refresh'
const STATE_COOKIE = 'bx_inspect_state'

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const text = (status: number, body: string, headers: HeadersInit = {}) =>
  new Response(body, { status, headers: { ...HEADERS, 'content-type': 'text/plain; charset=utf-8', ...headers } })
const json = (status: number, body: unknown) => Response.json(body, { status, headers: HEADERS })

/** A board as the inspector serves it: where its page is, the URL its tokens name, and what answers its API. */
export type InspectedBoard = { name: string | null; url: string; base: string; fetch(request: Request): Promise<Response> }

export async function inspect(request: Request, env: BordeauxEnv, board: InspectedBoard): Promise<Response> {
  const url = new URL(request.url)
  const at = url.pathname.slice(board.base.length) || '/'
  if (at === '/board' || at.startsWith('/board/')) return proxy(request, env, board, at.slice('/board'.length) || '/', url.search)
  if (board.name === null && url.pathname === CALLBACK) return callback(request, env)
  if (at === '/login') return login(request, env, board)
  if (at === '/logout') return logout(request, env, board)
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed')
  if (at === '/app.js') {
    const script = await env.ASSETS?.fetch(new Request(new URL('/app.js', url)))
    if (!script?.ok) return text(503, "the inspector's UI isn't installed: bind @vercel/board's dist/inspect as ASSETS")
    return new Response(script.body, { headers: { ...HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable' } })
  }
  if (at !== '/') return Response.redirect(new URL(`${board.base}/`, url).toString(), 302)

  // The page itself, for someone signed in to this board: otherwise to sign in, and back.
  const session = await signedIn(request, env, board)
  if (!session) return Response.redirect(new URL(`${board.base}/login`, url).toString(), 302)
  return new Response(shell({ token: TOKEN, profile: null, base: board.base }), {
    headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, ...session.headers },
  })
}

// --- Who's looking: a sign-in kept in two cookies on the board's /inspect path. ---

const cookies = (request: Request) =>
  Object.fromEntries(
    (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter((pair) => pair.length >= 2)
      .map(([name, ...value]) => [name!, decodeURIComponent(value.join('='))]),
  ) as Record<string, string | undefined>

function cookie(env: BordeauxEnv, name: string, value: string, path: string, maxAge: number): string {
  const secure = env.BORDEAUX_URL.startsWith('https:') ? '; Secure' : ''
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`
}

/** When a token expires, as its payload says: the board checks the rest. */
function expiryOf(token: string): number {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/'))) as { exp?: number }
    return (payload.exp ?? 0) * 1000
  } catch {
    return 0
  }
}

function sessionCookies(env: BordeauxEnv, base: string, tokens: { access: string; expiresAt: number; refresh: string }): Headers {
  const headers = new Headers()
  headers.append('set-cookie', cookie(env, ACCESS_COOKIE, tokens.access, base, Math.floor((tokens.expiresAt - Date.now()) / 1000)))
  headers.append('set-cookie', cookie(env, REFRESH_COOKIE, tokens.refresh, base, Math.floor(REFRESH_TTL_MS / 1000)))
  return headers
}

/**
 * The visitor's access token for this board, renewed once it's close to expiring, and the cookies
 * that keep the renewal. A renewal that loses a race with another of the page's requests keeps the
 * token it has, while it lasts.
 */
async function signedIn(request: Request, env: BordeauxEnv, board: InspectedBoard): Promise<{ token: string; headers: Record<string, string> | Headers } | null> {
  const jar = cookies(request)
  const access = jar[ACCESS_COOKIE]
  const left = access ? expiryOf(access) - Date.now() : 0
  if (access && left > RENEW_MS) return { token: access, headers: {} }
  const refresh = jar[REFRESH_COOKIE]
  const session = refresh ? await directory(env).takeSession(refresh) : null
  const next = session && (await renewed(env, session, fetch))
  if (!next || next instanceof Response) return access && left > 0 ? { token: access, headers: {} } : null
  const tokens = await tokensFor(env, next, board.url)
  return { token: tokens.access, headers: sessionCookies(env, board.base, tokens) }
}

async function login(request: Request, env: BordeauxEnv, board: InspectedBoard): Promise<Response> {
  const url = new URL(request.url)
  const home = new URL(`${board.base}/`, url).toString()
  // A local board that can't run GitHub's web flow signs in as a made-up person, as `POST /__dev/token` does.
  if (env.BORDEAUX_DEV === '1' && (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)) {
    const id = /^\d+$/.test(url.searchParams.get('id') ?? '') ? url.searchParams.get('id')! : '1'
    const tokens = await tokensFor(env, { id, login: url.searchParams.get('login') ?? `dev${id}`, owner: false, checkedAt: Date.now(), expiresAt: Date.now() + REFRESH_TTL_MS }, board.url)
    const headers = sessionCookies(env, board.base, tokens)
    headers.set('location', home)
    return new Response(null, { status: 302, headers })
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET)
    return text(501, 'this board has no GitHub App to sign in to its inspector with: set GITHUB_CLIENT_ID and the GITHUB_CLIENT_SECRET secret')
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  const authorize = new URL('https://github.com/login/oauth/authorize')
  authorize.searchParams.set('client_id', env.GITHUB_CLIENT_ID)
  authorize.searchParams.set('redirect_uri', `${env.BORDEAUX_URL}${CALLBACK}`)
  authorize.searchParams.set('state', state)
  const headers = new Headers({ location: authorize.toString(), ...HEADERS })
  // Which board to come back to rides with the state, which only this browser has.
  headers.append('set-cookie', cookie(env, STATE_COOKIE, `${state}.${board.name ?? ''}`, CALLBACK, 600))
  return new Response(null, { status: 302, headers })
}

/** GitHub's redirect back: the code becomes a GitHub token, used once to check membership, then the board's tokens. */
async function callback(request: Request, env: BordeauxEnv): Promise<Response> {
  const url = new URL(request.url)
  const [state, name] = (cookies(request)[STATE_COOKIE] ?? '').split('.')
  if (!state || state !== url.searchParams.get('state')) return text(400, 'that sign-in has expired or came from somewhere else: open the inspector again')
  const code = url.searchParams.get('code')
  if (!code) return text(400, `GitHub didn't sign you in: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'no code'}`)
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return text(501, 'this board has no GitHub App to sign in with')
  const exchanged = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${env.BORDEAUX_URL}${CALLBACK}` }),
  })
  const answer = (await exchanged.json().catch(() => ({}))) as { access_token?: string; error_description?: string }
  if (!answer.access_token) return text(400, `GitHub gave no token: ${answer.error_description ?? exchanged.status}`)
  const who = await member(fetch, env, answer.access_token)
  if (who instanceof Response) return text(who.status, ((await who.json()) as { error_description: string }).error_description)
  const base = name ? `/b/${name}/inspect` : '/inspect'
  const boardUrl = name ? `${env.BORDEAUX_URL}/b/${name}` : env.BORDEAUX_URL
  const tokens = await tokensFor(env, { ...who, checkedAt: Date.now(), expiresAt: Date.now() + REFRESH_TTL_MS }, boardUrl)
  const headers = sessionCookies(env, base, tokens)
  headers.append('set-cookie', cookie(env, STATE_COOKIE, '', CALLBACK, 0))
  headers.set('location', `${base}/`)
  return new Response(null, { status: 302, headers })
}

async function logout(request: Request, env: BordeauxEnv, board: InspectedBoard): Promise<Response> {
  const refresh = cookies(request)[REFRESH_COOKIE]
  if (refresh) await directory(env).takeSession(refresh)
  const headers = new Headers({ ...HEADERS, 'content-type': 'text/plain; charset=utf-8' })
  headers.append('set-cookie', cookie(env, ACCESS_COOKIE, '', board.base, 0))
  headers.append('set-cookie', cookie(env, REFRESH_COOKIE, '', board.base, 0))
  return new Response('signed out', { headers })
}

// --- The page's proxy: upstream's rules, acting as the person signed in. ---

async function proxy(request: Request, env: BordeauxEnv, board: InspectedBoard, path: string, search: string): Promise<Response> {
  const reading = request.method === 'GET' || request.method === 'HEAD'
  const site = request.headers.get('sec-fetch-site')
  if (request.headers.get('x-inspect-token') !== TOKEN || (site !== null && site !== 'same-origin') || (!reading && !sameOrigin(request)))
    return json(403, { error: { code: 'forbidden', message: "the board is reachable only from the inspector's own page" } })
  if (relative(path)) return json(400, { error: { code: 'bad_path', message: 'no relative paths' } })
  const session = await signedIn(request, env, board)
  if (!session) return json(401, { error: { code: 'unauthorized', message: `you're signed out: open ${board.base}/ to sign in again` } })

  let body: Uint8Array | undefined
  if (!reading) {
    const limit = path === '/attachments' ? ATTACHMENT_BYTES_MAX : BODY_MAX
    const read = await readUpTo(request, limit)
    if (read === null) return json(413, { error: { code: 'too_large', message: `a request to the inspector is at most ${limit} bytes` } })
    body = read
  }
  const headers = new Headers({ authorization: `Bearer ${session.token}` })
  for (const name of ['content-type', 'accept', 'x-board-filename', 'x-board-profile']) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  const answer = await board.fetch(new Request(`${board.url}${path}${search}`, { method: request.method, headers, ...(body ? { body } : {}), signal: request.signal }))
  const out = new Headers({ ...HEADERS, 'content-type': answer.headers.get('content-type') ?? 'application/json' })
  for (const set of new Headers(session.headers).getSetCookie()) out.append('set-cookie', set)
  return new Response(answer.body, { status: answer.status, headers: out })
}

/** A request's body, or null once it's more than `limit` bytes (upstream `readUpTo`). */
async function readUpTo(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return null
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** A write's `Origin` is this server's, as the request reached it. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (origin === null) return false
  const host = URL.parse(origin)?.host
  return host !== undefined && (host === new URL(request.url).host || host === request.headers.get('host'))
}
