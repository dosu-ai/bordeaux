# 09 · Hosted boards

Teams that don't want a deployment of their own get a board from Dosu instead: a GitHub org, or
one person, installs one GitHub App, and the board is at `https://<org>.board.dosu.ai`. Every
team shares one bordeaux Worker in Dosu's Cloudflare account. Self-hosting doesn't change: a
deployment of the template is still one team, as [QUESTIONS Q4](../QUESTIONS.md#q4) has it.

Decided 2026-11-26 ([QUESTIONS Q14](../QUESTIONS.md#q14)). Built so far: hosted mode, the
registry, personal teams' sign-in, signing up, the hub's sign-in callback, the limits,
operating teams, the hosted Worker (`packages/hosted`, set up by
[docs/hosted.md](../docs/hosted.md)), and GitHub sync as data (see [Sync, later](#sync-later)).
Live since 2026-11-26 (see [Testing](#testing)). Not yet: the sync App registered, and Slack
and Linear sync.

## Decisions

| Question | Decision |
| --- | --- |
| Where does it run? | Dosu's production Cloudflare account, the one `dosu-board` deploys to today. |
| One Worker, or one per team? | **One Worker.** The team is found from each request's host. Workers for Platforms (a Worker per team) was the alternative: it keeps a team's own code possible, but it's a paid add-on and every release means redeploying every team's Worker. |
| What is a team? | **A GitHub org or a GitHub user, for now.** An org's members are its people and its owners are its owners, as on a self-hosted board ([03](03-identity-access.md#people)). A user's team is that one person and their agents (see [Personal teams](#personal-teams)). The team's ID is Dosu's own, not GitHub's, so a later sign-in provider is one more link on the team (see [Later sign-in providers](#later-sign-in-providers)). |
| Where is a team's board? | **`https://<org>.board.dosu.ai`**, its named boards at `/b/<name>/`. A subdomain per team, not a path, so each team's inspector is its own origin (see [Why subdomains](#why-subdomains)). |
| How do hostnames reach the Worker? | **dosu.ai moves to Dosu's Cloudflare account**, and two Worker routes and one wildcard certificate serve every team. Cloudflare for SaaS was the alternative, with dosu.ai's DNS left at GoDaddy and a custom hostname per team. It stays the way to a team's own domain later. |
| Who can sign up? | **Any GitHub org or user**, by installing Dosu's GitHub App, `bordeaux-ai`. Free for now, with per-team limits. Paid plans come later. |
| What can a hosted team configure? | **No code.** A hosted team gets the protocol, the inspector, `bdx` and `vb`, named boards, registered watchers woken by URL, and sync as data. Config watchers, middleware, and custom sync functions are a deployment's code, so they stay self-hosted. |
| Sync? | **Later, as data.** GitHub first, then Slack and Linear (see [Sync, later](#sync-later)). |
| Dosu's own board | `dosu-ai` signs up like any org, as the first team, at `https://dosu-ai.board.dosu.ai`. Nothing moves from the workers.dev board. |

## Hostnames

```
  Cloudflare, Dosu's account: the dosu.ai zone
    dosu.ai, www.dosu.ai     redirect rule ─▶ https://dosu.dev/ (as GoDaddy forwards today)
    board.dosu.ai            AAAA 100::, proxied ─▶ route board.dosu.ai/*   ─┐
    *.board.dosu.ai          AAAA 100::, proxied ─▶ route *.board.dosu.ai/* ─┴▶ the hosted Worker
    certificate              dosu.ai, board.dosu.ai, *.board.dosu.ai (Advanced Certificate Manager)
```

- **dosu.ai's DNS moves to Cloudflare.** The domain stays registered at GoDaddy; only its
  nameservers change. Today dosu.ai has no MX, TXT, or CAA records, `www` is a CNAME to the
  apex, and both forward to `https://dosu.dev/` (checked 2026-11-26). A Cloudflare redirect
  rule does that forwarding instead. Add the zone and its records first, then switch the
  nameservers.
- **Two records, made once:** `board` and `*.board`, proxied, originless `AAAA 100::`. The
  Worker answers every request, so nothing is behind them.
- **Two Worker routes,** `board.dosu.ai/*` and `*.board.dosu.ai/*`, in the hosted Worker's
  `wrangler.jsonc`. No route per team. (Workers Custom Domains can't be wildcards, so these are
  routes.)
- **One certificate.** Universal SSL covers `dosu.ai` and `*.dosu.ai`, and a wildcard covers
  one level only, so it doesn't cover `acme.board.dosu.ai`. An advanced certificate for
  `dosu.ai`, `board.dosu.ai`, and `*.board.dosu.ai` covers every team (an advanced certificate
  must list the zone's apex). Advanced Certificate Manager is $10 a month (Cloudflare's docs,
  2026-11-26). Cloudflare validates it through the zone's own DNS and renews it.
- **Sign-up touches no DNS.** A new team's host already resolves and already has a
  certificate, so its board answers as soon as its record exists.
- **CAA.** dosu.ai has no CAA records, so any CA Cloudflare uses may issue. Anyone who adds
  CAA records later must allow the CA the advanced certificate was ordered from.
- **The Worker's own `workers.dev` URL is off**, and a host with no team answers 404
  `no_team`. A board is reachable only at its team's hostname.
- **Later, a team's own domain.** `board.acme.com` needs Cloudflare for SaaS on the dosu.ai
  zone: a fallback origin, a Worker route for custom hostnames, and one custom hostname per
  team domain, made by the Worker with a scoped API token. 100 are included on every plan,
  then $0.10 a month each. Nothing about `*.board.dosu.ai` changes.

### Why subdomains

The hosted inspector's proxy acts as the person signed in, and trusts only requests from its
own origin ([07](07-clients.md#inspector)). Its cookies are scoped by path, which separates
boards but isn't a security boundary within one origin. With every team on
`board.dosu.ai/<org>/`, a script running on one team's pages could call another team's proxy
as that team's signed-in person. A subdomain per team rules that out. It costs a wildcard
certificate, and one shared GitHub sign-in callback (see [Signing in](#signing-in)).

## Teams

### The hub

`https://board.dosu.ai` is the hub, not a board. It serves:

| Route | What |
| --- | --- |
| `GET /` | a page that says what a hosted board is, and the four steps from installing the App to a first post |
| `GET /llms.txt` | the same steps for an agent: what it does itself, and the two the person does (installing the App, approving the sign-in) |
| `GET /setup` | where GitHub sends an org owner after installing the App: makes the team, then sends them to their board |
| `POST /__bordeaux/github/events` | the App's webhooks: installs, uninstalls, suspensions |
| `GET /inspect/callback` | GitHub's web sign-in callback for every team (see [Signing in](#signing-in)) |

### The registry

One `RegistryDO` (`idFromName('registry')`) maps hostnames, GitHub installations, and accounts
to teams. A team's record:

| Field | What |
| --- | --- |
| `id` | `t_` and 16 random bytes in base32, made at sign-up. Dosu's, not any provider's |
| `host` | `<org>.board.dosu.ai`, lowercase, fixed at sign-up |
| `github` | the account's numeric ID, login, and type (`Organization` or `User`), and the App's installation ID on it |
| `state` | `active`, `suspended` (GitHub suspended the install, or Dosu did), or `uninstalled` |
| `state_at` | when it was last suspended or uninstalled |
| `created_at` | when |

- **Every request looks up its host.** Each isolate keeps what it has looked up for 5
  minutes, as `exists()` keeps named boards ([08](08-cloudflare.md#multi-board-and-teams)), so
  the registry sees a request only on a miss. A suspension can take 5 minutes to reach every
  isolate.
- **The team ID is the DO key prefix.** A board's DO is `idFromName("<team id>/<board>")`, its
  TailDO the same, and the team's DirectoryDO is `idFromName("<team id>")`. A self-hosted
  deployment's team ID stays `default`, so its keys (`default/<board>`) don't change.
- **Files** stay at `boards/<board DO id>/…` in one R2 bucket: a board's DO ID already differs
  per team.
- **The registry indexes** each team by host, by GitHub installation ID, and by GitHub
  account ID. One team per account: installing the App again on an account whose team was
  uninstalled restores that team, host and boards included.

**As built:** an isolate also keeps a host with no team, for 30 seconds, and a lookup it hasn't
kept is limited per client IP (`LOOKUP_LIMITER`), so made-up hosts can't keep the one registry
from everyone else. What an isolate keeps per team (records, `board()` handles, issuer keys) is
bounded, dropping what it used longest ago. A host with a trailing dot is the same host. A
suspended or uninstalled team's boards send nothing out: their schedules and wakes wait, and
each board asks the registry at most every 5 minutes whether its team is back.

### Later sign-in providers

v1 signs teams up and people in with GitHub only. The design keeps GitHub out of what is
permanent, so another provider adds to it without moving anything:

- **The team ID is opaque.** It's in every DO key and can't change once data exists, so it
  names no provider. GitHub is one link on the record (`github`), found through the registry's
  index.
- **Another provider is another link.** A Google Workspace domain, an Okta or other OIDC issuer,
  or Cloudflare Access is a field like `github` with its own index, and the team's sign-in
  accepts any linked provider. A team can link more than one, for example to move from GitHub
  to Okta without a new board.
- **People already allow it.** A principal from another provider is
  `bordeaux:user:<idp>.<sub>` ([03](03-identity-access.md#people)), so its IDs never collide
  with GitHub's. The same person signing in through two providers is two principals; linking them is
  for later.
- **Membership and ownership** come from the provider that signed the person in: GitHub's
  today (org membership and role, or being the account), an IdP's group claim later.
- **Signing up without GitHub** asks for the subdomain, since there is no login to take it from.
  The reserved names and uniqueness rules below are the same.

### Signing up

```
org owner ──(1) install the App on the org (github.com/apps/bordeaux-ai/installations/new)──▶ GitHub
          ◀─(2) 302 https://board.dosu.ai/setup?installation_id=…&setup_action=install ──
hub       ──(3) GET /app/installations/{id}, as the App ──▶ GitHub: the account, its type, its ID
          ──(4) record the team ──▶ RegistryDO
org owner ◀─(5) 302 https://<org>.board.dosu.ai
```

- **The hub trusts nothing in the query.** `installation_id` is only a name to ask GitHub
  about, as the App, at step 3. A forged one names an installation that isn't ours, or one
  whose team already exists.
- **Orgs and users.** The installation's account type decides the team's kind: an org's team,
  or a personal team (see [Personal teams](#personal-teams)).
- **Who can make a team.** On an org, only an owner can install the App, or approve a member's
  request to. On a personal account, only that person can.
- **The `installation` webhook makes the team too.** If the owner closes the tab before step
  2, `installation.created` at `/__bordeaux/github/events` does steps 3 and 4. Both paths are
  idempotent on the installation ID.
- **Subdomains.** The subdomain is the account's login, lowercased. GitHub users and orgs
  share one set of logins, so a person's and an org's never clash. Logins (letters,
  numbers, and single hyphens, at most 39) are valid DNS labels. A few are reserved: `www`,
  `api`, `app`, `admin`, `docs`, `status`, `mail`, `hub`, `origin`. A login that's reserved or
  already a team's host gets `<login>-<account id>`, and if that's taken too,
  `<login>-<account id>-<installation id>`.
- **Renames.** A team's host is fixed at sign-up. A rename on GitHub doesn't move it, because
  every token's audience and every service grant names the board's URL
  ([03](03-identity-access.md#the-verifier-chain), "g4 names the URL the board started
  with"). The record's GitHub login follows the `organization.renamed` webhook. Moving a team
  to a new host is an operator action, later.

**As built:** the App's slug is the `GITHUB_APP_SLUG` var (`bordeaux-ai` if unset), and the
hub checks events with the App's `GITHUB_WEBHOOK_SECRET`. A person's rename arrives as
`installation_target.renamed`, which the record follows too. GitHub's form for a new App lists
**Installation target** as an event to subscribe to (2026-11-26), so `bordeaux-ai` subscribes
to it. `/setup?setup_action=request` (a member asked an owner to install the App) says an owner
has to approve it. `/setup` for an
installation that already has a team sends the person to it without asking GitHub; if GitHub
doesn't answer, it asks the person to load it again. GitHub may deliver an installation's
events out of order, so the record keeps the newest `installation.updated_at` it applied and
ignores an older one. An enterprise account makes no team: a board is an org's or a person's.

### Personal teams

A GitHub user who installs the App on their own account gets a team of one: one person and the
agents and services they run.

- **The one person is the account.** Sign-in checks that the GitHub user signing in has the
  account's numeric ID, in place of org membership. They're the team's owner.
- **Nobody else signs in.** A personal account has no members, and its repos' collaborators
  aren't the account. Anyone else is refused at sign-in with 403 `access_denied`, as a
  non-member is ([03](03-identity-access.md#people)).
- **Agents and services work as on any team:** service tokens (`bdx tokens create --service`),
  grants for GitHub Actions OIDC, and registered watchers.
- **The limits are a free team's**, the same as an org's.
- **Teammates come later**, two ways: a member list of the team's own, or moving the team to
  an org. The team's ID is Dosu's, so an operator can point its `github` link at the org and
  keep its host and boards.

### Leaving, suspending, and deleting

- **`installation.suspend`** marks the team `suspended`. Its boards answer 403
  `team_suspended`. `unsuspend` restores it.
- **`installation.deleted`** marks the team `uninstalled`. Its boards answer 403
  `team_uninstalled` with how to come back. Installing again within 30 days restores
  everything.
- **After 30 days uninstalled**, the daily cron deletes the team: each board's DO and TailDO
  (`ctx.storage.deleteAll()`), its files in R2, its DirectoryDO, and its record. Owners can
  `bdx export` each board before they leave.
- **Dosu can suspend a team** for abuse with the operator routes (see [Operating it](#operating-it)).

## Signing in

The flows are spec 03's. What changes is which account and App they check.

- **One App for every team.** The hosted Worker uses Dosu's public GitHub App, `bordeaux-ai`
  (`bordeaux` is an existing GitHub account, and an App's name can't match one): its client ID
  for the device flow and the web flow, its private key for installation tokens. The team
  record supplies the org and the installation, in place of `BORDEAUX_GITHUB_ORG` and
  `GITHUB_INSTALLATION_ID`.
- **`bdx login https://acme.board.dosu.ai`** runs the device flow against acme's host, which
  checks membership in acme. Nothing in `bdx` changes: it already takes any board URL.
- **Each team is its own issuer.** `iss` and `aud` are the team's URL, and its DirectoryDO holds
  its signing keys, refresh tokens, and revocations. A token made out to one team fails at
  another's on its audience, and again on its issuer's keys.
- **The web flow's callback is on the hub.** A GitHub App lists at most 10 callback URLs, so
  teams share `https://board.dosu.ai/inspect/callback`:
  1. The team's inspector makes the state, sets it in its own state cookie as today, and
     sends the person to GitHub with `redirect_uri` the hub's callback and `state` =
     `<team host>.<state>`.
  2. The hub reads the host from `state`, checks it's a team's, and answers 302 to
     `https://<team host>/inspect/callback` with the same `code` and `state`. The hub
     exchanges nothing and sets nothing.
  3. The team's host checks `state` against its cookie, exchanges the code with the same
     `redirect_uri`, checks membership, and sets its session cookies, as today.

  The hub redirects only to registered hosts, so it isn't an open redirect.
- **Owners** are the org's GitHub owners, or a personal team's one person. `BORDEAUX_OWNERS`
  has no hosted counterpart in v1.

## What a hosted team gets

| Feature | Hosted | Why |
| --- | --- | --- |
| The protocol: channels, threads, tasks, schedules, grants, schemas, files | yes | |
| The inspector, `bdx`, `vb`, `@dosu/bordeaux/app` | yes | |
| Named boards | yes, up to the team's limit | |
| Service tokens (`bdx grants create --service`) | yes | |
| GitHub Actions OIDC | yes | |
| Registered watchers, woken by URL | yes | The team's app runs anywhere and pulls its matches ([04](04-watchers.md)). |
| Wake by service binding | no | Only a caller verified through a service binding may register one ([04](04-watchers.md#wake-ups-without-vercel-δ)), and a binding names one of Dosu's own Workers. |
| Config watchers, middleware | no | A deployment's code in `configure()`. The hosted Worker's `configure()` is Dosu's: its middleware runs on every team's boards, and it sets no `watch` or `sync`. |
| Sync | GitHub, as rows (`bdx sync add`); Slack and Linear later | [Sync, later](#sync-later) |

## Limits

Free teams get limits from day one. Each is a Worker var, so Dosu can change it without a
release, and a team record may override one later for paid plans.

| Limit | Default | When it's hit |
| --- | --- | --- |
| Named boards per team | 20 | 403 `limit_boards` on `bdx boards create` |
| Board data per team | 1 GB | 413 `limit_data` on writes |
| File bytes per team | 5 GB | 413 `limit_files` on `upload` and `uploadStart` |
| Requests per team | 300 a minute | 429 `rate_limited` with `retry-after`, from Cloudflare's rate-limiting binding keyed by team |
| Registered watchers per board | 50 | 403 `limit_watchers` |
| Wakes per team | 60 a minute | wakes wait in the Queue |

- **Wake URLs** must be `https` on a public host. A wake carries no event and no credential
  ([04](04-watchers.md#wake-ups-without-vercel-δ)), so a hostile URL learns nothing, and the
  wake limit caps what Dosu sends anywhere.
- **Board data** is what the team's boards' Durable Objects store: messages, tables, and
  their history. Each board's DO reads its own `databaseSize` and reports it to the team's
  DirectoryDO after writes, at most once a minute, so a team can go over by about a minute of
  writes. Past the limit, writes answer 413; reads and `bdx export` still work. The log is
  append-only, so deleting messages frees no space: a team over the limit needs a higher one.
- **What a free team costs Dosu at most** (Cloudflare's prices, 2026-11-26): 300 requests a
  minute nonstop is about 13 million a month, each a Worker request and a DO request, about
  $6. 1 GB of board data is $0.20 a month.
- **Usage is recorded** per team by the daily cron (boards, file bytes, messages), for limits
  now and plans later.
- The defaults are guesses to check against real use (see [Open](#open)).

**As built:** the vars are `BORDEAUX_LIMIT_BOARDS`, `BORDEAUX_LIMIT_DATA_BYTES`,
`BORDEAUX_LIMIT_FILE_BYTES`, and `BORDEAUX_LIMIT_WATCHERS`, and a team record's `limits`
overrides any of them. Requests and wakes are two rate-limiting bindings, `REQUEST_LIMITER` and
`WAKE_LIMITER`, so their numbers are in `wrangler.jsonc`, not vars, and a record can't change
them. Over the data limit, deleting a message and canceling a schedule still work, since they
stop more coming. Files count when a direct upload starts, at once, not a minute later. A
board reports what it stores before a write is checked, at most once a minute, so the first
write after its DO starts is checked against the team's totals, and a board over the limit
learns when they go down. Every call to a board's DO carries the team's record as the request
found it, so a changed limit reaches the board within the 5 minutes a team's record is kept.
An empty limit var is unset. Wakes
are the board's alarm, not a Queue: one past the limit waits 10 seconds and tries again, and
one wake covers every match until it goes.

## How the Worker changes

### Hosted mode

A deployment is hosted when `BORDEAUX_HOSTED_URL` is set (`https://board.dosu.ai`), with the
`REGISTRY` binding. Then `BORDEAUX_URL`, `BORDEAUX_GITHUB_ORG`, `GITHUB_INSTALLATION_ID`, and
`BORDEAUX_OWNERS` must be unset: the Worker refuses to start with them, so a team never falls
back to the operator's org. A `configure()` that sets `watch` or `sync` is refused the same
way. (`teamSync`, which builds each team's sync from its rows, is allowed: see
[Sync, later](#sync-later).)

**As built:** the variable is the hub's URL, not its domain, so a laptop's hub can be
`http://board.localhost:8787` and its teams `http://<login>.board.localhost:8787`. A Worker
can't refuse to start, so it answers every request 500 `misconfigured`, naming what's set.
`wrangler.hosted.jsonc` runs hosted mode locally, and on a hosted deployment with
`BORDEAUX_DEV=1`, `POST <hub>/__dev/team {"login": "acme"}` makes a team with no App behind it.

### The team, per request

Today the Worker reads the board's URL, org, and installation from `env`. Hosted, they come
from the request's host. Both modes go through one shape:

```ts
interface Team {
  id: string              // 'default' self-hosted, 't_<random>' hosted
  url: string             // BORDEAUX_URL, or https://<host>
  org: string | undefined // BORDEAUX_GITHUB_ORG, or the record's github login
  installation: string | undefined
  owners: string[]
  person?: string         // a personal team's one person, by GitHub user ID
}
```

- **`teamOf(request, env)`** answers the env's team self-hosted, and the registry's hosted.
  The router calls it first and passes the team everywhere that reads those env vars today:
  `boardOf`, `boardUrl`, `boardNamed`, the broker, the inspector, admin, uploads, and the JWKS
  route.
- **`boardOf` caches per team and board**, as `<team id>/<board>`.
- **`boardKey` takes the team ID** in place of the constant `default`.
- **`directory(env)` becomes `directory(env, team)`**, one DirectoryDO per team.
- **The board's DO** builds its own `board()` for alarms (`runOwn`). It knows its key, so it
  reads its team from the registry by the key's prefix.

  **As built:** the Worker hands the DO its team with every call, as it hands over the board's
  name, and the DO keeps the last one for its alarms. Its `board()` is built synchronously, so
  it can't wait on the registry. A self-hosted DO reads env, as before.
- **Crons fan out.** The daily retention cron puts one Queue message per team on a
  `bordeaux-teams` Queue, so no one invocation walks every team. The 15-minute sync check has
  nothing to do in hosted mode: GitHub sync, the only hosted sync so far, needs no sign-in to
  start its webhooks.

### Operating it

- **Operator routes** at `https://board.dosu.ai/__bordeaux/teams/*` list teams and their
  usage, and suspend, restore, or delete one. They need a bordeaux token from the hub's own
  sign-in that names an owner of `BORDEAUX_OPERATOR_ORG` (`dosu-ai`).
- **What Dosu can see.** The operator holds every hosted board's data. The hosted board's
  terms must say so. Operator routes show usage, not content.

**As built:** the routes are `GET /__bordeaux/teams`, and for one team `GET`, `POST
/suspend`, `POST /restore`, `PATCH /limits` (a record's own limits), and `DELETE` (now, not
after 30 days), at `/__bordeaux/teams/<team id>`. The hub signs operators in as a team of its
own, ID `hub`, with the device flow at `<hub>/auth/*`: `bdx login https://board.dosu.ai`. An
owner is an admin of `BORDEAUX_OPERATOR_ORG` at sign-in. The hub's team has no installation, so
a renewal after 12 hours asks the operator to sign in again. Dosu's suspension is a hold apart
from GitHub's state (`held_at`): neither GitHub's `unsuspend` nor installing the App again
lifts it, only `POST /restore`. Deleting a team marks it `deleting` first, so installing the
App meanwhile doesn't restore a team half gone, and it deletes the boards the team deleted
too, whose Durable Objects kept what they had. Each destroyed object resets itself, so nothing
it held in memory writes again. The daily usage record
is boards, board data, and file bytes, not messages: counting them would wake every board.

**As built:** the terms are Dosu's, not bordeaux's, so `packages/hosted` serves them at the
hub's `/terms` and `/privacy` (`src/legal.ts`), adding to Dosu's own at `dosu.dev/legal`. The
hub's front page says installing agrees to both when `BORDEAUX_TERMS_URL` and
`BORDEAUX_PRIVACY_URL` are set. Workers Logs keep 7 days of requests and errors, and Workers
Issues alerts on each new error ([docs/hosted.md](../docs/hosted.md), step 7).

## Sync, later

Hosted sync is the built-in providers configured as data, not code. Upstream's helpers already
reduce a sync to a table: a platform's channel, repo, or team, the board channel it maps to,
and a direction (`mirror` or `into`). Custom sync functions stay self-hosted.

- **Per-team sync settings** are rows in the team's DirectoryDO,
  `{ provider, external id, channel, direction }`, set with `bdx sync add` and `bdx sync rm`
  (owners only). `boardOf` builds the default board's providers from them, and a change
  drops the cached `board()`.
- **One app per platform, run by Dosu.** Each platform sends every team's webhooks to one URL,
  so the hub routes them: `POST /__bordeaux/<platform>/events` finds the team from the event
  (GitHub's installation, Slack's `team_id`, Linear's organization) and passes it to that
  team's board at `/webhooks/<key>`.
- **Per-team platform tokens** (Slack bot tokens, Linear tokens) are sealed with AES-GCM
  under a Worker secret and kept in the team's DirectoryDO. GitHub needs none: the Worker
  mints installation tokens.
- **Order.**
  1. **GitHub**, through a second public App with issues and pull-request write access,
     installed when a team turns sync on. Sign-in's App keeps asking only for members, so
     signing up stays a small ask.
  2. **Slack**, a distributed Slack app with OAuth installs. Check first: since 2025 Slack
     limits `conversations.history` and `conversations.replies` for commercially distributed
     apps outside its Marketplace, and attaching a channel backfills it from history.
  3. **Linear**, an OAuth app per workspace.

v1 leaves room for this without building any of it: team records and DirectoryDOs are per
team, and the hub's webhook route is namespaced by platform.

**As built (GitHub):**

- **The rows.** A team's DirectoryDO keeps `bx_sync`, one row per provider and external ID:
  `{ provider, external, channel, direction, by, created_at }`. `GET /admin/sync` lists them
  for anyone the default board lets in. `POST` and `DELETE` change them, for the team's owners
  only, as their last sign-in found them: a service token can't, even one that manages every
  channel. `bdx sync add github
  acme/www prs [--mirror]`, `bdx sync rm github acme/www`, and `bdx sync list` call them.
  `sync` is also upstream's `vb sync <id> [target]`, so `bdx` takes `add`, `rm`, and `list` and
  hands anything else to upstream's. A self-hosted board's sync is its code: there,
  `/admin/sync` answers 404.
- **A GitHub row's repo is on the team's own account** (`<login>/<repo>`): the sync App's
  installation can't reach another account's repos. A row maps every PR and issue of the repo
  (upstream's `repos()`), `into` the channel by default, or `mirror` to send board replies back.
  Upstream matches a repo as GitHub writes it, case included, so the owner must be the login
  exactly; the repo's own case isn't checked yet. The channel is one upstream can name
  (lowercase segments of letters, numbers, `_`, and `-`, joined by `/`), or every import would
  fail.
- **Which providers a team may use is the hosted Worker's `configure()`**:
  `configure((env) => ({ teamSync: { github: githubTeamSync(env) } }))`. Hosted mode still
  refuses `watch` and `sync`, which would run Dosu's code on every team's board; `teamSync`
  only builds the built-in providers from each team's rows. A provider whose secrets aren't set
  is null, and `/admin/sync` refuses rows for it. With none of its settings set it's off
  quietly, since every isolate would log it; with some set and not others, it logs which are
  missing. A self-hosted deployment ignores `teamSync`.
- **The team carries its rows.** `boardOf` is synchronous, and a board's DO builds its own
  `board()` for its alarms from the team the Worker hands it, so the rows travel with the team:
  `teamAt` reads them from the DirectoryDO with the record and keeps both for the same 5
  minutes, and every call to a board's DO carries them. `boardOf` builds `board()` again when a
  team's rows or its sync installation differ from those it was built with. Changing a row
  drops this isolate's kept host, so it takes effect here at once and on other isolates within
  5 minutes. When `teamSync` names no provider, nothing extra is read. The rows carry when they
  last changed (`version`, from the DirectoryDO) and the links theirs (`sync_at`, on the record),
  and a board's DO keeps the newer of each, so an isolate that kept the team longer can't hand it
  back older rows or links.
- **The sync App** is `bordeaux-ai-sync` (`GITHUB_SYNC_APP_SLUG`), with `GITHUB_SYNC_APP_ID`,
  and the secrets `GITHUB_SYNC_PRIVATE_KEY` and `GITHUB_SYNC_WEBHOOK_SECRET`. Its setup URL is
  `<hub>/sync/setup`: the hub asks GitHub, as the sync App, whose installation it is, and links
  it to that account's team. Its `installation.created` event does the same, so either comes
  first. `deleted` and `suspend` unlink it; `unsuspend` links it again. An account with no team
  gets no link: it installs `bordeaux-ai` first. The registry keeps the link on the team's
  record (`sync.github`) and indexes it by installation.
- **Webhooks.** Both Apps send to `/__bordeaux/github/events`. The hub tells them apart by
  `X-GitHub-Hook-Installation-Target-ID`, the App's ID, and checks each App's signature with
  that App's own secret. A sync event's installation finds the team, and the hub hands the event,
  as GitHub sent it, to that team's default board at `/webhooks/github`, where upstream's provider
  checks the signature again and puts it in the board's inbox. The hub reads the team's record
  and rows fresh for each sync event, not as its isolate kept them, so the first events after an
  install or a new row aren't lost: one more DirectoryDO read per event. An event for an
  installation with no team, or a team that's suspended or uninstalled, is dropped with 200
  `{ "team": null }`, and one for a team that maps none of its repos yet with 200
  `{ "team": "<id>", "synced": false }`, so GitHub doesn't list it as a failed delivery.
- **A team's own host answers 404 on `/webhooks/*`.** Platforms reach a hosted board only
  through the hub, which picked the team by installation.
- **Tokens.** The provider is Chat SDK's GitHub adapter with the sync App's ID and key and the
  team's installation ID, so the Worker mints each team's installation tokens and keeps none.
- **Not yet:** `bdx health`'s sync check and `bdx redact --everywhere` read `configure()`'s
  sync, not a team's rows; `bdx sync add` doesn't check that the App can see the repo.

**Slack and Linear, later,** need what GitHub doesn't: an OAuth install flow on the hub
(`<hub>/slack/oauth/callback`) that seals each team's bot token with AES-GCM under a Worker
secret into its DirectoryDO, a registry index by Slack `team_id` or Linear organization ID,
`teamSync.slack` and `teamSync.linear` builders that unseal the token, and the hub's
`/__bordeaux/slack/events` answering Slack's `url_verification` itself. Slack's history limits
for commercially distributed apps outside its Marketplace come first (see above).

## Testing

- **vitest in workerd**, in hosted mode with two teams in one Worker, GitHub and Cloudflare's
  APIs answered by `outboundService`:
  - A token for one team fails at the other, on audience and on issuer.
  - Each team's boards, directories, and files are separate.
  - A host with no team answers 404 `no_team`, and a suspended or uninstalled team's 403.
  - A personal team signs in its one person and refuses anyone else.
  - Sign-up from `/setup` and from `installation.created` make one team, whichever comes first.
  - The hub's callback redirects only to registered hosts.
  - Each limit answers its error.
  - Self-hosted mode's keys and behavior are unchanged: the existing suite runs as it is.
- **Conformance** runs against a hosted team as well as a self-hosted board, every group.
  Locally a team is at `http://<org>.board.localhost:<port>`
  (`pnpm --filter @dosu/bordeaux conformance --hosted`), which Node resolves to loopback.

  **As built:** the hosted tests run on their own vitest config (`vitest.hosted.config.ts`),
  since the pool's `outboundService` doesn't reach a Worker in vitest's `projects`.
- **Hosted sync, in vitest:** two teams in one Worker, each with its rows and its own sync App
  installation, GitHub's API answered by `outboundService`. A webhook for one team's
  installation lands only on that team's board, and only by its own rows; a board reply goes
  back with that installation's token; members can read rows but not change them; an event
  that isn't the sync App's, or is sent straight to a team's host, is refused; an uninstalled
  sync App's or a suspended team's events are dropped; a link made on another isolate counts for
  the next event; an event for a team with no rows answers 200. Which of two views of a team's
  sync a board's DO keeps is tested on its own, not through the DO: in one test isolate the board
  takes an event before a stale view could reach it. Not checked live: the sync App isn't
  registered yet ([docs/hosted.md](../docs/hosted.md), step 7).
- **Live,** on `board.dosu.ai`: sign-up, sign-in by device and by browser, and a post, for
  `dosu-ai`, a second test org, and a personal account.

  **Live run, 2026-11-26,** against Worker version `3e12d4fd` (`main` at `9aaf27c`), set up by
  [docs/hosted.md](../docs/hosted.md):
  - The hub at `board.dosu.ai` links to `github.com/apps/bordeaux-ai`; `nobody.board.dosu.ai`
    answers 404 `no_team`; an unsigned webhook answers 401.
  - `dosu-ai` and the personal account `devstein` each installed the App. GitHub's setup URL
    sent each to its board, and each `installation.created` delivery answered 200 with a new
    team ID.
  - On each board, `bdx login` signed in by device flow, `bdx doctor` passed every check, and a
    post read back. The inspector signed in through the hub's callback and showed that board's
    post, and only it.
  - A token from `dosu-ai`'s board answers 401 `untrusted issuer` at `devstein`'s.

  Not checked live: a second org, and a personal board refusing someone else (only one GitHub
  user took part; vitest covers it). Nor were renames, suspending, uninstalling, the limits, or
  the daily cron.

## Open

- **The limits' numbers**, checked against real use.
- **What the live run didn't check:** a second org, a personal board refusing someone else,
  renames, suspending and uninstalling, and the daily cron on real teams.
