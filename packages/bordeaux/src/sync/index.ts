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
import { slack } from '@vercel/board/sync-slack'
import { ConsoleLogger } from 'chat'
import { mirror } from '@vercel/board/sync'
import type { TeamSync } from '../worker/config.ts'
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
