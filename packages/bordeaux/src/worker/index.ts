// The bordeaux Worker: upstream's board() (default build) on the `durable()` backend, with
// bordeaux's verifier chain, its token broker, and the hooks upstream expects from Vercel.
import { AsyncLocalStorage } from 'node:async_hooks'
import { directory, revokedToken } from './auth.ts'
import { admin } from './admin.ts'
import { boardNamed, boardOf, BOARD_NAME, exists } from './boards.ts'
import { putUpload, UPLOADS } from './uploads.ts'
import { broker } from './broker.ts'
import type { BordeauxEnv } from './env.ts'

import { inspect } from './inspect.ts'
import { collectAll, GC_CRON, scheduledCheck } from './health.ts'
export { BoardDO } from '../engine/do.ts'
export { TailDO } from '../engine/tail.ts'
export { configure, type BordeauxConfig } from './config.ts'
export { DirectoryDO } from './directory.ts'

// Upstream's waitUntil looks up Vercel's request context: it gets the Worker's own (spec 08, M0).
const requestContext = new AsyncLocalStorage<{ waitUntil(promise: Promise<unknown>): void }>()
Reflect.set(globalThis, Symbol.for('@vercel/request-context'), { get: () => requestContext.getStore() })

async function devToken(request: Request, env: BordeauxEnv): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { id?: number | string; login?: string; ttl?: number; audience?: string }
  const id = String(body.id ?? 1)
  if (!/^\d+$/.test(id)) return Response.json({ error: { code: 'invalid_request', message: 'id: a GitHub user ID' } }, { status: 400 })
  if (body.audience !== undefined && boardNamed(env, body.audience) === undefined) return Response.json({ error: { code: 'invalid_request', message: 'audience: one of this deployment\'s boards' } }, { status: 400 })
  const login = body.login ?? `dev${id}`
  const dir = directory(env)
  const { token, expiresAt } = await dir.mint({ sub: `user:${id}`, login }, Math.min(body.ttl ?? 3600, 12 * 3600), body.audience)
  // A sign-in too, so `bx` can be run against a local board with no GitHub App.
  const refresh = await dir.startSession({ id, login, owner: false, checkedAt: Date.now(), expiresAt: Date.now() + 24 * 3600 * 1000 })
  return Response.json({ access_token: token, token_type: 'Bearer', expires_at: new Date(expiresAt).toISOString(), refresh_token: refresh, login })
}

export default {
  async fetch(request: Request, env: BordeauxEnv, ctx: ExecutionContext): Promise<Response> {
    return requestContext.run(ctx, async () => {
      const { pathname } = new URL(request.url)
      const revoked = await revokedToken(env, request)
      if (revoked) return revoked
      if (pathname === '/.well-known/jwks.json') return Response.json(await directory(env).jwks(), { headers: { 'cache-control': 'public, max-age=300' } })
      if (pathname.startsWith('/auth/')) return broker(request, env)
      if (pathname.startsWith('/admin/')) {
        // Who's asking, as the default board knows them.
        const team = boardOf(env, null)
        return admin(request, env, (asked) => team.fetch(new Request(new URL('/me', asked.url), { headers: asked.headers })))
      }
      if (pathname === '/__dev/token' && request.method === 'POST') {
        if (env.BORDEAUX_DEV !== '1') return new Response('not found', { status: 404 })
        return devToken(request, env)
      }
      // A named board at /b/<name>/, which the team must have made; the default board at the root.
      const named = /^\/b\/([^/]+)(?:\/|$)/.exec(pathname)
      if (named) {
        const name = named[1]!
        if (!BOARD_NAME.test(name) || !(await exists(env, name)))
          return Response.json({ error: { code: 'no_board', message: `this team has no board named ${name}: bx boards create ${name}` } }, { status: 404 })
        const rest = pathname.slice(`/b/${name}`.length)
        if (rest.startsWith(UPLOADS)) return putUpload(request, env, name.toLowerCase(), rest.slice(UPLOADS.length))
        if (rest === '/inspect' || rest.startsWith('/inspect/')) {
          const lower = name.toLowerCase()
          // One path per board, as its sign-in cookies are: `/b/Ops/inspect` is `/b/ops/inspect`.
          if (name !== lower) {
            const url = new URL(request.url)
            url.pathname = `/b/${lower}${rest}`
            return Response.redirect(url.toString(), 301)
          }
          const board = boardOf(env, name)
          return inspect(request, env, { name: lower, url: `${env.BORDEAUX_URL}/b/${lower}`, base: `/b/${lower}/inspect`, fetch: (asked) => board.fetch(asked) })
        }
        return boardOf(env, name).fetch(request)
      }
      if (pathname.startsWith(UPLOADS)) return putUpload(request, env, null, pathname.slice(UPLOADS.length))
      if (pathname === '/inspect' || pathname.startsWith('/inspect/')) {
        const board = boardOf(env, null)
        return inspect(request, env, { name: null, url: env.BORDEAUX_URL, base: '/inspect', fetch: (asked) => board.fetch(asked) })
      }
      return boardOf(env, null).fetch(request)
    })
  },

  /** A cron (`triggers.crons` in wrangler.jsonc): retention daily at GC_CRON, else a sync check. */
  async scheduled(controller: ScheduledController, env: BordeauxEnv): Promise<void> {
    if (controller.cron === GC_CRON) await collectAll(env)
    else await scheduledCheck(env)
  },
} satisfies ExportedHandler<BordeauxEnv>
