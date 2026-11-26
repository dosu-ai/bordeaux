// `POST /__dev/token` (BORDEAUX_DEV=1 only): a person token with no sign-in, for local
// development and tests.
import { directory } from './auth.ts'
import { boardNamed } from './boards.ts'
import type { BordeauxEnv } from './env.ts'
import type { Team } from './team.ts'

export async function devSignIn(request: Request, env: BordeauxEnv, team: Team): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { id?: number | string; login?: string; ttl?: number; audience?: string }
  const id = String(body.id ?? 1)
  if (!/^\d+$/.test(id)) return Response.json({ error: { code: 'invalid_request', message: 'id: a GitHub user ID' } }, { status: 400 })
  if (body.audience !== undefined && boardNamed(team, body.audience) === undefined) return Response.json({ error: { code: 'invalid_request', message: 'audience: one of this deployment\'s boards' } }, { status: 400 })
  const login = body.login ?? `dev${id}`
  const dir = directory(env, team)
  const { token, expiresAt } = await dir.mint({ sub: `user:${id}`, login }, Math.min(body.ttl ?? 3600, 12 * 3600), team.url, body.audience)
  const refresh = await dir.startSession({ id, login, owner: false, checkedAt: Date.now(), expiresAt: Date.now() + 24 * 3600 * 1000 })
  return Response.json({ access_token: token, token_type: 'Bearer', expires_at: new Date(expiresAt).toISOString(), refresh_token: refresh, login })
}
