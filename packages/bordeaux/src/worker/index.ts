// The bordeaux Worker: upstream's board() (default build) on the `durable()` backend, with
// bordeaux's verifier chain, its token broker, and the hooks upstream expects from Vercel.
import { AsyncLocalStorage } from 'node:async_hooks'
import { board } from '@vercel/board'
import { bordeauxTokens, directory } from './auth.ts'
import { durable } from './backend.ts'
import { broker } from './broker.ts'
import type { BordeauxEnv } from './env.ts'

export { BoardDO } from '../engine/do.ts'
export { DirectoryDO } from './directory.ts'

// Upstream's waitUntil looks up Vercel's request context: it gets the Worker's own (spec 08, M0).
const requestContext = new AsyncLocalStorage<{ waitUntil(promise: Promise<unknown>): void }>()
Reflect.set(globalThis, Symbol.for('@vercel/request-context'), { get: () => requestContext.getStore() })

let team: ReturnType<typeof board> | null = null

function boardOf(env: BordeauxEnv) {
  if (!env.BORDEAUX_URL) throw new Error('BORDEAUX_URL is required: the board\'s public URL, which every token is for')
  team ??= board({
    backend: durable(env),
    url: env.BORDEAUX_URL,
    authenticate: (request) => bordeauxTokens(env, request.credential),
  })
  return team
}

async function devToken(request: Request, env: BordeauxEnv): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { id?: number | string; login?: string; ttl?: number }
  const id = String(body.id ?? 1)
  if (!/^\d+$/.test(id)) return Response.json({ error: { code: 'invalid_request', message: 'id: a GitHub user ID' } }, { status: 400 })
  const login = body.login ?? `dev${id}`
  const dir = directory(env)
  const { token, expiresAt } = await dir.mint({ sub: `user:${id}`, login }, Math.min(body.ttl ?? 3600, 12 * 3600))
  // A sign-in too, so `bx` can be run against a local board with no GitHub App.
  const refresh = await dir.startSession({ id, login, owner: false, checkedAt: Date.now(), expiresAt: Date.now() + 24 * 3600 * 1000 })
  return Response.json({ access_token: token, token_type: 'Bearer', expires_at: new Date(expiresAt).toISOString(), refresh_token: refresh, login })
}

export default {
  async fetch(request: Request, env: BordeauxEnv, ctx: ExecutionContext): Promise<Response> {
    return requestContext.run(ctx, async () => {
      const { pathname } = new URL(request.url)
      if (pathname === '/.well-known/jwks.json') return Response.json(await directory(env).jwks(), { headers: { 'cache-control': 'public, max-age=300' } })
      if (pathname.startsWith('/auth/')) return broker(request, env)
      if (pathname === '/__dev/token' && request.method === 'POST') {
        if (env.BORDEAUX_DEV !== '1') return new Response('not found', { status: 404 })
        return devToken(request, env)
      }
      return boardOf(env).fetch(request)
    })
  },
} satisfies ExportedHandler<BordeauxEnv>
