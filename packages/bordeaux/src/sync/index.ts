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
import { github } from '@vercel/board/sync-github'
import { linear } from '@vercel/board/sync-linear'
import { slack } from '@vercel/board/sync-slack'
import { ConsoleLogger } from 'chat'
import type { BordeauxEnv } from '../worker/env.ts'
import { toPkcs8 } from '../worker/github-app.ts'

export { channels } from '@vercel/board/sync-slack'
export { repos } from '@vercel/board/sync-github'
export { teams } from '@vercel/board/sync-linear'

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

function need(env: Env, platform: string, ...names: (keyof Env)[]): string[] {
  const missing = names.filter((name) => !env[name])
  if (missing.length) throw new Error(`${platform} sync needs ${missing.join(', ')}: set ${missing.length > 1 ? 'them' : 'it'} with wrangler secret put`)
  return names.map((name) => env[name] as string)
}

/** A Slack workspace, as its app: `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. */
export function slackSync(env: Env, sync: Parameters<typeof slack>[1], options: { join?: boolean; debug?: boolean } = {}) {
  const [botToken, signingSecret] = need(env, 'Slack', 'SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET')
  const { debug, ...rest } = options
  // `debug` logs what the Chat SDK adapter does with each webhook: what it ignored, and why.
  const logger = debug ? { logger: new ConsoleLogger('debug') } : {}
  return slack({ adapter: createSlackAdapter({ botToken: botToken!, signingSecret: signingSecret!, ...logger }), ...rest }, sync)
}

/**
 * GitHub, as the board's own GitHub App (the one people sign in with): `GITHUB_APP_ID`,
 * `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, and `GITHUB_WEBHOOK_SECRET`. `userName` is the
 * App's bot login (`acme-board[bot]`), so its own comments don't come back.
 */
export function githubSync(env: Env, sync: Parameters<typeof github>[1], options: { userName: string; botUserId?: number }) {
  const [appId, privateKey, installationId, webhookSecret] = need(env, 'GitHub', 'GITHUB_APP_ID', 'GITHUB_PRIVATE_KEY', 'GITHUB_INSTALLATION_ID', 'GITHUB_WEBHOOK_SECRET')
  const adapter = createGitHubAdapter({ appId: appId!, privateKey: toPkcs8(privateKey!), installationId: Number(installationId), webhookSecret: webhookSecret!, userName: options.userName })
  return github({ adapter, ...(options.botUserId !== undefined ? { botUserId: options.botUserId } : {}) }, sync)
}

/**
 * Linear, as its app: `LINEAR_API_KEY`, or `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET` for an
 * OAuth app's client credentials, and `LINEAR_WEBHOOK_SECRET`.
 */
export function linearSync(env: Env, sync: Parameters<typeof linear>[1], options: { userName?: string } = {}) {
  const [webhookSecret] = need(env, 'Linear', 'LINEAR_WEBHOOK_SECRET')
  const base = { webhookSecret: webhookSecret!, ...(options.userName ? { userName: options.userName } : {}) }
  const adapter = env.LINEAR_API_KEY
    ? createLinearAdapter({ ...base, apiKey: env.LINEAR_API_KEY })
    : createLinearAdapter({ ...base, clientCredentials: { clientId: need(env, 'Linear', 'LINEAR_CLIENT_ID')[0]!, clientSecret: need(env, 'Linear', 'LINEAR_CLIENT_SECRET')[0]! } })
  return linear({ adapter }, sync)
}
