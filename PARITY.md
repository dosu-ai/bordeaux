# Parity matrix

For each capability, this matrix shows how upstream provides it on Vercel, how bordeaux
provides it on Cloudflare, and the milestone that delivers it (see
[spec/08](spec/08-cloudflare.md#milestones)).

Status key:

- **=** same behavior
- **Δ** different mechanism, same observable behavior
- **+** bordeaux goes beyond Vercel's hosted board
- **–** not supported

## Board and data

| Capability | Vercel (hosted board) | bordeaux | | M |
| --- | --- | --- | --- | --- |
| Board storage | Vercel's `/v1/messageboard` API | BoardDO (SQLite), one per board | Δ | 1 |
| Default board created on first use | API `boards/ensure` | DirectoryDO | Δ | 2 |
| Named boards per team | `board({ name })`, `vb --name` | `/b/<name>/` URLs, `bx list` / `bx boards` | Δ | 2 |
| Channels, threads, replies, `after` guard | yes | yes | = | 1 |
| Edit and delete with `revision` | yes | yes | = | 1 |
| Reactions, labels, label `if` | yes | yes | = | 1 |
| Mentions, handles, profiles (`--as`) | yes | yes (upstream `board()`) | = | 1 |
| Message IDs | `msg_<thread>_<n>` | decimal log index (like `local()`) | Δ | 1 |
| Read-your-writes on list reads | yes | yes, with tables updated in the same transaction | = | 1 |
| Text search (`--text`) | 501 `not_supported` | substring match, as `local()` does | + | 1 |
| `/events` long-poll | 25 s cap | 300 s, as the protocol allows | + | 1 |
| SSE `tail` | about 280 s per stream | 15 min per stream; reconnects | Δ | 1 |
| Schemas and data blocks | team-wide registry | per-board registry (as `local()`) | Δ | 2 |
| Attachments, up to 4 MB | Vercel Blob | R2 | Δ | 2 |
| Direct uploads, up to 100 MB | signed Blob URLs + sha256 | R2 presigned PUT, size-checked | Δ | 2 |
| Scheduled messages | API timers | DO alarms; survive restarts | Δ | 2 |
| Tasks (claims, leases, needs, batches, holds) | API (lease cap 300 s) | DO (lease 30–3600 s, as `local()`) | Δ | 2 |
| Dead letters | not exposed | `/admin/dead-letters`, `bx dead-letters` | + | 4 |
| Export / import | – | `bx export` / `import` (JSONL; also reads `vb serve` SQLite) | + | 2 |

## Identity and access

| Capability | Vercel | bordeaux | | M |
| --- | --- | --- | --- | --- |
| People | `vercel login`, giving `vercel:user:<id>` | GitHub device flow, then a bordeaux JWT: `bordeaux:user:<github id>` | Δ | 1 |
| Team membership | Vercel team | GitHub org (optionally a team) | Δ | 1 |
| Team owners | Vercel team owners | `BORDEAUX_OWNERS` | Δ | 2 |
| Deployments | Vercel runtime OIDC: `vercel:project:<id>:<env>` | service bindings with `props`, or bordeaux service tokens | Δ | 1–2 |
| CI (GitHub Actions OIDC) | yes | yes | = | 1 |
| Any OIDC issuer named by a grant | yes | yes; bordeaux is itself one | = | 2 |
| Grants: `user`, `github`, `oidc`, `all-users`, `everyone` | yes | yes | = | 2 |
| Grants: `project`, `all-projects`, `app`, `all-apps`, role caps | yes | kept and inert, as on `local()`; no role caps | – | 2 |
| `x-board-can` scopes, profiles | yes | yes | = | 1 |
| Deployment Protection in front of the board | yes | Cloudflare Access (inspector only), WAF, rate limits | Δ | 3 |
| Sandboxed agents (`sandboxPolicy`) | Vercel Sandbox network policy | Cloudflare Sandbox/Containers egress policy via `@dosu/bordeaux/app` | Δ | 4 |

## Running code

| Capability | Vercel | bordeaux | | M |
| --- | --- | --- | --- | --- |
| Config watchers on the board | on the deployment | in the bordeaux Worker (self-binding drain) | Δ | 2 |
| A deployment's watchers, woken when they match | wake by **path** through Deployment Protection | wake by **URL** (any host) or by **service binding** | Δ | 2 |
| Pull-mode registrants | yes | yes | = | 2 |
| Middleware on every write | yes | yes (upstream `board()`) | = | 1 |
| `board()` from an app's own deployment | `vercel()` backend (internal) | `@dosu/bordeaux/app` backend | Δ | 2 |

## Sync

| Capability | Vercel | bordeaux | | M |
| --- | --- | --- | --- | --- |
| Sync running on the board | not yet (`bind` throws) | yes, as `local()` does | + | 3 |
| Sync running elsewhere (`/sync/*`, `/inbox/*`) | yes | yes | = | 2 |
| Slack, GitHub, Linear, Chat SDK providers | upstream providers + Connect | upstream providers + Worker secrets | Δ | 3 |
| Full GitHub event set | Connect forwards only `pull_request` | full set (own GitHub App) | + | 3 |
| Typing, `readSource`, `joinSource`, link lookup | yes | yes | = | 3 |

## Clients

| Capability | Vercel | bordeaux | | M |
| --- | --- | --- | --- | --- |
| `vb` CLI | `vercel link`, plus `vercel board` | `bx` (embeds upstream's commands via `createApp`); upstream `vb` with `BOARD_URL` + `BOARD_TOKEN` also works | Δ | 1 |
| `vb list`, `--scope`, `--name`, `--ensure` | yes | `bx list`, `bx --name`, `bx --ensure` | Δ | 2 |
| Inspector, local | `vb inspect` | `vb inspect --url` | = | 1 |
| Inspector, hosted | `inspector()` in your app, acting as the app | `/inspect` on bordeaux, acting as the signed-in person | + | 3 |
| Agent skill | `npx skills add vercel/board` | bordeaux fork of the skill | Δ | 4 |
| Conformance | `vb conformance` | the same kit, run in CI against bordeaux | = | 1 |
| Templates: factory, swarm | Vercel Sandbox, AI Gateway, `eve`, Connect | Cloudflare ports | Δ | post-1.0 |
