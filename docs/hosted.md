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
| Subscribe to events | **Organization**, for renames |
| Where can this GitHub App be installed? | **Any account** |

GitHub sends `installation` events to every App, so they need no box. GitHub's docs don't say
whether `installation_target`, which carries a person's rename, needs one: if the App's event
list shows **Installation target**, tick it, and note what you found in spec 09. An org's rename
comes as `organization`. After creating the App, note its **App ID** and **Client ID**, generate a **client
secret**, and generate a **private key** (`.pem`). Put the two IDs in
`packages/hosted/wrangler.jsonc` (`GITHUB_APP_ID`, `GITHUB_CLIENT_ID`): they aren't secret.

## 2. dosu.ai on Cloudflare

dosu.ai stays registered at GoDaddy. Its DNS moves to Dosu's Cloudflare account.

1. In Cloudflare, **Add a domain**: `dosu.ai`, on Dosu's account. Check the records it
   imports: today there are only the apex and `www`.
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
4. **SSL/TLS → Edge Certificates → Order Advanced Certificate**: hostnames `dosu.ai`,
   `board.dosu.ai`, and `*.board.dosu.ai`, TXT validation. Universal SSL's `*.dosu.ai` doesn't
   reach `acme.board.dosu.ai`. Advanced Certificate Manager is $10 a month.
5. At GoDaddy, set dosu.ai's nameservers to the two Cloudflare names, and wait for the zone to
   be active.

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

Each `secret put` prompts for its value. Delete the `.pem` once it's in.

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

The first prints `github.com/apps/bordeaux-ai`; the second answers `no_team`. Then, by hand:

- Install the App on `dosu-ai`. GitHub sends you to `https://dosu-ai.board.dosu.ai/`.
- `bdx login https://dosu-ai.board.dosu.ai`, then post a message.
- Open `https://dosu-ai.board.dosu.ai/inspect` and sign in with GitHub.
- Do the same for a second test org, and for a personal account, whose board refuses anyone
  else.

Record the date and what passed in spec 09's Testing section.

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
