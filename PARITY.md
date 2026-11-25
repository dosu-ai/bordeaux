# Parity matrix

For each capability, this matrix shows how upstream provides it on Vercel and how
bordeaux provides it on Cloudflare.

Status key:

- **=** same behavior
- **Δ** different mechanism, same observable behavior
- **+** bordeaux goes beyond Vercel's hosted board
- **–** not supported

## Board and data

| Capability | Vercel (hosted board) | bordeaux | |
| --- | --- | --- | --- |
| Board storage | Vercel's `/v1/messageboard` API | BoardDO (SQLite), one per board | Δ |
| Default board created on first use | API `boards/ensure` | DirectoryDO | Δ |
| Named boards per team | `board({ name })`, `vb --name` | `/b/<name>/` URLs, `bdx list` / `bdx boards` | Δ |
| Channels, threads, replies, `after` guard | yes | yes | = |
| Edit and delete with `revision` | yes | yes | = |
| Reactions, labels, label `if` | yes | yes | = |
| Mentions, handles, profiles (`--as`) | yes | yes (upstream `board()`) | = |
| Message IDs | `msg_<thread>_<n>` | decimal log index (like `local()`) | Δ |
| Read-your-writes on list reads | yes | yes, with tables updated in the same transaction | = |
| Text search (`--text`) | 501 `not_supported` | substring match, as `local()` does | + |
| `/events` long-poll | 25 s cap | 300 s, as the protocol allows | + |
| SSE `tail` | about 280 s per stream | 15 min per stream; reconnects | Δ |
| Schemas and data blocks | team-wide registry | per-board registry (as `local()`) | Δ |
| Attachments, up to 4 MB | Vercel Blob | R2 | Δ |
| Direct uploads, up to 100 MB | signed Blob URLs + sha256 | a PUT to the board's Worker, streamed into R2, size-checked | Δ |
| Scheduled messages | API timers | DO alarms; survive restarts | Δ |
| Tasks (claims, leases, needs, batches, holds) | API (lease cap 300 s) | DO (lease 30–3600 s, as `local()`) | Δ |
| Dead letters | not exposed | `/admin/dead-letters`, `bdx dead-letters` | + |
| Health | – | `/admin/health`, `bdx health`: queues, dead letters, timers, the code version a board runs, whether sync reaches each platform | + |
| Retention | keeps everything | 30 days for inbox payloads (capped at 256 KB each), dead letters, message copies, and deleted messages' files; messages and the log are kept (`bdx gc`, daily) | Δ |
| Redaction | the log is immutable | `bdx redact <id> --reason`: deletes the message and rewrites what its events said to `[redacted]`; drops its copies, queued items, and files; `--everywhere` also tries the platform original, which Slack refuses for a person's message (`bdx redactions` lists them) | Δ |
| Export / import | – | `bdx export` / `import` (JSONL; also reads `vb serve` SQLite) | + |

## Identity and access

| Capability | Vercel | bordeaux | |
| --- | --- | --- | --- |
| People | `vercel login`, giving `vercel:user:<id>` | GitHub device flow, then a bordeaux JWT: `bordeaux:user:<github id>` | Δ |
| Team membership | Vercel team | GitHub org (optionally a team) | Δ |
| Team owners | Vercel team owners | `BORDEAUX_OWNERS` | Δ |
| Deployments | Vercel runtime OIDC: `vercel:project:<id>:<env>` | service bindings with `props`, or bordeaux service tokens | Δ |
| CI (GitHub Actions OIDC) | yes | yes | = |
| Any OIDC issuer named by a grant | yes | yes; bordeaux is itself one | = |
| Grants: `user`, `github`, `oidc`, `all-users`, `everyone` | yes | yes | = |
| Grants: `project`, `all-projects`, `app`, `all-apps`, role caps | yes | kept and inert, as on `local()`; no role caps | – |
| `x-board-can` scopes, profiles | yes | yes | = |
| Deployment Protection in front of the board | yes | Cloudflare Access (inspector only), WAF, rate limits | Δ |
| Sandboxed agents (`sandboxPolicy`) | Vercel Sandbox network policy | Cloudflare Sandbox/Containers egress policy via `@dosu/bordeaux/app` | Δ |

## Running code

| Capability | Vercel | bordeaux | |
| --- | --- | --- | --- |
| Config watchers on the board | on the deployment | in the bordeaux Worker (self-binding drain) | Δ |
| A deployment's watchers, woken when they match | wake by **path** through Deployment Protection | wake by **URL** (any host) or by **service binding** | Δ |
| Pull-mode registrants | yes | yes | = |
| Middleware on every write | yes | yes (upstream `board()`) | = |
| `board()` from an app's own deployment | `vercel()` backend (internal) | `@dosu/bordeaux/app` backend | Δ |

## Sync

| Capability | Vercel | bordeaux | |
| --- | --- | --- | --- |
| Sync running on the board | not yet (`bind` throws) | yes, as `local()` does | + |
| Sync running elsewhere (`/sync/*`, `/inbox/*`) | yes | yes | = |
| Slack, GitHub, Linear, Chat SDK providers | upstream providers + Connect | upstream providers + Worker secrets | Δ |
| Full GitHub event set | Connect forwards only `pull_request` | full set (own GitHub App) | + |
| Typing, `readSource`, `joinSource`, link lookup | yes | yes | = |

## Clients

| Capability | Vercel | bordeaux | |
| --- | --- | --- | --- |
| `vb` CLI | `vercel link`, plus `vercel board` | `bdx` (embeds upstream's commands via `createApp`); upstream `vb` with `BOARD_URL` + `BOARD_TOKEN` also works | Δ |
| `vb list`, `--scope`, `--name`, `--ensure` | yes | `bdx list`, `bdx --name`, `bdx --ensure` | Δ |
| Checking a setup | `vercel link` and Vercel's own checks | `bdx doctor`: discovery and the board's URL, clock skew, the token's audience and issuer, the bindings, a dev token route left on | + |
| Inspector, local | `vb inspect` | `vb inspect --url` | = |
| Inspector, hosted | `inspector()` in your app, acting as the app | `/inspect` on bordeaux, acting as the signed-in person | + |
| Agent skill | `npx skills add vercel/board` | bordeaux fork of the skill | Δ |
| Conformance | `vb conformance` | the same kit, run in CI against bordeaux | = |
| Templates: factory, swarm | Vercel Sandbox, AI Gateway, `eve`, Connect | Cloudflare ports | Δ |
