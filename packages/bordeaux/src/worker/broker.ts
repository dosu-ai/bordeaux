// The token broker (spec 03, "People"): GitHub's device flow signs a person in, the board checks
// they're in its GitHub org, and the board's own issuer hands them its tokens. The GitHub token is
// used once, here, and never kept.
import { directory, personId } from './auth.ts'
import type { Session } from './directory.ts'
import type { BordeauxEnv } from './env.ts'
import { membershipOf } from './github-app.ts'
import { boardNamed } from './boards.ts'
import type { Team } from './team.ts'

/** How long an access token lasts: the most `vb` and agents hold one before asking for another. */
export const ACCESS_TTL = 12 * 3600
/** How long a sign-in lasts without being used: each refresh starts it again. */
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000
/** How often a renewal checks the person is still in the org (spec 03). */
export const RECHECK_MS = 12 * 3600 * 1000

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

type Fetch = typeof fetch

const oauthError = (status: number, error: string, description: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, error_description: description, ...extra }, { status })

const github = (send: Fetch, path: string, token: string) =>
  send(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'bordeaux' } })

/** Who a GitHub token belongs to, and whether they're a member (and an owner) of the team's org. */
export async function member(send: Fetch, team: Team, token: string): Promise<{ id: string; login: string; owner: boolean } | Response> {
  const user = await github(send, '/user', token)
  if (!user.ok) return oauthError(502, 'server_error', `GitHub didn't say who signed in: ${user.status}`)
  const { id, login } = (await user.json()) as { id: number; login: string }
  const org = team.org
  if (!org) return oauthError(500, 'server_error', "this board has no GitHub org to check members against: set BORDEAUX_GITHUB_ORG")
  // Outside collaborators aren't members, as on Vercel (decided, Q2a).
  const found = await github(send, `/user/memberships/orgs/${encodeURIComponent(org)}`, token)
  const membership = found.ok ? ((await found.json()) as { state?: string; role?: string }) : null
  if (membership?.state !== 'active') return oauthError(403, 'access_denied', `${login} isn't a member of ${org} on GitHub`)
  return { id: String(id), login, owner: ownerOf(team, login, membership.role) }
}

/** Org owners are board owners, and so is anyone BORDEAUX_OWNERS names (decided, Q2a). */
const ownerOf = (team: Team, login: string, role: string | undefined) => role === 'admin' || team.owners.includes(login.toLowerCase())

/**
 * A sign-in, renewed: checked against the org again when its last check is over 12 hours old. The
 * person's GitHub token isn't kept, so the board's App asks; a board with no App can't, and asks
 * the person to sign in again instead.
 */
export async function renewed(env: BordeauxEnv, team: Team, session: Session, send: Fetch): Promise<Session | Response> {
  const next = { ...session, expiresAt: Date.now() + REFRESH_TTL_MS }
  if (Date.now() - session.checkedAt < RECHECK_MS) return next
  const org = team.org
  if (!org) return oauthError(500, 'server_error', 'this board has no GitHub org to check members against: set BORDEAUX_GITHUB_ORG')
  const membership = await membershipOf(env, team, org, session.login, send)
  if (membership === 'unknown') return oauthError(401, 'invalid_grant', "this board can't check you're still in its org without its GitHub App: run bdx login")
  if (membership === null) return oauthError(403, 'access_denied', `${session.login} isn't a member of ${org} on GitHub any more`)
  return { ...next, owner: ownerOf(team, session.login, membership.role), checkedAt: Date.now() }
}

/** A sign-in's tokens: a short access token made out to `audience` (the default board's when it's left out), and the refresh token that renews it. */
export async function tokensFor(env: BordeauxEnv, team: Team, session: Session, audience: string | undefined) {
  const dir = directory(env, team)
  const { token, expiresAt } = await dir.mint({ sub: `user:${session.id}`, login: session.login, ...(session.owner ? { owner: true } : {}) }, ACCESS_TTL, team.url, audience)
  const refresh = await dir.startSession(session)
  await dir.setOwner(personId(session.id), session.owner, session.expiresAt)
  return { access: token, expiresAt, refresh }
}

/** The board's tokens for a sign-in, as the token endpoint answers them. */
async function issue(env: BordeauxEnv, team: Team, session: Session, audience: string | undefined): Promise<Response> {
  const { access, expiresAt, refresh } = await tokensFor(env, team, session, audience)
  return Response.json({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    expires_at: new Date(expiresAt).toISOString(),
    refresh_token: refresh,
    principal: personId(session.id),
    login: session.login,
  })
}

export async function broker(request: Request, env: BordeauxEnv, team: Team, send: Fetch = fetch): Promise<Response> {
  const { pathname } = new URL(request.url)
  if (request.method !== 'POST') return oauthError(405, 'invalid_request', 'POST only')
  const clientId = env.GITHUB_CLIENT_ID
  if (pathname === '/auth/device') {
    if (!clientId) return oauthError(501, 'unsupported_grant_type', 'this board has no GitHub App to sign in with: set GITHUB_CLIENT_ID')
    const started = await send('https://github.com/login/device/code', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId }),
    })
    return Response.json(await started.json(), { status: started.status })
  }
  if (pathname !== '/auth/token') return oauthError(404, 'invalid_request', `no route ${pathname}`)

  const body = (await request.json().catch(() => ({}))) as { grant_type?: string; device_code?: string; refresh_token?: string; audience?: string }
  if (body.audience !== undefined && boardNamed(team, body.audience) === undefined) return oauthError(400, 'invalid_target', `audience: ${body.audience} isn't one of this deployment's boards`)
  if (body.grant_type === 'refresh_token') {
    if (!body.refresh_token) return oauthError(400, 'invalid_request', 'refresh_token is required')
    const session = await directory(env, team).takeSession(body.refresh_token)
    if (!session) return oauthError(401, 'invalid_grant', 'that sign-in has ended: run bdx login')
    const next = await renewed(env, team, session, send)
    return next instanceof Response ? next : issue(env, team, next, body.audience)
  }
  if (body.grant_type !== DEVICE_GRANT) return oauthError(400, 'unsupported_grant_type', `grant_type: ${DEVICE_GRANT} or refresh_token`)
  if (!clientId) return oauthError(501, 'unsupported_grant_type', 'this board has no GitHub App to sign in with: set GITHUB_CLIENT_ID')
  if (!body.device_code) return oauthError(400, 'invalid_request', 'device_code is required')

  const polled = await send('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, device_code: body.device_code, grant_type: DEVICE_GRANT }),
  })
  const answer = (await polled.json()) as { access_token?: string; error?: string; error_description?: string; interval?: number }
  // Still waiting on the person, too fast, expired, or refused: the client goes on as GitHub says.
  if (!answer.access_token) return oauthError(400, answer.error ?? 'invalid_grant', answer.error_description ?? 'GitHub gave no token', answer.interval ? { interval: answer.interval } : {})
  const who = await member(send, team, answer.access_token)
  if (who instanceof Response) return who
  return issue(env, team, { ...who, checkedAt: Date.now(), expiresAt: Date.now() + REFRESH_TTL_MS }, body.audience)
}
