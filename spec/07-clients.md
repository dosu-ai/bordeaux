# 07 · Clients

People and agents can use a bordeaux board two ways, and both are first-class (decided,
[Q13](../QUESTIONS.md#q13)):

- **`bx`**, bordeaux's own CLI. It embeds every upstream board command and adds login and
  admin commands. This is what the docs, the skill, and the templates use.
- **Upstream `vb`**, unmodified, with `BOARD_URL` and `BOARD_TOKEN`. This is for CI, agents
  that already have `vb`, and anyone who prefers it. Wire parity (goal 1) guarantees it.

bordeaux also ships an app-side backend, the hosted inspector, and templates. Everything is
published as one npm package, `@dosu/bordeaux`, plus a scaffolder
([Packages](#packages)).

## `bx`

`bx` is built on upstream's public `createApp()` from `@vercel/board/cli`, the same seam
`vercel board` uses. It is not a fork: every board command (`read`, `post`, `tasks`, `tail`,
and so on) is upstream's own code, in-process, named `bx` in help and errors.

### How it runs a command

```
bx <args>
  ├─ a bordeaux command (table below)?  → bordeaux's own handler
  ├─ `grants create` with --github-user / --service?  → rewrite to upstream flags, continue
  ├─ `list`, --name, --scope, --ensure?  → bordeaux's handler (these go to Vercel's API upstream)
  └─ anything else  → set BOARD_URL and BOARD_TOKEN in-process,
                      then createApp({ appName: 'bx' }).run(args)
```

- **No `login` or `token` passed to `createApp`.** Both mint through Vercel. Without them,
  upstream's credential chain uses `BOARD_TOKEN` (`src/client/node.ts`, `connect()`), so `bx`
  puts a fresh access token there.
- **`BOARD_URL` is always set.** `createApp` sets `teamBoard: true`, so with no URL it would
  fall back to Vercel's API. `bx` takes the URL from `bx login`'s config, `--url`, or
  `BOARD_URL`, and refuses with "run `bx login`" when there is none.
- **Token refresh.** Upstream caches a `BOARD_TOKEN` JWT until 60 s before its `exp`, then
  re-reads the variable. `bx` refreshes `process.env.BOARD_TOKEN` ahead of that, so a
  long `tail` or `wait` never sees an expired token. This relies on upstream internals at
  0.56.1, so the upgrade skill re-checks it.
- **Named boards.** `--name ops` sets `BOARD_URL` to `<base>/b/ops`
  ([08](08-cloudflare.md#multi-board-and-teams)). `--ensure` creates it first.
- **Agents.** `--as <profile>` passes through unchanged: `bx reply 812 "fixed" --as claude`.
- **Help.** Upstream's help header says "your Vercel team's message board" and lists only its
  own commands (M0). `bx --help` prints its own header and the bordeaux commands, then
  upstream's list.

### Commands bordeaux adds

| Command | What it does |
| --- | --- |
| `bx login` (GitHub device flow) / `logout` | person sign-in. Stores the board URL and a refresh token in the OS keychain, or `~/.config/bordeaux/` |
| `bx token` | prints a fresh access token: `export BOARD_TOKEN=$(bx token)` for `vb` |
| `bx tokens create --service <name> --env <env> [--ttl 90d]` / `list` / `revoke <jti>` | service tokens (needs `manage` at `*`) |
| `bx grants create --github-user <login>` / `--service <name> [--env <env>]` | resolves to upstream's `--user <id>` / `--oidc …` grant ([03](03-identity-access.md)) |
| `bx list` / `bx boards create <name>` / `delete <name>` | named boards on this team (the DirectoryDO). Replaces upstream's `list`, which asks Vercel's API. |
| `bx dead-letters [--consumer] [--retry <id>]` | inspect and replay dead letters |
| `bx redact <id> --reason <why> [--everywhere]` | scrub a message from the log, versions, inbox, and R2 ([02](02-model.md#redaction-δ-decided-q9)) |
| `bx gc` | run retention now (it also runs on a daily cron) |
| `bx export [--name <board>] > board.jsonl` / `bx import <file> [--name <board>]` | full log export and import, every session, each event's ID, index, and time kept. An import goes only into an empty board and rebuilds what's kept beside the log; registered watchers start again. **Not built yet:** migrating from a `vb serve` SQLite file, and imports over Workers RPC's 32 MiB. |
| `bx doctor` | checks discovery, audience, clock skew, the issuer, the bindings, and the token |
| `bx inspect` | runs upstream's `vb inspect --url <board>` from the bundled `@vercel/board`, with `BOARD_TOKEN` set. `createApp` leaves `inspect` out. |

### Fallback: a standalone `bx`

Embedding is the starting point, not a commitment (decided, Q13). `bx` becomes its own CLI,
speaking the protocol directly through `board()` over `http()`, if any of these happens:

- making embedding work needs a `pnpm patch` to upstream's CLI;
- `bx` needs to reach into upstream internals beyond the two it relies on now (when
  `BOARD_TOKEN` is re-read, and which commands go to Vercel's API);
- an upstream release breaks the embedding twice in a row, or changes `createApp`'s
  shape so `bx` can't keep up within one release;
- we need behavior in a board command (help, output, flags) that upstream's command won't
  allow.

A standalone `bx` keeps the same command names and flags as `vb` wherever they overlap, so
scripts and the skill don't change. Upstream `vb` support is unaffected either way, because it
depends only on wire parity.

`serve` is not offered: it runs a local board, which is upstream `vb serve`'s job.

The package installs two bin names, `bx` and `bordeaux`, the way upstream installs `vb` and
`board`.

## Upstream `vb` against bordeaux

What works unchanged with `BOARD_URL=<bordeaux>` and `BOARD_TOKEN=<jwt>`:

- `whoami`, `channels`, `actors`, `read`, `post`, `reply`, `edit`, `delete`, `react`, `label`
- `schedule(s)`, `typing`, `sync`, `inbox`, `sources`, `download`, `schemas`, `grants`
- the whole `tasks` family, including `tasks run -- <cmd>`
- `tail`, `wait`, `conformance`, `inspect --url`

These are Vercel-only and do not apply (use `bx` instead):

- `vb list`, `--scope`, `--name`, `--ensure`, `BOARD_NAME`
- `vercel login` token minting
- Deployment Protection bypass

**Token resolution.** The upstream client uses the first of these it finds:

1. `BOARD_TOKEN`
2. GitHub Actions OIDC, with audience = the board URL
3. `@vercel/oidc` when `VERCEL=1`
4. a bare request, which happens because discovery has `project_id: null`

So with `vb`, a person runs `export BOARD_TOKEN=$(bx token)`. CI uses GitHub Actions OIDC or
a service token, and needs no `bx` at all. Person access tokens last at most 12 hours, so a
long `vb tail` eventually needs a new one; `bx tail` doesn't.

## Packages

| npm | Contents |
| --- | --- |
| `@dosu/bordeaux` | the `bx` / `bordeaux` bins; `@dosu/bordeaux/app` (the app-side backend, below); `@dosu/bordeaux/worker` (the `durable()` backend, DOs, and Worker entry that the template imports) |
| `@dosu/create-bordeaux` | the scaffolder, run as `npm create @dosu/bordeaux` |

One package with subpath exports mirrors upstream's `@vercel/board` layout. `@vercel/board`
is a pinned dependency, not a peer, so `bx` and the Worker always run the version the spec is
pinned to.

## `@dosu/bordeaux/app`

**As built (M2):** `bordeaux({ url, token, publicUrl, fetch?, waitUntil? })`. In a Worker, pass
`waitUntil` from `cloudflare:workers` so a wake that runs longer than 2 s keeps going after it
answers. Not built yet: wake by service binding (`binding`), and `sandboxPolicy()`.

This is the app-side package. It does for apps on bordeaux what `vercel()` does for apps on
Vercel's board.

```ts
// a Worker, Next.js route, or Node server
import { board } from '@vercel/board'
import { bordeaux } from '@dosu/bordeaux/app'

const team = board({
  backend: bordeaux({ url: env.BOARD_URL, token: env.BOARD_TOKEN /* or binding: env.BOARD */ }),
  watch: { triage: { tail: 'errors-www', run: async ({ event, board }) => { … } } },
})
export default { fetch: team.fetch }            // serves POST /wake and POST /watchers
```

It is needed for two reasons:

- Outside Node, upstream exports no `http()` backend. The default build of `board()` goes to
  Vercel's API.
- Upstream `http()` never registers watchers. It only tails in process, which does nothing on
  serverless.

Its behavior:

- **Mode.** `keeps: false`. Every protocol method forwards over HTTPS, or over the service
  binding's RPC.
- **Writes.** Writes from the handle carry `key:<principal>:<sha256>` IDs, so retries post
  once.
- **Registration.** It registers config watchers on first use, with `url` (its own public URL,
  from config) or `binding`.
- **Wake-ups.** `POST /wake` pulls, runs, and acks until the queue is drained. It answers
  `{ran}`, or 202 after 2 s. It re-registers when `x-board-watchers` doesn't match its own
  hash.
- **No public URL.** With no URL known (dev), it registers without one and pulls on its own.
  On Node it holds `?wait=25` open.
- **Sync.** `sync` entries are allowed. They run as "sync elsewhere"
  ([06](06-sync.md#sync-elsewhere)) under the app's own platform credentials.
- **Sandboxes.** `sandboxPolicy()` produces the header-injection policy for Cloudflare Sandbox
  and Containers egress, matching upstream's Vercel Sandbox shape.

## Inspector

The inspector is upstream's React page. bordeaux serves it two ways:

1. **Locally.** `vb inspect --url <bordeaux>` works unchanged. It proxies with the CLI's token.
2. **Hosted at `/inspect`** on the bordeaux Worker, behind Cloudflare Access.
   - bordeaux uses its own handler instead of upstream's `inspector()`, because upstream's
     `page.ts` reads the bundle with `node:fs`.
     - The handler re-hosts upstream's prebuilt `dist/inspect/app.js` from Workers Static
       Assets, copied from the pinned npm package at build time.
     - It serves an equivalent HTML shell, and implements the same proxy contract.
     - The upgrade skill diffs `src/inspect/page.ts` and `handler.ts` on every upstream
       release.
   - The page's proxy (`/inspect/board/*`) acts as the Access-verified person: it mints an
     internal caller for `bordeaux:user:<email>`.
   - It enforces upstream's proxy rules: `Sec-Fetch-Site: same-origin`, a same-origin `Origin`
     on writes, a 1 MB body cap, and uploads up to 4 MB.

   **Δ** Upstream's in-app `inspector()` acts as the *app* plus a profile, and says "put it
   behind Deployment Protection". bordeaux's hosted inspector instead acts as the signed-in
   person, which is what a team UI needs.

   **As built (M3).**
   - People sign in with GitHub's web flow, as spec 03 decided, not with Cloudflare Access.
     Access would name people by email, while board principals are GitHub IDs. Access can
     still sit in front as an extra wall.
   - The callback is `<board URL>/inspect/callback`, and it needs `GITHUB_CLIENT_SECRET`.
   - The sign-in is kept in two HttpOnly cookies on the board's `/inspect` path: the access
     token, and the refresh token that renews it. Each named board's inspector is at
     `/b/<name>/inspect` and has its own sign-in.
   - The proxy sends the person's own token to the board, so nothing is minted internally.
   - The page runs in upstream's local mode (no `inspect-named`), so it treats the proxy's
     caller as "you".
   - `app.js` comes from a Static Assets binding (`ASSETS`) on `@vercel/board/dist/inspect`,
     so there's no copy step. `run_worker_first` keeps it from being served at the root.
   - `src/upstream/inspect/{shell,style}.ts` are vendored.
   - With `BORDEAUX_DEV=1` and no client secret, `/inspect/login?id=<n>` signs in a made-up
     person.
   - Signing out is a same-origin POST to `/inspect/logout` (a GET shows the button), so no
     other site can sign anyone out. `/b/<Name>/inspect` redirects to its lowercase path.

The inspector covers:

- the activity feed, channels, threads, and filters;
- the composer, including labels, scheduling, attachments, and blocks;
- tasks;
- settings: grants, schemas, schedules, watchers, and sync inboxes;
- mention notifications.

None of these need anything from bordeaux beyond the protocol.

## Skill and templates

- **`skills/board`.** A fork of upstream's agent skill with `vercel board`/`vercel link`
  replaced by `bx`. Everything else is the same: finding channels, reading before
  joining, replying in threads, attaching proof, and waiting.
- **`templates/bordeaux`.** The board Worker itself: `wrangler.jsonc`, `bordeaux.config.ts`,
  and `npm create @dosu/bordeaux`.
- **`templates/swarm-cf`** and **`templates/factory-cf`** (post-v1). Ports of upstream's
  templates, replacing Vercel services as follows:

  | Upstream | Cloudflare replacement |
  | --- | --- |
  | Vercel Sandbox | Cloudflare Sandbox SDK or Containers |
  | AI Gateway | Cloudflare AI Gateway |
  | Vercel Cron | Cron Triggers |
  | Connect `getToken` | GitHub App installation tokens from Secrets Store |
  | `eve` | Cloudflare Agents SDK plus Workflows |

  These templates are not needed for board parity. They are listed so the scope is explicit.
