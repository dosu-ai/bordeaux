// Admin routes beside the protocol (spec 07): service tokens for now. Who may use them is decided
// by board() itself: the request's own credential, asked `GET /me`, must manage every channel.
import type { Me } from '@vercel/board'
import { directory } from './auth.ts'
import { BOARD_NAME, boardUrl, forget } from './boards.ts'
import { boardKey } from './backend.ts'
import type { Envelope } from '../engine/do.ts'
import type { BordeauxEnv } from './env.ts'
import { checkSync } from './health.ts'

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
    return env.BOARD.get(env.BOARD.idFromName(boardKey(name)))
  }

  // How a board stands (spec 08, "Health"): its queues, dead letters, failures, and timers, and
  // for the default board whether its sync reaches each platform, which signs each one in.
  if (pathname === '/admin/health' && request.method === 'GET') {
    const stub = await named()
    if (stub instanceof Response) return stub
    const [health, sync] = await Promise.all([stub.health(), name === null ? checkSync(env) : Promise.resolve([])])
    return Response.json({ board: name?.toLowerCase() ?? null, ...health, sync })
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
