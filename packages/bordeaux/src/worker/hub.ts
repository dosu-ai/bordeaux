// The hub (spec 09, "The hub"): the hosted deployment's own host, which is no team's board.
import type { BordeauxEnv } from './env.ts'
import { registry } from './registry.ts'
import { teamOfRecord } from './team.ts'

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })

export async function hub(request: Request, env: BordeauxEnv, at: URL): Promise<Response> {
  const { pathname } = new URL(request.url)
  // A team with no GitHub App behind it, for local development and tests: `POST /__dev/team {"login": "acme"}`.
  if (pathname === '/__dev/team' && request.method === 'POST' && env.BORDEAUX_DEV === '1') {
    const body = (await request.json().catch(() => ({}))) as { login?: string; id?: number; type?: 'Organization' | 'User' }
    if (!body.login || !/^[a-z0-9](?:-?[a-z0-9])*$/i.test(body.login) || body.login.length > 39) return refuse(400, 'invalid_request', 'login: a GitHub login')
    const id = Number(body.id ?? [...body.login.toLowerCase()].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) % 1_000_000, 7))
    const { team, created } = await registry(env).register({ id, login: body.login, type: body.type ?? 'Organization', installation: id }, at.host)
    return Response.json({ team: team.id, url: teamOfRecord(team, at).url, created }, { status: created ? 201 : 200 })
  }
  return refuse(404, 'not_found', `no route ${request.method} ${pathname}`)
}
