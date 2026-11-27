// Slack, GitHub, and Linear sync from the Worker's own secrets (spec 06, "Credentials without
// Vercel Connect"). Each builds upstream's provider with a Chat SDK adapter of its own, which is
// upstream's documented setup without Connect; routing (`channels`, `repos`, `teams`) is upstream's.
//
//   configure((env) => ({ sync: { slack: slackSync(env, channels({ '#ops': 'ops' })) } }))
//
// A deployment aliases `@vercel/connect/chat` to `@dosu/bordeaux/connect-chat` in wrangler.jsonc:
// upstream's providers import it even when they're given their own adapter.
import { createGitHubAdapter } from '@chat-adapter/github'
import { createLinearAdapter } from '@chat-adapter/linear'
import { createSlackAdapter } from '@chat-adapter/slack'
import { github, repos } from '@vercel/board/sync-github'
import { linear } from '@vercel/board/sync-linear'
import { channels, slack } from '@vercel/board/sync-slack'
import { ConsoleLogger } from 'chat'
import { into, mirror } from '@vercel/board/sync'
import { teams } from '@vercel/board/sync-linear'
import { SYNC_REFRESH_BEFORE_MS, SyncLinkRefused, type SyncAccess, type SyncTokens, type TeamSync } from '../worker/config.ts'
import type { BordeauxEnv } from '../worker/env.ts'
import { toPkcs8 } from '../worker/github-app.ts'

export { channels } from '@vercel/board/sync-slack'
export { repos } from '@vercel/board/sync-github'
export { teams } from '@vercel/board/sync-linear'
export { into, mirror } from '@vercel/board/sync'

/** The secrets each platform reads, by name (`wrangler secret put <name>`). */
export type SyncSecrets = {
  SLACK_BOT_TOKEN?: string
  SLACK_SIGNING_SECRET?: string
  GITHUB_WEBHOOK_SECRET?: string
  LINEAR_API_KEY?: string
  LINEAR_CLIENT_ID?: string
  LINEAR_CLIENT_SECRET?: string
  LINEAR_WEBHOOK_SECRET?: string
}
type Env = BordeauxEnv & SyncSecrets

/**
 * The secrets a platform's sync reads, or null when one isn't set: that sync is left out, with
 * an error in the logs, and the boards work without it.
 */
function need(env: Env, platform: string, ...names: (keyof Env)[]): string[] | null {
  const missing = names.filter((name) => !env[name])
  if (missing.length === 0) return names.map((name) => env[name] as string)
  console.error(`[bordeaux] ${platform} sync is off: it needs ${missing.join(', ')}; set ${missing.length > 1 ? 'them' : 'it'} with wrangler secret put`)
  return null
}

/**
 * The Slack client's limits, as upstream sets them for the adapters it builds (sync-slack's
 * `SLACK_CLIENT`): 3 more tries per call and 30 seconds per request. The client's own default,
 * 10 tries over about 30 minutes with no request timeout, outlives any function, so a Slack
 * call that stalls on a cold start (a rate limit, a hiccup) holds up the webhook past Slack's
 * 3 seconds, and Slack's retries wait on the same stalled call.
 */
export const SLACK_CLIENT = { retryConfig: { retries: 3, factor: 2, minTimeout: 500, randomize: true }, timeout: 30_000 } as const

/** A Slack workspace, as its app: `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. Null when one isn't set. */
export function slackSync(env: Env, sync: Parameters<typeof slack>[1], options: { join?: boolean; debug?: boolean } = {}) {
  const secrets = need(env, 'Slack', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET')
  if (!secrets) return null
  const [botToken, signingSecret] = secrets
  const { debug, ...rest } = options
  // `debug` logs what the Chat SDK adapter does with each webhook: what it ignored, and why.
  const logger = debug ? { logger: new ConsoleLogger('debug') } : {}
  const adapter = createSlackAdapter({ botToken: botToken!, signingSecret: signingSecret!, webClientOptions: { ...SLACK_CLIENT, retryConfig: { ...SLACK_CLIENT.retryConfig } }, ...logger })
  return slack({ adapter, ...rest }, sync)
}

/**
 * GitHub, as the board's own GitHub App (the one people sign in with): `GITHUB_APP_ID`,
 * `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, and `GITHUB_WEBHOOK_SECRET`. `userName` is the
 * App's bot login (`acme-board[bot]`), so its own comments don't come back. Null when a secret isn't set.
 */
export function githubSync(env: Env, sync: Parameters<typeof github>[1], options: { userName: string; botUserId?: number }) {
  const secrets = need(env, 'GitHub', 'GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID', 'GITHUB_WEBHOOK_SECRET')
  if (!secrets) return null
  const [appId, privateKey, installationId, webhookSecret] = secrets
  return githubApp({ appId: appId!, privateKey: privateKey!, installationId: Number(installationId), webhookSecret: webhookSecret!, ...options }, sync)
}

/** Upstream's GitHub provider on Chat SDK's adapter, as one App's installation: it mints the installation's tokens itself. */
function githubApp(app: { appId: string; privateKey: string; installationId: number; webhookSecret: string; userName: string; botUserId?: number }, sync: Parameters<typeof github>[1]) {
  const botUserId = app.botUserId !== undefined ? { botUserId: app.botUserId } : {}
  const adapter = createGitHubAdapter({ appId: app.appId, privateKey: toPkcs8(app.privateKey), installationId: app.installationId, webhookSecret: app.webhookSecret, userName: app.userName, ...botUserId })
  viewerDetects(adapter)
  return github({ adapter, ...botUserId }, sync)
}

/** A repo's name, as GitHub allows it. */
const REPO = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Hosted: GitHub sync for each team, as data (spec 09, "Sync, later"), through the sync App:
 * `GITHUB_SYNC_APP_ID`, `GITHUB_SYNC_PRIVATE_KEY`, and `GITHUB_SYNC_WEBHOOK_SECRET`. A team's
 * rows map its own repos to board channels, and the App's installation on the team's account
 * is the one its tokens are minted for. Null when a secret isn't set.
 *
 *   configure((env) => ({ teamSync: { github: githubTeamSync(env) } }))
 */
export function githubTeamSync(env: Env): TeamSync | null {
  const names = ['GITHUB_SYNC_APP_ID', 'GITHUB_SYNC_PRIVATE_KEY', 'GITHUB_SYNC_WEBHOOK_SECRET'] as const
  // None set is a hosted deployment whose sync App isn't registered yet: off, and quietly, since
  // every isolate would log it. Some set and not others is a mistake, and logged.
  if (names.every((name) => !env[name])) return null
  const secrets = need(env, 'Hosted GitHub', ...names)
  if (!secrets) return null
  const [appId, privateKey, webhookSecret] = secrets
  const slug = env.GITHUB_SYNC_APP_SLUG || 'bordeaux-ai-sync'
  return {
    install: `https://github.com/apps/${slug}/installations/new`,
    refuse(external, login) {
      const [owner, repo, ...rest] = external.split('/')
      if (!owner || !repo || rest.length > 0 || !REPO.test(repo)) return `external: a repo, as owner/repo, got ${external}`
      // Upstream matches a repo as GitHub writes it, case included: the owner is the login, exactly.
      if (!login || owner !== login) return `external: one of ${login ?? 'the team'}'s own repos, as GitHub writes them (${login ?? '<login>'}/<repo>): the sync App can't reach another account's`
      return null
    },
    build(rows, link) {
      if (!link) return null
      // A row maps every PR and issue of its repo: imported `into` its channel, or `mirror`ed back.
      const routing = repos(Object.fromEntries(rows.map((row) => [row.external, row.direction === 'mirror' ? mirror(row.channel) : row.channel])))
      return githubApp({ appId: appId!, privateKey: privateKey!, installationId: Number(link), webhookSecret: webhookSecret!, userName: `${slug}[bot]` }, routing)
    },
  }
}

/**
 * Finds the App's bot user ID from GraphQL's `viewer`, as upstream does for a connector's
 * adapter (upstream sync-github `fromConnector`). Chat SDK asks REST's `GET /user` first, which
 * refuses an installation token with a 403 on every new client, then falls back to two more
 * calls. `viewer` answers with the App's bot user for the same token, in one call.
 */
function viewerDetects(adapter: ReturnType<typeof createGitHubAdapter>) {
  type Detecting = {
    _botUserId: number | null
    logger?: { info(message: string, data?: unknown): void; warn(message: string, data?: unknown): void }
    detectBotUserId(octokit: { graphql?: (query: string) => Promise<unknown> }): Promise<void>
  }
  const detecting = adapter as unknown as Detecting
  detecting.detectBotUserId = async (octokit) => {
    if (detecting._botUserId !== null || !octokit.graphql) return
    try {
      const { viewer } = (await octokit.graphql('query { viewer { databaseId login } }')) as { viewer?: { databaseId?: number; login?: string } }
      if (typeof viewer?.databaseId !== 'number') return
      detecting._botUserId = viewer.databaseId
      detecting.logger?.info('GitHub bot user ID detected from the GraphQL viewer', { botUserId: viewer.databaseId, login: viewer.login })
    } catch (error) {
      detecting.logger?.warn('Could not detect the GitHub bot user ID', { error })
    }
  }
}

/**
 * Linear, as its app: `LINEAR_API_KEY`, or `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` for an
 * OAuth app's client credentials, and `LINEAR_WEBHOOK_SECRET`. Null when one isn't set.
 */
export function linearSync(env: Env, sync: Parameters<typeof linear>[1], options: { userName?: string } = {}) {
  const secrets = env.LINEAR_API_KEY ? need(env, 'Linear', 'LINEAR_WEBHOOK_SECRET', 'LINEAR_API_KEY') : need(env, 'Linear', 'LINEAR_WEBHOOK_SECRET', 'LINEAR_CLIENT_ID', 'LINEAR_CLIENT_SECRET')
  if (!secrets) return null
  const [webhookSecret, first, second] = secrets
  const base = { webhookSecret: webhookSecret!, ...(options.userName ? { userName: options.userName } : {}) }
  const adapter = env.LINEAR_API_KEY ? createLinearAdapter({ ...base, apiKey: first! }) : createLinearAdapter({ ...base, clientCredentials: { clientId: first!, clientSecret: second! } })
  return linear({ adapter }, sync)
}

/**
 * A team's token, as its directory keeps it, held by the board's adapter: asked for again a minute
 * before the directory would refresh it, so the board never holds one a refresh elsewhere replaced,
 * and every 5 minutes at most, so one that never expires (Slack's) gives way to a new link's.
 */
function held(token: () => Promise<SyncAccess>): () => Promise<string> {
  let kept: (SyncAccess & { at: number }) | null = null
  // One ask at a time: calls that find the token stale together share it.
  let asking: Promise<SyncAccess & { at: number }> | null = null
  return async () => {
    const now = Date.now()
    if (kept && now - kept.at <= SYNC_REFRESH_BEFORE_MS && (kept.expires_at === null || kept.expires_at - now >= SYNC_REFRESH_BEFORE_MS + 60_000)) return kept.token
    asking ??= token()
      .then((given) => (kept = { ...given, at: now }))
      .finally(() => (asking = null))
    return (await asking).token
  }
}

/** A Linear team's key, as Linear writes it: `ENG`, the prefix of `ENG-123`. */
const TEAM_KEY = /^[A-Z0-9_]{1,16}$/
/** What the Linear app asks a workspace for: to read it, and to write issues and comments as itself. */
const LINEAR_SCOPES = 'read,write,issues:create,comments:create'
/** How old a Linear webhook may be, by its timestamp: Linear's own advice, and its SDK's check. */
const LINEAR_WEBHOOK_AGE_MS = 60_000

/**
 * A Linear webhook's payload, if `Linear-Signature` is the app's HMAC of its body and it's under a
 * minute old. Its time is `Linear-Timestamp`, or else the body's `webhookTimestamp`; one with
 * neither, as an app's removal may be, is taken on its signature, as Linear's SDK takes it.
 */
async function linearSigned(secret: string, headers: Headers, body: string): Promise<{ type?: string; action?: string; organizationId?: string } | null> {
  const given = /^[0-9a-f]{64}$/i.exec(headers.get('linear-signature') ?? '')?.[0]
  if (!given) return null
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))
  const expected = Uint8Array.from(given.match(/../g)!, (pair) => parseInt(pair, 16))
  if (!crypto.subtle.timingSafeEqual(mac, expected)) return null
  let payload: { type?: string; action?: string; organizationId?: string; webhookTimestamp?: number }
  try {
    payload = JSON.parse(body)
  } catch {
    return null
  }
  const sent = headers.get('linear-timestamp') ?? payload.webhookTimestamp
  if (sent !== undefined && sent !== null) {
    const at = typeof sent === 'number' ? sent : Number.parseInt(String(sent), 10)
    if (Number.isNaN(at) || Math.abs(Date.now() - at) > LINEAR_WEBHOOK_AGE_MS) return null
  }
  return payload
}

/** Linear's token endpoint, for a code or a refresh token: the tokens, or what Linear said was wrong. */
async function linearTokens(form: Record<string, string>, kept: string | null = null): Promise<SyncTokens> {
  const response = await fetch('https://api.linear.app/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form) })
  const answer = (await response.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!response.ok || !answer.access_token) throw new Error(`Linear refused the ${form.grant_type}: ${answer.error_description ?? answer.error ?? response.status}`)
  return { access: answer.access_token, refresh: answer.refresh_token ?? kept, expires_at: typeof answer.expires_in === 'number' ? Date.now() + answer.expires_in * 1000 : null }
}

/**
 * Hosted: Linear sync for each team, as data (spec 09, "Sync, later"), through Dosu's Linear
 * OAuth app: `LINEAR_SYNC_CLIENT_ID`, `LINEAR_SYNC_CLIENT_SECRET`, `LINEAR_SYNC_WEBHOOK_SECRET`,
 * and `BORDEAUX_SYNC_KEY`, which seals each team's tokens. A team's rows map its Linear teams'
 * keys to board channels; an owner links its workspace by OAuth, and the team's directory keeps
 * and refreshes the tokens. Null when a setting isn't set.
 *
 *   configure((env) => ({ teamSync: { github: githubTeamSync(env), linear: linearTeamSync(env) } }))
 */
export function linearTeamSync(env: Env): TeamSync | null {
  const names = ['LINEAR_SYNC_CLIENT_ID', 'LINEAR_SYNC_CLIENT_SECRET', 'LINEAR_SYNC_WEBHOOK_SECRET', 'BORDEAUX_SYNC_KEY'] as const
  // None set is a hosted deployment whose Linear app isn't registered yet: off, and quietly.
  if (names.every((name) => !env[name])) return null
  const secrets = need(env, 'Hosted Linear', ...names)
  if (!secrets) return null
  const [clientId, clientSecret, webhookSecret] = secrets as [string, string, string, string]
  return {
    refuse(external) {
      return TEAM_KEY.test(external) ? null : `external: a Linear team's key, as Linear writes it (ENG, the prefix of ENG-123), got ${external}`
    },
    oauth: {
      authorize(state, redirect) {
        const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: LINEAR_SCOPES, state, actor: 'app' })
        return `https://linear.app/oauth/authorize?${query}`
      },
      async exchange(code, redirect) {
        const tokens = await linearTokens({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: clientSecret })
        const response = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { authorization: `Bearer ${tokens.access}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: 'query BordeauxOrganization { organization { id name } }' }),
        })
        const { data } = (await response.json().catch(() => ({}))) as { data?: { organization?: { id?: string; name?: string } } }
        const external = data?.organization?.id
        if (!response.ok || !external) throw new Error(`Linear didn't say which workspace the token is for (${response.status})`)
        return { external, name: data.organization?.name ?? external, tokens }
      },
      refresh(tokens) {
        if (!tokens.refresh) throw new Error('Linear gave no refresh token: an owner links the workspace again')
        return linearTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: clientId, client_secret: clientSecret }, tokens.refresh)
      },
      async event(request, body) {
        const payload = await linearSigned(webhookSecret, request.headers, body)
        if (!payload) return null
        return { external: payload.organizationId ?? null, removed: payload.type === 'OAuthApp' && payload.action === 'revoked' }
      },
    },
    build(rows, link, token) {
      if (!link) return null
      // Upstream's teams() mirrors a bare channel, so each row says which way it goes.
      const routing = teams(Object.fromEntries(rows.map((row) => [row.external, row.direction === 'mirror' ? mirror(row.channel) : into(row.channel)])))
      const adapter = createLinearAdapter({ accessToken: held(token), webhookVerifier: async (request, body) => (await linearSigned(webhookSecret, request.headers, body)) !== null, mode: 'comments' })
      return linear({ adapter }, routing)
    },
  }
}

/**
 * A Slack channel a row maps: its ID (`C0…`, or `G0…` for an older private one), which survives a
 * rename, or `#name`, which the board looks up in the workspace's channels.
 */
const SLACK_CHANNEL = /^(?:[CG][A-Z0-9]{8,}|#[\p{Ll}\p{Lo}\p{N}_-]{1,80})$/u
/** What the Slack app asks a workspace for: the bot scopes self-hosted sync needs (docs/sync.md), less joining channels. */
const SLACK_SCOPES = 'channels:history,groups:history,channels:read,groups:read,chat:write,chat:write.customize,reactions:read,reactions:write,users:read,users:read.email,files:read,files:write'
/** How old a Slack request may be, by `X-Slack-Request-Timestamp`: Slack's own advice. */
const SLACK_REQUEST_AGE_S = 300

type SlackEnvelope = { type?: string; challenge?: string; team_id?: string; authorizations?: { team_id?: string | null }[]; event?: { type?: string; tokens?: { bot?: string[] } } }

/**
 * A Slack request's payload, if `X-Slack-Signature` is the app's v0 HMAC of
 * `v0:<timestamp>:<body>` and the timestamp is under 5 minutes old.
 */
async function slackSigned(secret: string, headers: Headers, body: string): Promise<SlackEnvelope | null> {
  const given = /^v0=([0-9a-f]{64})$/i.exec(headers.get('x-slack-signature') ?? '')?.[1]
  const timestamp = headers.get('x-slack-request-timestamp') ?? ''
  if (!given || !/^\d{1,12}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > SLACK_REQUEST_AGE_S) return null
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`)))
  const expected = Uint8Array.from(given.match(/../g)!, (pair) => parseInt(pair, 16))
  if (!crypto.subtle.timingSafeEqual(mac, expected)) return null
  try {
    return JSON.parse(body) as SlackEnvelope
  } catch {
    return null
  }
}

/**
 * Hosted: Slack sync for each team, as data (spec 09, "Sync, later"), through Dosu's Slack app:
 * `SLACK_SYNC_CLIENT_ID`, `SLACK_SYNC_CLIENT_SECRET`, `SLACK_SYNC_SIGNING_SECRET`, and
 * `BORDEAUX_SYNC_KEY`, which seals each team's bot token. A team's rows map its Slack channels to
 * board channels; an owner links its workspace by installing the app there, and the team's
 * directory keeps the bot token. Null when a setting isn't set.
 *
 *   configure((env) => ({ teamSync: { github: githubTeamSync(env), linear: linearTeamSync(env), slack: slackTeamSync(env) } }))
 */
export function slackTeamSync(env: Env): TeamSync | null {
  const names = ['SLACK_SYNC_CLIENT_ID', 'SLACK_SYNC_CLIENT_SECRET', 'SLACK_SYNC_SIGNING_SECRET', 'BORDEAUX_SYNC_KEY'] as const
  // None set is a hosted deployment whose Slack app isn't registered yet: off, and quietly.
  if (names.every((name) => !env[name])) return null
  const secrets = need(env, 'Hosted Slack', ...names)
  if (!secrets) return null
  const [clientId, clientSecret, signingSecret] = secrets as [string, string, string, string]
  return {
    refuse(external) {
      return SLACK_CHANNEL.test(external) ? null : `external: a Slack channel, by its ID (C0…, in the channel's details) or as #name, got ${external}`
    },
    oauth: {
      authorize(state, redirect) {
        const query = new URLSearchParams({ client_id: clientId, scope: SLACK_SCOPES, redirect_uri: redirect, state })
        return `https://slack.com/oauth/v2/authorize?${query}`
      },
      async exchange(code, redirect) {
        const response = await fetch('https://slack.com/api/oauth.v2.access', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ code, redirect_uri: redirect, client_id: clientId, client_secret: clientSecret }),
        })
        const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; access_token?: string; refresh_token?: string; expires_in?: number; team?: { id?: string; name?: string } | null }
        if (!answer.ok || !answer.access_token) throw new Error(`Slack refused the code: ${answer.error ?? response.status}`)
        // An Enterprise Grid org-wide install names no one workspace: not yet (spec 09).
        const external = answer.team?.id
        if (!external) throw new SyncLinkRefused('Slack installed the app on a whole Enterprise Grid org, which bordeaux doesn\'t sync yet. Remove it from the org, then install it on one workspace with a new link')
        // A bot token never expires while the app leaves token rotation off. One that expires
        // would stop syncing within 12 hours: refused now, while the admin is here.
        if (answer.expires_in !== undefined || answer.refresh_token) throw new SyncLinkRefused("Slack gave a token that expires, because the app's token rotation is on. Ask the board's operators to turn it off, then link again")
        return { external, name: answer.team?.name ?? external, tokens: { access: answer.access_token, refresh: null, expires_at: null } }
      },
      refresh() {
        throw new Error("a Slack bot token doesn't expire: there's nothing to refresh")
      },
      async event(request, body) {
        const payload = await slackSigned(signingSecret, request.headers, body)
        if (!payload) return null
        // Slack checks the events URL with a challenge, answered here: it names no workspace.
        if (payload.type === 'url_verification') return { external: null, removed: false, answer: { challenge: payload.challenge ?? '' } }
        const external = payload.authorizations?.[0]?.team_id ?? payload.team_id ?? null
        // The app uninstalled, or its bot token revoked: a user token's revocation leaves it.
        const removed = payload.event?.type === 'app_uninstalled' || (payload.event?.type === 'tokens_revoked' && (payload.event.tokens?.bot?.length ?? 0) > 0)
        return { external, removed }
      },
    },
    build(rows, link, token) {
      if (!link) return null
      // Upstream's channels() mirrors a bare channel, so each row says which way it goes.
      const routing = channels(Object.fromEntries(rows.map((row) => [row.external, row.direction === 'mirror' ? mirror(row.channel) : into(row.channel)])))
      const botToken = held(token)
      // Outside the Marketplace, Slack answers a second history read in a minute with a minute's
      // Retry-After. Waiting it out would pause every call the client makes and outlive the
      // webhook's background work, so a rate-limited call fails at once: a reaction's thread
      // lookup falls back to the message itself, and the board's queue retries a post.
      const adapter = createSlackAdapter({ botToken, signingSecret, webClientOptions: { ...SLACK_CLIENT, retryConfig: { ...SLACK_CLIENT.retryConfig }, rejectRateLimitedCalls: true } })
      // An async token needs a client resolver: upstream's own, for a connector's adapter.
      type Client = NonNullable<Exclude<Parameters<typeof slack>[0], string>['client']>
      const client = (async () => adapter.withBotToken(await botToken(), () => adapter.webClient)) as unknown as Client
      return slack({ adapter, client }, routing)
    },
  }
}
