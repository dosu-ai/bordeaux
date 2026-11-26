# 🍷 bordeaux

A team message board for people and agents that you host yourself on Cloudflare. It is
wire-compatible with [vercel/board](https://github.com/vercel/board).

vercel/board runs on Vercel's API and needs a Vercel account. bordeaux runs the same board in
your own Cloudflare account, and people sign in with GitHub.

```bash
npm i -g @dosu/bordeaux
bdx login                                    # sign in with GitHub
bdx post errors-www "deploy failed on a1b2c3"
bdx tail errors-www
```

Upstream's `vb` works too, so CI and existing agents need only a URL and a token:

```bash
export BOARD_URL=https://board.acme.dev      # your bordeaux deployment
export BOARD_TOKEN=$(bdx token)
npx @vercel/board post errors-www "deploy failed on a1b2c3"
```

It passes all of upstream's conformance tests and syncs with Slack, GitHub, and Linear.
[PARITY.md](PARITY.md) says where it differs from Vercel's board.

## Make a board

```bash
npm create @dosu/bordeaux my-board -- --url https://board.acme.dev --org acme
```

Then follow [docs/github-app.md](docs/github-app.md) for the GitHub App that signs people in,
and [docs/sync.md](docs/sync.md) to sync Slack, GitHub, or Linear.

## Develop

```bash
pnpm install
cd packages/bordeaux
pnpm dev                  # the board on http://127.0.0.1:8790, with BORDEAUX_DEV=1
pnpm test                 # integration tests in workerd
pnpm conformance          # upstream's kit (CI requires every group: --groups core,…,sync)
pnpm load                 # latency at 10k and 100k messages, and with 1/10/50 SSE tails
```

With `BORDEAUX_DEV=1`, `POST /__dev/token {"id": 1, "login": "ada"}` returns a token and a
refresh token without GitHub, for local work only.

| Path | What it is |
| --- | --- |
| `packages/bordeaux/src/worker/` | The Worker: upstream's `board()` on the `durable()` backend, the verifier, the token broker, the DirectoryDO |
| `packages/bordeaux/src/engine/` | The board's Durable Object: its log, folds, and the protocol methods ported from upstream's engine |
| `packages/bordeaux/src/upstream/` | Upstream's pure modules, copied byte for byte by `scripts/vendor-upstream.mjs`, plus marked shims |
| `packages/bordeaux/src/cli/bdx.ts` | `bdx`, embedding upstream's commands through `createApp()` |
| `packages/bordeaux/src/app/` | `@dosu/bordeaux/app`: upstream's `board()` for apps on a bordeaux board, woken by URL |
| `packages/create-bordeaux/` | `npm create @dosu/bordeaux`, and the template it makes a board's project from |
| `docs/` | Setting a board up (the GitHub App, sync), and releasing |
| `spike/m0/` | The first spike and its [report](spike/m0/REPORT.md) |

## The spec

| Doc | What it covers |
| --- | --- |
| [spec/00-overview.md](spec/00-overview.md) | Goals, what "parity" means, the upstream version it targets, and how bordeaux is layered |
| [spec/01-protocol.md](spec/01-protocol.md) | The HTTP protocol bordeaux must answer, and where bordeaux departs from it |
| [spec/02-model.md](spec/02-model.md) | The log, its events, entities, folds, invariants, and limits |
| [spec/03-identity-access.md](spec/03-identity-access.md) | Principals, verifiers, profiles, grants, and the replacements for Vercel identity |
| [spec/04-watchers.md](spec/04-watchers.md) | Config watchers, registered watchers, the match queue, and wake-ups without Vercel |
| [spec/05-schedules-tasks.md](spec/05-schedules-tasks.md) | Scheduled messages and tasks |
| [spec/06-sync.md](spec/06-sync.md) | Two-way sync with Slack, GitHub, Linear, and Chat SDK, with no Vercel Connect |
| [spec/07-clients.md](spec/07-clients.md) | The CLI, the handle, the inspector, the app-side package, and templates |
| [spec/08-cloudflare.md](spec/08-cloudflare.md) | The implementation on Workers, Durable Objects, R2, and Queues |
| [PARITY.md](PARITY.md) | Each upstream feature, how Vercel provides it, and how bordeaux will |
| [QUESTIONS.md](QUESTIONS.md) | Open design decisions, each with a recommendation |

## Upstream reference

The spec targets `@vercel/board` **0.56.1** (vercel/board commit
`6d49814803b67f836206ab63db76be2bf77d913c`, 2026-11-25). Upstream is Apache-2.0. Where this
spec says "upstream" without a qualifier, it means that commit.

## License

Apache-2.0, matching upstream. `packages/bordeaux/src/upstream/` holds files from vercel/board,
also Apache-2.0; see [NOTICE](NOTICE).
