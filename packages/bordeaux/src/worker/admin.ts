// Admin routes beside the protocol (spec 07): service tokens for now. Who may use them is decided
// by board() itself: the request's own credential, asked `GET /me`, must manage every channel.
import { retried } from '../engine/reload.ts'
import type { Me } from '@vercel/board'
import { directory } from './auth.ts'
import { BOARD_NAME, boardUrl, forget } from './boards.ts'
import { boardKey } from './backend.ts'
import type { Envelope } from '../engine/do.ts'
import type { BordeauxEnv } from './env.ts'
import { checkSync } from './health.ts'
import { configOf } from './config.ts'
import { REASON_MAX, type Redacted } from '../engine/redact.ts'

/** The longest a service token lasts (spec 03). */
const SERVICE_TTL_MAX = 90 * 24 * 3600
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })

/** The caller, as the default board verified it; else the response to send. */
async function caller(request: Request, me: (request: Request) => Promise<Response>): Promise<Me | Response> {
  const answer = await me(request)
  if (!answer.ok) return answer
  return (await answer.json()) as Me
}

const manages = (found: Me) => (found.can['*'] ?? []).includes('manage')

export async function admin(request: Request, env: BordeauxEnv, me: (request: Request) => Promise<Response>): Promise<Response> {
  const { pathname } = new URL(request.url)
  const who = await caller(request, me)
  if (who instanceof Response) return who
  const dir = directory(env)

  // The team's boards: anyone the default board lets in lists and makes them, as on Vercel (`ensure`);
  // deleting one takes manage at * there. A deleted board's Durable Object keeps what it had.
  if (pathname === '/admin/boards' && request.method === 'GET') return Response.json({ boards: [{ name: null, url: boardUrl(env, null) }, ...(await dir.boards()).map((found) => ({ ...found, url: boardUrl(env, found.name) }))] })
  if (pathname === '/admin/boards' && request.method === 'POST') {
    const { name } = (await request.json().catch(() => ({}))) as { name?: string }
    if (!name || !BOARD_NAME.test(name)) return error(400, 'invalid_request', 'name: 1 to 64 letters, numbers, and ._-')
    const created = await dir.createBoard(name.toLowerCase(), who.principal)
    return Response.json({ board: { name: name.toLowerCase(), url: boardUrl(env, name) }, created }, { status: created ? 201 : 200 })
  }
  const deleting = /^\/admin\/boards\/([^/]+)$/.exec(pathname)
  if (deleting && request.method === 'DELETE') {
    if (!manages(who)) return error(403, 'forbidden', "this token can't delete boards: it needs manage at *")
    const deleted = await dir.deleteBoard(deleting[1]!.toLowerCase())
    forget(deleting[1]!)
    return Response.json({ deleted })
  }

  if (!manages(who)) return error(403, 'forbidden', "this token can't manage tokens: it needs manage at *")

  // `?board=<name>` names the board a route is about: the default board without it.
  const name = new URL(request.url).searchParams.get('board')
  const named = async () => {
    if (name !== null && (!BOARD_NAME.test(name) || !(await dir.hasBoard(name.toLowerCase())))) return error(404, 'no_board', `this team has no board named ${name}`)
    return retried(() => env.BOARD.get(env.BOARD.idFromName(boardKey(name))))
  }

  // How a board stands (spec 08, "Health"): its queues, dead letters, failures, and timers, and
  // for the default board whether its sync reaches each platform, which signs each one in.
  if (pathname === '/admin/health' && request.method === 'GET') {
    const stub = await named()
    if (stub instanceof Response) return stub
    const [health, sync] = await Promise.all([stub.health(), name === null ? checkSync(env) : Promise.resolve([])])
    return Response.json({ board: name?.toLowerCase() ?? null, ...health, worker: env.CF_VERSION_METADATA?.id ?? null, sync })
  }

  // What a board's queues gave up on (spec 07, `bx dead-letters`), and putting one back.
  if (pathname === '/admin/dead-letters' && request.method === 'GET') {
    const stub = await named()
    if (stub instanceof Response) return stub
    return Response.json({ dead: await stub.deadLetters() })
  }
  const retrying = /^\/admin\/dead-letters\/([^/]+)\/retry$/.exec(pathname)
  if (retrying && request.method === 'POST') {
    const stub = await named()
    if (stub instanceof Response) return stub
    const id = decodeURIComponent(retrying[1]!)
    return (await stub.replayDead(id)) ? Response.json({ retried: id }) : error(404, 'not_found', `no dead letter ${id} on this board: bx dead-letters lists them`)
  }

  // What `bx doctor` can't see from outside (spec 07): the bindings this deployment has, and the
  // URL it thinks it's at.
  if (pathname === '/admin/doctor' && request.method === 'GET') {
    const doctor: Doctor = {
      url: env.BORDEAUX_URL,
      version: env.CF_VERSION_METADATA?.id ?? null,
      bindings: { board: true, directory: true, tail: env.TAIL !== undefined, files: env.FILES !== undefined, assets: env.ASSETS !== undefined, versionMetadata: env.CF_VERSION_METADATA !== undefined },
      dev: env.BORDEAUX_DEV === '1',
    }
    return Response.json(doctor)
  }

  // Redaction (spec 02, Δ decided Q9; `bx redact`): scrubs a message that leaked a secret.
  const redacting = /^\/admin\/messages\/([^/]+)\/redact$/.exec(pathname)
  if (redacting && request.method === 'POST') {
    const stub = await named()
    if (stub instanceof Response) return stub
    const { reason, everywhere } = (await request.json().catch(() => ({}))) as { reason?: unknown; everywhere?: unknown }
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > REASON_MAX) return error(400, 'invalid_request', `reason: why it's redacted, 1 to ${REASON_MAX} characters`)
    const answer = (await stub.redact({ actor: who.actor, principal: who.principal, profile: who.profile }, decodeURIComponent(redacting[1]!), reason.trim())) as Envelope
    if (!answer.ok) return error(answer.error.status, answer.error.code, answer.error.message)
    const redacted = answer.value as Redacted
    // The TailDO keeps the newest events and what it read: it forgets them, as the board did.
    if (env.TAIL) await retried(() => env.TAIL!.get(env.TAIL!.idFromName(boardKey(name)))).forget().catch((thrown: unknown) => console.error('[bordeaux] redact: the TailDO did not forget:', (thrown as Error)?.message ?? thrown))
    return Response.json({ board: name?.toLowerCase() ?? null, redacted, ...(everywhere === true ? { everywhere: await deleteOrigin(env, name, redacted) } : {}) })
  }
  if (pathname === '/admin/redactions' && request.method === 'GET') {
    const stub = await named()
    if (stub instanceof Response) return stub
    return Response.json({ redactions: await stub.redactions() })
  }

  // Retention now (spec 02; `bx gc`): the Worker's daily cron runs it on every board.
  if (pathname === '/admin/gc' && request.method === 'POST') {
    const stub = await named()
    if (stub instanceof Response) return stub
    return Response.json({ board: name?.toLowerCase() ?? null, collected: await stub.gc() })
  }

  // A board's whole log, out and in (spec 07).
  if (pathname === '/admin/export' || pathname === '/admin/import') {
    const stub = await named()
    if (stub instanceof Response) return stub
    if (pathname === '/admin/export' && request.method === 'GET') {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder()
          for (let after: { session: string; index: number } | null = null; ; ) {
            const page: { lines: string[]; next: { session: string; index: number } | null } = await stub.exportPage(after)
            for (const line of page.lines) controller.enqueue(encoder.encode(`${line}\n`))
            if (page.next === null) break
            after = page.next
          }
          controller.close()
        },
      })
      return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
    }
    if (pathname === '/admin/import' && request.method === 'POST') {
      const answer = (await stub.importLines((await request.text()).split('\n'))) as Envelope
      return answer.ok ? Response.json(answer.value) : error(answer.error.status, answer.error.code, answer.error.message)
    }
  }
  if (pathname === '/admin/tokens' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { service?: string; env?: string; ttl?: number; board?: string }
    if (body.board !== undefined && (!BOARD_NAME.test(body.board) || !(await dir.hasBoard(body.board.toLowerCase())))) return error(404, 'no_board', `this team has no board named ${body.board}`)
    if (!body.service || !NAME.test(body.service)) return error(400, 'invalid_request', 'service: lowercase letters, numbers, and -')
    const environment = body.env ?? 'production'
    if (!NAME.test(environment)) return error(400, 'invalid_request', 'env: lowercase letters, numbers, and -')
    const ttl = Math.min(body.ttl ?? SERVICE_TTL_MAX, SERVICE_TTL_MAX)
    const sub = `service:${body.service}:${environment}`
    // Made out to one board: the default one unless it names another.
    const minted = await dir.mint({ sub }, ttl, boardUrl(env, body.board ?? null))
    await dir.recordToken({ jti: minted.jti, sub, by: who.principal, expiresAt: minted.expiresAt })
    return Response.json({ token: minted.token, jti: minted.jti, sub, expires_at: new Date(minted.expiresAt).toISOString() }, { status: 201 })
  }
  if (pathname === '/admin/tokens' && request.method === 'GET') return Response.json({ tokens: await dir.tokens() })
  const revoking = /^\/admin\/tokens\/([0-9a-f-]{36})$/.exec(pathname)
  if (revoking && request.method === 'DELETE') return Response.json({ revoked: await dir.revokeToken(revoking[1]!) })
  return error(404, 'not_found', `no route ${request.method} ${pathname}`)
}

/** What `GET /admin/doctor` answers. */
export type Doctor = {
  url: string
  version: string | null
  bindings: { board: boolean; directory: boolean; tail: boolean; files: boolean; assets: boolean; versionMetadata: boolean }
  /** Whether `POST /__dev/token` mints tokens with no sign-in. */
  dev: boolean
}

/** What `--everywhere` did on the platform a redacted message came from. */
export type Everywhere = { deleted: boolean; target: string | null; error?: string }

/**
 * Deletes a redacted message where it came from, through its sync's provider (`--everywhere`).
 * Upstream's sync already deletes the copies the board made on each platform when the message is
 * deleted; it never deletes the original a platform sent, so this does.
 */
async function deleteOrigin(env: BordeauxEnv, name: string | null, redacted: Redacted): Promise<Everywhere> {
  const { origin, importedBy } = redacted
  if (!origin) return { deleted: false, target: null, error: 'it was written on the board, so there is no original elsewhere' }
  const thread = origin.subthread ?? origin.thread
  if (importedBy) return { deleted: false, target: thread, error: `a sync elsewhere (${importedBy}) brought it here: delete it there` }
  const key = thread.slice(0, thread.indexOf(':'))
  const provider = name === null ? (configOf(env).sync?.[key] as { delete?: (thread: string, message: string) => Promise<void> } | null | undefined) : undefined
  if (!provider?.delete) return { deleted: false, target: thread, error: `this board has no ${key} sync that deletes` }
  try {
    await provider.delete(thread.slice(key.length + 1), origin.message)
    return { deleted: true, target: thread }
  } catch (thrown) {
    return { deleted: false, target: thread, error: (((thrown as Error)?.message || String(thrown)) || 'failed').slice(0, 300) }
  }
}
