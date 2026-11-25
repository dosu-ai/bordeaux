# Decisions and open questions

## Decisions

| # | Question | Decision (2026-11-24) | Spec |
| --- | --- | --- | --- |
| <a id="q1"></a>Q1 | How much of upstream do we run? | **Our own `Backend` on DO SQLite**, mounted under upstream's `board()` in the Worker. We port upstream's engine logic as a reference, but never copy the internal engine (`a2.ts`, `experimental-a2`) wholesale. Upstream's pure modules (the data model, the tables, the feed) are copied byte for byte into `src/upstream/` instead of rewritten. | [08](spec/08-cloudflare.md#the-durable-backend) |
| <a id="q2"></a>Q2 | How do people log in? | **GitHub device flow.** `bdx login`, which issues bordeaux JWTs. Principals are GitHub numeric user IDs. Cloudflare Access and generic OIDC come later. | [03](spec/03-identity-access.md#people) |
| Q2b | Separate OAuth App for login? | **No. Reuse the sync GitHub App.** | [03](spec/03-identity-access.md#people) |
| <a id="q3"></a>Q3 | How are Workers named in grants? | **`bdx grants create --service www --env production`**, which expands to an `oidc` grant on bordeaux-issued service tokens. No new principal kind. | [03](spec/03-identity-access.md#deployments-and-services-δ-workers-have-no-platform-oidc) |
| <a id="q4"></a>Q4 | Single-team or multi-tenant? | **One team per deployment.** Many boards per team. DO keys keep a `<team>/` prefix so multi-tenancy stays possible later. | [08](spec/08-cloudflare.md#multi-board-and-teams) |
| <a id="q5"></a>Q5 | Wake Vercel deployments by path? | **No.** Wake by URL or service binding; `path` answers 501 `no_wake_by_path`. (Follows from Q12.) | [04](spec/04-watchers.md#wake-ups-without-vercel-δ) |
| <a id="q6"></a>Q6 | Which engine to match where `local()` and Vercel differ? | **`local()` semantics** (decimal IDs, 3600 s leases, text search) **with Vercel's durability** (schedules survive restarts, direct uploads). No `msg_` compatibility. (Follows from Q12.) | [02](spec/02-model.md) |
| <a id="q7"></a>Q7 | How do we handle upstream code that doesn't fit Workers? | **We cannot contribute upstream.** Use public seams, build-time aliases, re-hosted assets, and our own wrappers. `pnpm patch` only as a last resort, tracked in `PATCHES.md`. No hard fork. | [00](spec/00-overview.md#working-around-upstream) |
| <a id="q8"></a>Q8 | Sync if Chat SDK doesn't run on Workers? | **A Cloudflare Container** running upstream sync as "sync elsewhere". | [06](spec/06-sync.md#runtime-compatibility-verify) |
| <a id="q10"></a>Q10 | Naming and license | **Apache-2.0.** Docs state factual compatibility: "compatible with vercel/board". | [README](README.md) |
| <a id="q11"></a>Q11 | How do we track upstream? | **An upgrade skill plus automation.** A scheduled agent watches npm releases, runs the skill, and opens a PR or an issue. A nightly conformance run against the newest kit backs it up. | [00](spec/00-overview.md#tracking-upstream) |
| <a id="q2a"></a>Q2a | Who is a member? | **Match Vercel.** Org members are people, and org owners are board owners. A team restriction and a viewer cap exist as options, both off by default. | [03](spec/03-identity-access.md#people) |
| <a id="q9"></a>Q9 | Retention and redaction | **Retention for inbox payloads, message copies, and deleted attachments (30 days each). Messages and the log are never pruned. Plus an admin redaction tool for leaked secrets.** | [02](spec/02-model.md#retention-δ-decided-q9) |
| <a id="q13"></a>Q13 | Our own CLI? | **Both.** `bdx` is bordeaux's CLI: it embeds upstream's commands through the public `createApp()` and adds login and admin commands. Upstream `vb` with `BOARD_URL` + `BOARD_TOKEN` stays fully supported. If embedding gets too complex or rigid, `bdx` becomes a standalone CLI ([fallback](spec/07-clients.md#fallback-a-standalone-bdx)). | [07](spec/07-clients.md#bdx) |
| <a id="q10b"></a>Q10b | npm scope | **`@dosu`.** One package, `@dosu/bordeaux` (bins `bdx` and `bordeaux`, subpaths `/app` and `/worker`), plus `@dosu/create-bordeaux` for `npm create @dosu/bordeaux`. | [07](spec/07-clients.md#packages) |
| <a id="q12"></a>Q12 | Who is the first user? | **Teams that never used Vercel's board.** So: no migration from Vercel, and onboarding (`npm create @dosu/bordeaux`, GitHub App guide, skill) comes first. | [07](spec/07-clients.md) |

### How each upstream mismatch is handled under Q7

| Problem in `@vercel/board` 0.56.1 | Workaround | Kind |
| --- | --- | --- |
| `sync-slack`, `sync-github`, and `sync-linear` import `@vercel/connect/chat` at load time | Alias it to a bordeaux stub in the Worker bundle | build-time alias |
| The inspector's handler reads `app.js` with `node:fs` | bordeaux's own handler serves upstream's prebuilt `app.js` from Static Assets | re-hosted asset + own code |
| `createApp`'s `login`/`token` options mint through Vercel, and with no URL it goes to Vercel's API | `bdx` sets `BOARD_URL` and a fresh `BOARD_TOKEN` in-process and passes neither option | public seam + own code |
| Upstream `list`, `--name`, `--scope`, `--ensure` ask Vercel's API | `bdx` handles them itself against the DirectoryDO | own code |
| `createApp` leaves out `inspect` | `bdx inspect` runs the bundled upstream `vb inspect --url` | own wrapper |
| No `http()` backend outside Node; `http()` never registers watchers | `@dosu/bordeaux/app` implements `Backend` | public seam |
| `waitUntil` looks for Vercel's request context | Install `globalThis[Symbol.for('@vercel/request-context')]` per request | public-ish seam (global symbol) |
| Discovery reads `x-vercel-oidc-token` and Vercel env vars | bordeaux sets `url` and `project`, and never sends those headers | public seam |

Three of these depend on upstream details that aren't public API: the alias target's export
names, the request-context symbol, and when the CLI re-reads `BOARD_TOKEN`. The upgrade skill must re-check both on every upstream
release.

## Open questions

None right now.
