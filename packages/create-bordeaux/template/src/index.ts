// The board's Worker and its Durable Objects, as @dosu/bordeaux ships them.
import { configure } from '@dosu/bordeaux/worker'
// import { channels, slackSync } from '@dosu/bordeaux/sync'

// The deployment's own code: middleware, the default board's watchers, and its two-way sync.
// Sync reads its platform's secrets from the Worker's env (wrangler secret put SLACK_BOT_TOKEN, …).
configure((env) => ({
  // sync: { slack: slackSync(env, channels({ '#ops': 'ops' })) },
}))

export { default, BoardDO, DirectoryDO } from '@dosu/bordeaux/worker'
