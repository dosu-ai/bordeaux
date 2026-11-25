// M0 spike, Chat SDK check: upstream sync (Slack, GitHub, Linear) with our own adapters, in workerd.
// Same stub backend shape as worker.ts; the point is whether the modules load and verify webhooks.
import { board, HttpError, type Backend } from '@vercel/board'
import { slack, channels } from '@vercel/board/sync-slack'
import { github, repos } from '@vercel/board/sync-github'
import { linear, teams } from '@vercel/board/sync-linear'
import { createSlackAdapter } from '@chat-adapter/slack'
import { createGitHubAdapter } from '@chat-adapter/github'
import { createLinearAdapter } from '@chat-adapter/linear'

type Env = { SLACK_SIGNING_SECRET: string; GITHUB_WEBHOOK_SECRET: string; LINEAR_WEBHOOK_SECRET: string }

const calls: string[] = []
function stub(url: string): Backend {
  const impl: Record<string, unknown> = {
    routes: [], keeps: true, bind() {},
    trust: { grants: async () => [{ id: 'g1', principals: [{ kind: 'all-users' }], can: { '*': 'all' } }] },
    async discovery() { return { version: '0.56.1', url, audience: url, team_id: null, project_id: null, sync: [] } },
  }
  return new Proxy(impl, {
    get(t, k) {
      if (k in t) return t[k as string]
      if (typeof k !== 'string' || ['then', 'sendsSchedulesHere', 'settlesMentions', 'syncedHere', 'sandbox'].includes(k)) return undefined
      return async () => { calls.push(k); throw new HttpError(501, 'not_implemented', `stub: ${k}`) }
    },
  }) as unknown as Backend
}

let team: ReturnType<typeof board> | null = null
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url).origin
    if (new URL(request.url).pathname === '/__spike/calls') return Response.json({ calls })
    team ??= board({
      backend: stub(url),
      url,
      sync: {
        slack: slack({ adapter: createSlackAdapter({ botToken: 'xoxb-spike', signingSecret: env.SLACK_SIGNING_SECRET }) }, channels({ '#errors': 'errors-www' })),
        github: github({ adapter: createGitHubAdapter({ token: 'ghp_spike', webhookSecret: env.GITHUB_WEBHOOK_SECRET, userName: 'bordeaux' }) }, repos({ 'acme/www': 'www' } as never)),
        linear: linear({ adapter: createLinearAdapter({ apiKey: 'lin_spike', webhookSecret: env.LINEAR_WEBHOOK_SECRET, userName: 'bordeaux' }) }, teams({ ENG: 'eng' } as never)),
      },
    })
    return team.fetch(request)
  },
} satisfies ExportedHandler<Env>
