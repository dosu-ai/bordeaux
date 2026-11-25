# Syncing Slack, GitHub, and Linear

A bordeaux board syncs with Slack, GitHub, and Linear the way upstream's does: same
providers, same routing (`channels`, `repos`, `teams`), same behavior both ways. The difference
is credentials. Vercel Connect isn't available, so each platform's app is yours, and its
secrets live in the Worker (spec 06, "Credentials without Vercel Connect").

Sync runs on the default board, inside its Durable Object: a platform's webhook lands in the
board's inbox, the board brings it on, and a reply on the board goes back out. Each step is
retried up to 10 times.

## Wiring

In the board's project, `src/index.ts`:

```ts
import { configure } from '@dosu/bordeaux/worker'
import { channels, repos, slackSync, githubSync } from '@dosu/bordeaux/sync'

configure((env) => ({
  sync: {
    slack: slackSync(env, channels({ '#support': 'support', '#ops': 'ops' })),
    github: githubSync(env, repos({ 'acme/www': 'prs' }), { userName: 'acme-board[bot]' }),
  },
}))

export { default, BoardDO, DirectoryDO } from '@dosu/bordeaux/worker'
```

The key (`slack`, `github`) names the webhook, `<board URL>/webhooks/<key>`. The template's
`wrangler.jsonc` already aliases `@vercel/connect/chat` to `@dosu/bordeaux/connect-chat`:
upstream's providers import it even when they're given their own adapter, and it's never
called.

`discovery` (`GET /`) lists each key with its platform, so `vb`/`bx` and the inspector can
see what's synced.

## Slack

1. Create a Slack app at api.slack.com/apps.
2. **Event Subscriptions**: on, with request URL `https://<board>/webhooks/slack`. Subscribe to
   the bot events `message.channels`, `message.groups`, `reaction_added`, and
   `reaction_removed`.
3. **OAuth & Permissions**, bot token scopes:

   | Scope | For |
   | --- | --- |
   | `channels:history`, `groups:history` | Reading messages, links, and threads |
   | `channels:read`, `groups:read` | Looking up channels by name |
   | `chat:write` | Posting |
   | `chat:write.customize` | Posting under each author's name |
   | `reactions:read`, `reactions:write` | Reactions both ways |
   | `users:read`, `users:read.email` | Names, avatars, and mentions by email |
   | `files:read`, `files:write` | Files both ways |

4. Install it to the workspace, then:

   ```bash
   npx wrangler secret put SLACK_BOT_TOKEN       # xoxb-…, from OAuth & Permissions
   npx wrangler secret put SLACK_SIGNING_SECRET  # from Basic Information
   ```

5. Invite the app to each channel it syncs (`/invite @your-app`). It never joins on its own.

## GitHub

The board's GitHub App (the one people sign in with, [github-app.md](github-app.md)) carries
GitHub sync too. Add to it:

1. Repository permissions: **Issues** and **Pull requests** read and write, **Actions** read.
2. Events: **Pull requests**, **Pull request reviews**, **Pull request review comments**,
   **Issues**, **Issue comments**, and **Workflow runs**.
3. Webhook: active, URL `https://<board>/webhooks/github`, with a secret you make up.
4. Install it on the repos you map (as well as the org).

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_INSTALLATION_ID` are already set for
sign-in. `githubSync` needs `userName`, the App's bot login (`<app-slug>[bot]`), so its own
comments don't come back.

## Linear

1. Create a Linear app (**Settings → API → Applications**) with the `read`, `write`,
   `comments:create`, and `issues:create` scopes, installed as the app (`actor=app`).
2. Webhook: **Issues** and **Comments**, for the teams you map, at
   `https://<board>/webhooks/linear`.
3. Secrets: the app's client credentials, or a personal API key instead.

   ```bash
   npx wrangler secret put LINEAR_CLIENT_ID
   npx wrangler secret put LINEAR_CLIENT_SECRET   # or LINEAR_API_KEY
   npx wrangler secret put LINEAR_WEBHOOK_SECRET
   ```

```ts
linear: linearSync(env, teams({ ENG: 'eng' })),
```

## Checking a live round trip (M3's exit check)

With Slack wired to a deployed board and the app in `#support`:

1. Post in `#support` on Slack. Within a few seconds, `bx` (or `/inspect`) shows it as a new
   thread in board channel `support`, `from: slack`, by the Slack user.
2. Reply to that thread on the board, in `/inspect` or with `bx`. The reply appears in the
   Slack thread under your name (with `chat:write.customize`).
3. Reply in the Slack thread. It lands on the board under the same thread.
4. React on either side. The reaction shows on the other.

If step 1 doesn't happen: Slack's Event Subscriptions page says whether it reached the URL,
and `npx wrangler tail` shows `[bordeaux] @inbox:slack failed …` with the reason when the
board couldn't bring an event on.
