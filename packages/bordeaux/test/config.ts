import { channels, chatSdk } from '@vercel/board/sync-chat-sdk'
import { channels as slackChannels, slackSync } from '../src/sync/index.ts'
import type { BordeauxConfig } from '../src/worker/config.ts'
import type { BordeauxEnv } from '../src/worker/env.ts'
import { fakePlatform } from './sync-fixtures.ts'

/** A chat platform the board syncs with: what it was sent, and webhooks the tests send as it. */
export const platform = fakePlatform('chat')

/** The deployment config the tests run with: a watcher that answers anything posted in `ops`, `support` synced with the platform's C1, and Slack from secrets. */
export const testConfig = (env: BordeauxEnv): BordeauxConfig => ({
  watch: {
    pager: {
      tail: 'ops',
      run: async ({ event, board }) => {
        if (event.type === 'message.posted' && event.message) await board.reply(event.message.id, { text: `paged on ${event.message.id}` })
      },
    },
  },  sync: {
    // A platform thread's ID ends in its root's message ID, as Slack's do.
    chat: chatSdk({ adapter: platform.adapter, isRoot: (thread, message) => thread.endsWith(`:${message}`) }, channels({ C1: 'support' })),
    // Slack as a deployment wires it: its app's secrets (test values, test/wrangler.jsonc).
    slack: slackSync(env, slackChannels({ '#ops': 'ops-slack' })),
  },
})
