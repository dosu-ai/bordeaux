# Running hosted boards

Dosu's hosted Worker (`packages/hosted`) serves every hosted team: the hub at
`https://board.dosu.ai`, and each team's board at `https://<login>.board.dosu.ai`.
[Spec 09](../spec/09-hosted.md) is the design. This page sets it up once, then checks it.

Each step below changes something in production: Dosu's GitHub org, dosu.ai's DNS, or Dosu's
Cloudflare account. Do them in order.

## 1. The GitHub App

In the `dosu-ai` org, open **Settings → Developer settings → GitHub Apps → New GitHub App**.

| Field | Value |
| --- | --- |
| GitHub App name | `bordeaux-ai` |
| Homepage URL | `https://board.dosu.ai` |
| Callback URL | `https://board.dosu.ai/inspect/callback`, every team's inspector sign-in |
| Request user authorization (OAuth) during installation | **unchecked**: checked, GitHub skips the setup URL |
| Setup URL | `https://board.dosu.ai/setup`, with **Redirect on update** checked |
| **Enable Device Flow** | **checked**, for `bdx login` |
| Webhook → Active | checked |
| Webhook URL | `https://board.dosu.ai/__bordeaux/github/events` |
| Webhook secret | a long random string, kept for step 3 |
| Organization permissions → **Members** | **Read-only** |
| Subscribe to events | **Installation target** and **Organization**, for renames |
| Where can this GitHub App be installed? | **Any account** |

GitHub sends `installation` events to every App, so they need no box. A person's rename comes
as `installation_target`, an org's as `organization`. After creating the App, note its **App
ID** and **Client ID**, generate a **client secret**, and generate a **private key** (`.pem`).
Put the two IDs in `packages/hosted/wrangler.jsonc` (`GITHUB_APP_ID`, `GITHUB_CLIENT_ID`): they
aren't secret.

## 2. dosu.ai on Cloudflare

dosu.ai stays registered at GoDaddy. Its DNS moves to Dosu's Cloudflare account.

1. In Cloudflare, **Add a domain**: `dosu.ai`, on Dosu's account. Check the records it
   imports: the apex, `www`, and two GoDaddy adds to every domain it hosts, `_domainconnect`
   and `pay`. Keep those two as **DNS only**: proxied, `pay.dosu.ai` stops working. Delete
   the apex's A records, which point at GoDaddy's forwarding.
2. Make the records, all proxied:

   | Type | Name | Content |
   | --- | --- | --- |
   | AAAA | `dosu.ai` | `100::` |
   | CNAME | `www` | `dosu.ai` |
   | AAAA | `board` | `100::` |
   | AAAA | `*.board` | `100::` |

   `100::` is an address with nothing behind it: a redirect rule or the Worker answers.
3. **Rules → Redirect Rules**: hostname is `dosu.ai` or `www.dosu.ai` → 301 to
   `https://dosu.dev/`, as GoDaddy forwards them today.
4. At GoDaddy, set dosu.ai's nameservers to the two Cloudflare names, and wait for the zone to
   be active. Until it is, Cloudflare answers with `100::` and nothing redirects: do this step
   when a short gap doesn't matter.
5. Once the zone is active, **SSL/TLS → Edge Certificates → Activate Advanced Certificate
   Manager** ($10 a month), then **Order an advanced certificate**: Google Trust Services, the
   form's `dosu.ai` and `*.dosu.ai`, plus `*.board.dosu.ai`, TXT validation, 3 months.
   Universal SSL's `*.dosu.ai` doesn't reach `acme.board.dosu.ai`.

Then check:

```bash
dig +short NS dosu.ai
```

```bash
curl -sI https://dosu.ai | grep -i '^location'
```

The nameservers are Cloudflare's, and `location` is `https://dosu.dev/`.

## 3. Resources and secrets

From `packages/hosted`, signed in to Dosu's Cloudflare account (`npx wrangler login`):

```bash
npx wrangler r2 bucket create bordeaux-hosted-files
```

```bash
npx wrangler queues create bordeaux-teams
```

```bash
npx wrangler queues create bordeaux-teams-dead
```

The rate limiters' namespace IDs (9001 to 9003 in `wrangler.jsonc`) must be no other Worker's
in the account, or they share counters: check the account's Workers for `ratelimits` first, and
pick others if any is taken.

```bash
npx wrangler secret put GITHUB_PRIVATE_KEY < bordeaux-ai.private-key.pem
```

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
```

```bash
npx wrangler secret put GITHUB_WEBHOOK_SECRET
```

Each `secret put` prompts for its value. Before the first deploy, the first one asks to create
the `bordeaux-hosted` Worker: say yes, and the deploy replaces its empty placeholder. Delete the
`.pem` once it's in.

## 4. Deploy

```bash
pnpm --filter @dosu/bordeaux-hosted run deploy
```

The Worker answers only at `board.dosu.ai` and `*.board.dosu.ai`, through its two routes. Its
`workers.dev` URL is off. A deployment that sets a self-hosted var (`BORDEAUX_URL`,
`BORDEAUX_GITHUB_ORG`, `GITHUB_INSTALLATION_ID`, `BORDEAUX_OWNERS`) answers every request 500
`misconfigured`.

## 5. Check it

```bash
curl -s https://board.dosu.ai/ | grep -o 'github.com/apps/[a-z-]*'
```

```bash
curl -s https://nobody.board.dosu.ai/
```

```bash
curl -s https://board.dosu.ai/terms | grep -o '<title>[^<]*'
```

```bash
curl -s https://board.dosu.ai/llms.txt | head -1
```

The first prints `github.com/apps/bordeaux-ai`; the second answers `no_team`; the third prints
the terms' title; the fourth, `# bordeaux at board.dosu.ai`. Then, by hand:

- Install the App on `dosu-ai`. GitHub sends you to `https://dosu-ai.board.dosu.ai/`.
- `bdx login https://dosu-ai.board.dosu.ai`, then post a message.
- Open `https://dosu-ai.board.dosu.ai/inspect` and sign in with GitHub.
- Do the same for a second test org, and for a personal account, whose board refuses anyone
  else.

Record the date and what passed in spec 09's Testing section.

## 6. Logs and alerts

`observability` in `wrangler.jsonc` turns on Workers Logs: every request, and every
`console.error`, kept 7 days. The Worker reports each failure it handles that way (a team's
daily job, a board's timer, a sign-up GitHub didn't answer), so Workers Issues sees it.

1. **Workers & Pages → bordeaux-hosted → Issues**: turn issue detection on.
2. **Observability → Monitors → Create Monitor → Threshold**: dataset **Workers Real-Time
   Issues**, filter `scriptName = bordeaux-hosted`, trigger when the count is `>= 1` over `1m`,
   repeat after `1h`. Name it `bordeaux-hosted: new errors` and add Dosu's alert email.
   (Issues' own automations post to webhooks, chat, and incident tools, not email.)

A team whose daily job fails five times lands in `bordeaux-teams-dead`; each failure is an
issue first.

## 7. GitHub sync: the sync App

A team syncs its repos with its board through a second public App, `bordeaux-ai-sync`, which
asks for write access to issues and pull requests. `bordeaux-ai` keeps asking only to read
members, so signing up stays a small ask, and a team grants repo access only when it turns sync
on (spec 09, "Sync, later").

In the `dosu-ai` org, open **Settings → Developer settings → GitHub Apps → New GitHub App**.

| Field | Value |
| --- | --- |
| GitHub App name | `bordeaux-ai-sync` (if GitHub has the name already, pick another: it's the slug below) |
| Homepage URL | `https://board.dosu.ai` |
| Description | links to `/terms` and `/privacy`, as `bordeaux-ai`'s does |
| Callback URL | empty: nobody signs in with this App |
| Request user authorization (OAuth) during installation | **unchecked** |
| Setup URL | `https://board.dosu.ai/sync/setup`, with **Redirect on update** checked |
| Enable Device Flow | unchecked |
| Webhook → Active | checked |
| Webhook URL | `https://board.dosu.ai/__bordeaux/github/events`, the same as `bordeaux-ai`'s |
| Webhook secret | a new long random string, not `bordeaux-ai`'s |
| Repository permissions → **Issues** | **Read and write** |
| Repository permissions → **Pull requests** | **Read and write** |
| Repository permissions → **Actions** | **Read-only**, for CI results on PRs |
| Repository permissions → **Metadata** | Read-only (GitHub sets it) |
| Subscribe to events | **Issues**, **Issue comment**, **Pull request**, **Pull request review**, **Pull request review comment**, **Workflow run** |
| Where can this GitHub App be installed? | **Any account** |

Both Apps send to one URL. The hub tells their events apart by the App ID GitHub sends with
each, and checks each against its own App's secret. After creating it, note its **App ID** and
generate a **private key** (`.pem`). It needs no client secret.

In `packages/hosted/wrangler.jsonc`'s `vars`, add the two names, which aren't secret:

```jsonc
"GITHUB_SYNC_APP_SLUG": "bordeaux-ai-sync",
"GITHUB_SYNC_APP_ID": "<its App ID>",
```

From `packages/hosted`, put its secrets:

```bash
npx wrangler secret put GITHUB_SYNC_PRIVATE_KEY < bordeaux-ai-sync.private-key.pem
```

```bash
npx wrangler secret put GITHUB_SYNC_WEBHOOK_SECRET
```

Delete the `.pem` once it's in, and deploy (step 4). Until all three are set, hosted sync is
off: `bdx sync add` answers that the board syncs nothing yet. With none set, the Worker says
nothing, so deploying before this step raises no alert; with some set, it logs which are
missing.

Then check, on `dosu-ai`'s board, with a test repo (`dosu-ai/bordeaux-sync-test`):

1. Install the sync App on `dosu-ai`, with **Only select repositories** and the test repo.
   GitHub sends you to `https://dosu-ai.board.dosu.ai/`.
2. As an owner of `dosu-ai`:

   ```bash
   bdx sync add github dosu-ai/bordeaux-sync-test prs --mirror
   ```

   ```bash
   bdx sync list
   ```

3. Open an issue in the test repo. Within a few seconds it's a thread in channel `prs`
   (`Issue #1: …`).
4. Reply to that thread on the board. The reply appears on the issue, posted by
   `bordeaux-ai-sync[bot]` with your name first.
5. Comment on the issue. The comment comes back into the board thread.

Record the date and what passed in spec 09's Testing section.

## 8. Linear sync: the Linear app

A team syncs its Linear workspace with its board through Dosu's Linear OAuth app. Nothing ties a
Linear workspace to a GitHub account, so an owner asks for a link and a workspace admin approves
it in Linear. The team's directory keeps the workspace's tokens, sealed, and refreshes them
(spec 09, "Sync, later").

In Dosu's Linear workspace, open **Settings → API → OAuth applications → New**.

| Field | Value |
| --- | --- |
| Application name | `bordeaux-ai`: admins see it when they approve a link |
| Developer name | Dosu |
| Developer URL | `https://board.dosu.ai` |
| Description | links to `https://board.dosu.ai/terms` and `/privacy` |
| Callback URLs | `https://board.dosu.ai/sync/linear/callback` |
| Public | **on**, so other workspaces can approve it |
| Client credentials | off: each workspace links by OAuth |
| Webhooks | **on** |
| Webhook URL | `https://board.dosu.ai/__bordeaux/linear/events` |
| Webhook events | **Issues** and **Comments** |

Linear sends every linked workspace's events to that one URL, and the app's removal from a
workspace too. After creating it, note its **client ID**, **client secret**, and the webhook's
**signing secret**.

In `packages/hosted/wrangler.jsonc`'s `vars`, add the client ID, which isn't secret:

```jsonc
"LINEAR_SYNC_CLIENT_ID": "<its client ID>",
```

From `packages/hosted`, put its secrets, and the key that seals each team's tokens:

```bash
npx wrangler secret put LINEAR_SYNC_CLIENT_SECRET
```

```bash
npx wrangler secret put LINEAR_SYNC_WEBHOOK_SECRET
```

```bash
openssl rand -base64 32 | npx wrangler secret put BORDEAUX_SYNC_KEY
```

Nobody needs to see `BORDEAUX_SYNC_KEY`, so it goes straight from `openssl` to the Worker. A new
key leaves every team's sealed tokens unreadable, and each team links again. Deploy (step 4).
As with GitHub, none of the four set is off quietly, and some set logs which are missing.

Then check, on `dosu-ai`'s board, with a test team in Linear (`BXT`):

1. As an owner of `dosu-ai`:

   ```bash
   bdx sync add linear BXT linear-test --mirror
   ```

   It prints a link to Linear, good for 10 minutes, once. `bdx sync link linear` makes another.
2. A Linear workspace admin opens it and approves. The hub says the workspace syncs with
   `https://dosu-ai.board.dosu.ai` now, and `bdx sync list` shows it linked.
3. Open an issue in `BXT`. Within a few seconds it's a thread in channel `linear-test`
   (`BXT-1: …`).
4. Reply to that thread on the board. The reply appears on the issue as a comment by the app,
   with your name first.
5. Comment on the issue. The comment comes back into the board thread.
6. A day later, reply on the board again. Linear's tokens last 24 hours, so the reply shows the
   directory refreshed them.

Record the date and what passed in spec 09's Testing section.

## Terms and privacy

The hub serves Dosu's terms at `/terms` and privacy policy at `/privacy`, from
`packages/hosted/src/legal.ts`, and its front page says installing agrees to both
(`BORDEAUX_TERMS_URL`, `BORDEAUX_PRIVACY_URL`). They add to Dosu's own at `dosu.dev/legal`.
legal@dosu.dev reviews any change to them before it deploys. Link both from the App's
description too (**Settings → Developer settings → GitHub Apps → bordeaux-ai**), since people
also install it from its page on GitHub.

## Operating

Dosu's operators are the owners of `dosu-ai` (`BORDEAUX_OPERATOR_ORG`). Sign in to the hub
itself, then use its routes with the token `bdx token` prints:

```bash
bdx login https://board.dosu.ai
```

```bash
curl -s -H "authorization: Bearer $(bdx token --url https://board.dosu.ai)" https://board.dosu.ai/__bordeaux/teams
```

| Route | What |
| --- | --- |
| `GET /__bordeaux/teams` | every team: its URL, GitHub account, state, limits, and usage |
| `GET /__bordeaux/teams/<id>` | one team |
| `POST /__bordeaux/teams/<id>/suspend` | its boards answer 403 `team_suspended` |
| `POST /__bordeaux/teams/<id>/restore` | back to active |
| `PATCH /__bordeaux/teams/<id>/limits` | `{"boards": 40}`: its own limits, over the Worker's |
| `DELETE /__bordeaux/teams/<id>` | deletes it now: boards, files, and record |

They show usage, never what's on a board. The daily cron (04:00 UTC) puts each team on the
`bordeaux-teams` Queue: retention, its usage, and deleting a team 30 days after its App was
uninstalled. A team whose job fails five times lands in `bordeaux-teams-dead`, and the next
day's cron tries it again.

## Locally

`wrangler dev` sends every request to the first route's host, so hosted mode runs on a laptop
from `packages/bordeaux` instead, with its own config:

```bash
npx wrangler dev -c wrangler.hosted.jsonc
```

```bash
curl -s -X POST http://board.localhost:8787/__dev/team -d '{"login": "acme"}'
```

The team is at `http://acme.board.localhost:8787`, and `POST /__dev/token` there signs in a
made-up person, as on a self-hosted dev board.
