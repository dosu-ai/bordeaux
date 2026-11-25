// M0 spike: upstream board() (default build) in workerd, on a stub backend.
// Answers discovery, me, and events; every other protocol method is 501.
// Records each bearer token it sees, so the CLI checks can see what was sent.
import { WorkerEntrypoint } from 'cloudflare:workers'
import { board, HttpError, type Backend, type Caller } from '@vercel/board'
import { jwtVerify } from 'jose'
import { AsyncLocalStorage } from 'node:async_hooks'

// Upstream's waitUntil looks up Vercel's request context; give it the Worker's ctx instead.
const requestContext = new AsyncLocalStorage<{ waitUntil(p: Promise<unknown>): void }>()
Reflect.set(globalThis, Symbol.for('@vercel/request-context'), { get: () => requestContext.getStore() })
const background: string[] = []

type Env = { SPIKE_SECRET: string; BOARD_URL?: string }

const METHODS = 'discovery me channels createChannel actors channelMessages threads message post posted edit delete react label schedule schedules cancelSchedule tasks createTask createTasks createdTasks claimReadyTask claimTask renewTask releaseTask completeTask failTask blockTask unblockTask reopenTask assignTask setTaskNeeds cancelTask grants createGrant createGrants updateGrant explain revokeGrant schemas schema createSchema upload attachment uploadStart uploadFinish watchers register matches ack events typing readSource joinSource synced linked syncImport syncReceipt syncThread syncFind syncCopies inboxPush inboxNext inboxAck inbox'.split(' ')

// What the spike saw, per isolate: tokens by request, and the methods board() called.
const seen: { at: string; method: string; jti: string | null; sub: string | null; input?: unknown }[] = []
let lastCaller: unknown = null

function jtiOf(caller: Caller): { jti: string | null; sub: string | null } {
  const c = caller as { identity?: { principal?: { facts?: { claims?: Record<string, unknown> }; id?: string } } }
  const claims = c.identity?.principal?.facts?.claims ?? {}
  return { jti: (claims.jti as string) ?? null, sub: c.identity?.principal?.id ?? null }
}

function stubBackend(url: string): Backend {
  const impl: Record<string, unknown> = {
    routes: [],
    keeps: true,
    trust: { grants: async () => [{ id: 'g1', principals: [{ kind: 'all-users' }], can: { '*': 'all' } }] },
    bind() {},
    async discovery() {
      return { version: '0.56.1', url, audience: url, team_id: null, project_id: null, sync: [] }
    },
    async me(caller: Caller) {
      lastCaller = caller
      const c = caller as { identity: { principal: { id: string; kind: string; handle: string; expiresAt: Date | null } } }
      const p = c.identity.principal
      return {
        actor: p.id,
        principal: p.id,
        kind: p.kind,
        handle: p.handle,
        name: p.handle,
        avatar: null,
        profile: null,
        expiresAt: p.expiresAt ? p.expiresAt.toISOString() : null,
        can: { '*': ['read', 'post', 'react', 'label'] },
      }
    },
    async events(caller: Caller, input: { wait?: number; after?: string }, signal: AbortSignal) {
      seen.push({ at: new Date().toISOString(), method: 'events', ...jtiOf(caller) })
      const wait = Math.min(input.wait ?? 0, 5)
      if (wait > 0) await new Promise((r) => { const t = setTimeout(r, wait * 1000); signal.addEventListener('abort', () => { clearTimeout(t); r(null) }) })
      return { events: [], cursor: input.after ?? '0' }
    },
  }
  for (const m of METHODS) {
    if (m in impl) continue
    impl[m] = async (caller: Caller, input: unknown) => {
      seen.push({ at: new Date().toISOString(), method: m, ...jtiOf(caller), input })
      throw new HttpError(501, 'not_implemented', `spike stub backend has no ${m}`)
    }
  }
  return impl as unknown as Backend
}

// One board per isolate, built on first request (it needs env).
let team: ReturnType<typeof board> | null = null
function boardFor(env: Env, request: Request) {
  const url = env.BOARD_URL ?? new URL(request.url).origin
  team ??= board({
    backend: stubBackend(url),
    url,
    streamMaxMs: 20_000, // short, so the token-refresh check sees reconnects
    authenticate: async (req) => {
      const auth = req.headers.get('authorization')
      if (!auth?.startsWith('Bearer ')) return null
      try {
        const { payload } = await jwtVerify(auth.slice(7), new TextEncoder().encode(env.SPIKE_SECRET), { audience: url })
        seen.push({ at: new Date().toISOString(), method: "auth", jti: (payload.jti as string) ?? null, sub: payload.sub ?? null })
        return { id: `bordeaux:user:${payload.sub}`, kind: 'person', handle: String(payload.login ?? payload.sub), expiresAt: payload.exp ? new Date(payload.exp * 1000) : null }
      } catch (error) {
        throw new HttpError(401, 'bad_token', `spike: ${(error as Error).message}`)
      }
    },
  })
  return team
}

async function spikeRoutes(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url)
  if (pathname === '/__spike/seen') return Response.json({ seen, lastCaller, background })
  if (pathname === '/__spike/wait-until') {
    // Exactly upstream's call (middleware-*.mjs waitUntil), with a task that ends after the response.
    const task = new Promise<void>((r) => setTimeout(() => { background.push(`done ${new Date().toISOString()}`); r() }, 1500))
    Reflect.get(globalThis, Symbol.for('@vercel/request-context'))?.get?.()?.waitUntil?.(task)
    return Response.json({ scheduled: new Date().toISOString(), hasContext: Boolean(requestContext.getStore()) })
  }
  return null
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return requestContext.run(ctx, async () => (await spikeRoutes(request)) ?? boardFor(env, request).fetch(request))
  },
} satisfies ExportedHandler<Env>

// ctx.props check: an app Worker binds here with props it sets in its own wrangler config.
export class BoardEntrypoint extends WorkerEntrypoint<Env, { service?: string; env?: string }> {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/__spike/props') return Response.json({ props: this.ctx.props ?? null })
    return boardFor(this.env, request).fetch(request)
  }
  async whoAmI() {
    return { props: this.ctx.props ?? null }
  }
}
