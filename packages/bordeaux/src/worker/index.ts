// The bordeaux Worker: upstream's board() (default build) on the `durable()` backend, with
// bordeaux's verifier chain, its token broker, and the hooks upstream expects from Vercel.
import { AsyncLocalStorage } from 'node:async_hooks'
import { directory, revokedToken } from './auth.ts'
import { admin } from './admin.ts'
import { boardOf, boardUrl, BOARD_NAME, exists } from './boards.ts'
import { putUpload, UPLOADS } from './uploads.ts'
import { broker } from './broker.ts'
import type { BordeauxEnv } from './env.ts'
import { envTeam, hubOf, teamAt, type Team } from './team.ts'
import { hub } from './hub.ts'
import { devSignIn } from './dev.ts'
import { fanOut, tend } from './operate.ts'

import { inspect } from './inspect.ts'
import { collectAll, GC_CRON, scheduledCheck } from './health.ts'
export { BoardDO } from '../engine/do.ts'
export { TailDO } from '../engine/tail.ts'
export { configure, type BordeauxConfig } from './config.ts'
export { DirectoryDO } from './directory.ts'
export { RegistryDO } from './registry.ts'

// Upstream's waitUntil looks up Vercel's request context: it gets the Worker's own (spec 08).
const requestContext = new AsyncLocalStorage<{ waitUntil(promise: Promise<unknown>): void }>()
Reflect.set(globalThis, Symbol.for('@vercel/request-context'), { get: () => requestContext.getStore() })

/** One request to one of the team's boards, or to its routes beside them. */
async function route(request: Request, env: BordeauxEnv, team: Team): Promise<Response> {
  const { pathname } = new URL(request.url)
  // A hosted team's platforms reach its board only through the hub, which found the team by the event.
  if (env.BORDEAUX_HOSTED_URL && pathname.startsWith('/webhooks/')) return Response.json({ error: { code: 'not_found', message: "a hosted board's webhooks come through the hub" } }, { status: 404 })
  const revoked = await revokedToken(env, team, request)
  if (revoked) return revoked
  if (pathname === '/.well-known/jwks.json') return Response.json(await directory(env, team).jwks(), { headers: { 'cache-control': 'public, max-age=300' } })
  if (pathname.startsWith('/auth/')) return broker(request, env, team)
  if (pathname.startsWith('/admin/')) {
    // Who's asking, as the default board knows them.
    const board = boardOf(env, team, null)
    return admin(request, env, team, (asked) => board.fetch(new Request(new URL('/me', asked.url), { headers: asked.headers })))
  }
  if (pathname === '/__dev/token' && request.method === 'POST') {
    if (env.BORDEAUX_DEV !== '1') return new Response('not found', { status: 404 })
    return devSignIn(request, env, team)
  }
  // A named board at /b/<name>/, which the team must have made; the default board at the root.
  const named = /^\/b\/([^/]+)(?:\/|$)/.exec(pathname)
  if (named) {
    const name = named[1]!
    if (!BOARD_NAME.test(name) || !(await exists(env, team, name)))
      return Response.json({ error: { code: 'no_board', message: `this team has no board named ${name}: bdx boards create ${name}` } }, { status: 404 })
    const rest = pathname.slice(`/b/${name}`.length)
    if (rest.startsWith(UPLOADS)) return putUpload(request, env, team, name.toLowerCase(), rest.slice(UPLOADS.length))
    if (rest === '/inspect' || rest.startsWith('/inspect/')) {
      const lower = name.toLowerCase()
      // One path per board, as its sign-in cookies are: `/b/Ops/inspect` is `/b/ops/inspect`.
      if (name !== lower) {
        const url = new URL(request.url)
        url.pathname = `/b/${lower}${rest}`
        return Response.redirect(url.toString(), 301)
      }
      const board = boardOf(env, team, name)
      return inspect(request, env, { team, name: lower, url: boardUrl(team, lower), base: `/b/${lower}/inspect`, fetch: (asked) => board.fetch(asked) })
    }
    return boardOf(env, team, name).fetch(request)
  }
  if (pathname.startsWith(UPLOADS)) return putUpload(request, env, team, null, pathname.slice(UPLOADS.length))
  if (pathname === '/inspect' || pathname.startsWith('/inspect/')) {
    const board = boardOf(env, team, null)
    return inspect(request, env, { team, name: null, url: team.url, base: '/inspect', fetch: (asked) => board.fetch(asked) })
  }
  return boardOf(env, team, null).fetch(request)
}

export default {
  async fetch(request: Request, env: BordeauxEnv, ctx: ExecutionContext): Promise<Response> {
    return requestContext.run(ctx, async () => {
      let at: URL | null
      try {
        at = hubOf(env)
      } catch (error) {
        return Response.json({ error: { code: 'misconfigured', message: (error as Error).message } }, { status: 500 })
      }
      if (!at) return route(request, env, envTeam(env))
      // Hosted (spec 09): the hub at its own host, and each team at its own.
      // A host as people write it: `acme.board.dosu.ai.` is `acme.board.dosu.ai`.
      const url = new URL(request.url)
      const host = `${url.hostname.replace(/\.$/, '')}${url.port ? `:${url.port}` : ''}`
      if (host === at.host) return hub(request, env, at)
      const team = await teamAt(env, at, host, request)
      if (team instanceof Response) return team
      if (env.REQUEST_LIMITER && !(await env.REQUEST_LIMITER.limit({ key: team.id })).success)
        return Response.json({ error: { code: 'rate_limited', message: 'this team has made too many requests this minute: wait and try again' } }, { status: 429, headers: { 'retry-after': '60' } })
      return route(request, env, team)
    })
  },

  /**
   * A cron (`triggers.crons` in wrangler.jsonc): retention daily at GC_CRON, else a sync check.
   * Hosted, the daily cron puts each team on the Queue, and there's no sync to check yet.
   */
  async scheduled(controller: ScheduledController, env: BordeauxEnv): Promise<void> {
    if (env.BORDEAUX_HOSTED_URL) {
      if (controller.cron === GC_CRON) await fanOut(env)
      return
    }
    // A deployment with no URL serves no board, and has none to collect: say so, once a run.
    if (!env.BORDEAUX_URL) return console.error("[bordeaux] the cron has no board to run on: set BORDEAUX_URL, the board's public URL")
    if (controller.cron === GC_CRON) await collectAll(env, envTeam(env))
    else await scheduledCheck(env)
  },

  /** Hosted: the `bordeaux-teams` Queue, one team's daily work per message. */
  async queue(batch: MessageBatch<{ team: string }>, env: BordeauxEnv): Promise<void> {
    const at = hubOf(env)
    if (!at) throw new Error('only a hosted deployment takes the bordeaux-teams Queue')
    for (const message of batch.messages) {
      try {
        const done = await tend(env, at, message.body.team)
        console.log(`[bordeaux] team ${message.body.team}: ${done}`)
        message.ack()
      } catch (error) {
        console.error(`[bordeaux] team ${message.body.team} failed:`, (error as Error)?.message ?? error)
        message.retry()
      }
    }
  },
} satisfies ExportedHandler<BordeauxEnv, { team: string }>
