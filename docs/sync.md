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
6. Map channels by `#name` or by ID (`C0…`, in the channel's details). A name is looked up
   by listing the workspace's channels; an ID needs no lookup, and survives a rename.
   An event from a channel the routing doesn't map is dropped without a log line.
   `slackSync(env, routing, { debug: true })` logs what the Slack adapter does with each
   webhook.

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

A repo mapped to a board channel (`'acme/www': 'prs'`) brings its PRs and issues in and sends
nothing back: GitHub is often public. `mirror('prs')` (from `@dosu/bordeaux/sync`) sends every
board reply back as a comment, posted by the App with the author's name in bold first.

The repo-permission change asks the org to approve it: an owner accepts it on the App's
installation (**Settings → GitHub Apps → Configure → Review request**), and adds the repos
under **Repository access**.

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

If step 1 doesn't happen:
- Slack's Event Subscriptions page says whether it reached the URL.
- If the webhook got through but nothing lands, check the channel mapping: an event from a
  channel the routing doesn't map is dropped silently.
- `wrangler tail` drops events under load: it missed whole webhooks in the live check. Don't
  read its silence as nothing happening.
- `[bordeaux] @inbox:slack failed …` in the tail gives the reason when the board couldn't
  bring an event on.

**Run on 2026-11-25** against a test board on workers.dev and the Dosu workspace: all four
steps passed (Slack root → board, board reply → Slack thread as its author, Slack thread
reply → board thread, board reaction → Slack); a reaction made on Slack reached the board
too. The first two messages, sent within two minutes of installing the app, never landed (the
second only after a redeploy, on Slack's retry), and the cause wasn't caught: by the time it
was instrumented, every message landed in under 2 seconds, routed by `#name` or by ID,
including four that were each the first after a fresh deploy. One gap that would explain it
is now closed: `slackSync` used the Slack client's default of 10 retries over 30 minutes with
no request timeout, so one stalled Slack call could hold a webhook past Slack's 3 seconds. It
now caps the client as upstream does (`SLACK_CLIENT`). Upstream sets no such limits on the
GitHub and Linear clients it builds, so `githubSync` and `linearSync` don't either.

The same Slack reaction arrived twice, 200 ms apart, and landed twice: the inbox dropped a
repeat only while the first was still queued. It now remembers every event it took for 30
days (see spec 06).

**GitHub, the same day,** against `dosu-ai/bordeaux-sync-test` mapped with `mirror`: an issue
and a PR each became a board root (`Issue #1: …`, `PR #2: …`, labeled `issue=`/`pr=`,
`state=open`, and the PR's `head`), a board reply became a comment by the App, a GitHub
comment came back into the board thread, and the App's own comment didn't echo back.

Linear hasn't been run live.
