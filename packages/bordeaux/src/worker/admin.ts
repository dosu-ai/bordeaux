// Admin routes beside the protocol (spec 07): service tokens for now. Who may use them is decided
// by board() itself: the request's own credential, asked `GET /me`, must manage every channel.
import type { Me } from '@vercel/board'
import { directory } from './auth.ts'
import type { BordeauxEnv } from './env.ts'

/** The longest a service token lasts (spec 03). */
const SERVICE_TTL_MAX = 90 * 24 * 3600
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

const error = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })

/** The caller, as board() verified it, when it manages every channel; else the response to send. */
async function manager(request: Request, me: (request: Request) => Promise<Response>): Promise<Me | Response> {
  const answer = await me(request)
  if (!answer.ok) return answer
  const found = (await answer.json()) as Me
  if (!(found.can['*'] ?? []).includes('manage')) return error(403, 'forbidden', "this token can't manage tokens: it needs manage at *")
  return found
}

export async function admin(request: Request, env: BordeauxEnv, me: (request: Request) => Promise<Response>): Promise<Response> {
  const { pathname } = new URL(request.url)
  const caller = await manager(request, me)
  if (caller instanceof Response) return caller
  const dir = directory(env)

  if (pathname === '/admin/tokens' && request.method === 'POST') {
    const body = (await request.json().catch(() => ({}))) as { service?: string; env?: string; ttl?: number }
    if (!body.service || !NAME.test(body.service)) return error(400, 'invalid_request', 'service: lowercase letters, numbers, and -')
    const environment = body.env ?? 'production'
    if (!NAME.test(environment)) return error(400, 'invalid_request', 'env: lowercase letters, numbers, and -')
    const ttl = Math.min(body.ttl ?? SERVICE_TTL_MAX, SERVICE_TTL_MAX)
    const sub = `service:${body.service}:${environment}`
    const minted = await dir.mint({ sub }, ttl)
    await dir.recordToken({ jti: minted.jti, sub, by: caller.principal, expiresAt: minted.expiresAt })
    return Response.json({ token: minted.token, jti: minted.jti, sub, expires_at: new Date(minted.expiresAt).toISOString() }, { status: 201 })
  }
  if (pathname === '/admin/tokens' && request.method === 'GET') return Response.json({ tokens: await dir.tokens() })
  const revoking = /^\/admin\/tokens\/([0-9a-f-]{36})$/.exec(pathname)
  if (revoking && request.method === 'DELETE') return Response.json({ revoked: await dir.revokeToken(revoking[1]!) })
  return error(404, 'not_found', `no route ${request.method} ${pathname}`)
}
