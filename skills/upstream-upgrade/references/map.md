# Where upstream lands in bordeaux

For each part of vercel/board (`packages/board/` unless it says otherwise) that bordeaux
vendors, ports, or relies on: how bordeaux uses it, the code a change there touches, and the
spec section that describes it. Paths on the right are under `packages/bordeaux/` unless they
start at the repo root. When an upgrade moves something, update this page too.

## How bordeaux uses each part

- **vendored:** copied byte for byte into `src/upstream/` by `pnpm vendor`. Review the diff;
  fix what it breaks around it.
- **shimmed:** bordeaux's own stand-in in `src/upstream/`, marked `// SHIM (bordeaux)`. Update
  it by hand.
- **ported:** reimplemented in bordeaux, each function naming its upstream original. Bring
  each change over.
- **run:** bordeaux calls it from `@vercel/board` at run time. A change arrives with the
  version bump; check what bordeaux assumes about it.
- **relied on:** an internal detail a workaround depends on. Re-check it by hand.

## The protocol

| Upstream | How | bordeaux | Spec |
| --- | --- | --- | --- |
| `src/api/routes.ts` | vendored, run | `src/upstream/api/routes.ts`; `board()` routes and validates with it | [01](../../../spec/01-protocol.md) route inventory |
| `src/api/protocol.ts` | vendored | `src/worker/backend.ts` `METHODS`; the DO's handlers in `src/engine/do.ts`, `engine.ts` | [01](../../../spec/01-protocol.md), [08](../../../spec/08-cloudflare.md#the-durable-backend) |
| `src/server/backend.ts` | shimmed (types) | `src/upstream/server/backend.ts`; `durable()` in `src/worker/backend.ts`; `@dosu/bordeaux/app` in `src/app/index.ts` | [08](../../../spec/08-cloudflare.md#the-durable-backend), [07](../../../spec/07-clients.md#dosubordeauxapp) |
| `docs/04-reference/03-http.md` | read | the semantics spec/01 follows where routes.ts is silent | [01](../../../spec/01-protocol.md) |
| `src/server/board.ts` and the rest of `board()` | run | `src/worker/index.ts` mounts it per board; the DO builds one for its own work | [08](../../../spec/08-cloudflare.md#topology) |
| `src/conformance/` | run | `scripts/conformance.mjs`, `.github/workflows/ci.yml` | [01](../../../spec/01-protocol.md#conformance), [08](../../../spec/08-cloudflare.md#testing) |

## The data model and reads

| Upstream | How | bordeaux | Spec |
| --- | --- | --- | --- |
| `src/contract/*` (see `FILES`) | vendored | `src/upstream/contract/`; the DO appends these events and builds its tables with these folds | [02](../../../spec/02-model.md) |
| `src/contract/reducers.ts` | shimmed | `src/upstream/contract/reducers.ts`: bordeaux keeps these views in tables | [02](../../../spec/02-model.md#reads) |
| `src/store/sql.ts`, `project.ts`, `types.ts` | vendored | the DO's tables, over `src/engine/db.ts` | [08](../../../spec/08-cloudflare.md#sqlite-schema-per-boarddo) |
| `src/server/feed.ts`, `carried.ts`, `actors.ts` | vendored | the DO's reads (`src/engine/feed-page.ts`, `engine.ts`); the TailDO's feed (`src/engine/tail.ts`) | [08](../../../spec/08-cloudflare.md#long-polls-sse-and-waiters) |
| `src/server/a2.ts`, `reads.ts` | shimmed (shapes the feed uses) | `src/upstream/server/a2.ts`, `reads.ts` | |

## The engine's ports

| Upstream | How | bordeaux | Spec |
| --- | --- | --- | --- |
| `src/server/a2.ts` | ported | `src/engine/engine.ts`, `identity.ts`, `tail.ts` | [02](../../../spec/02-model.md), [08](../../../spec/08-cloudflare.md) |
| `src/server/writes.ts` | ported | `src/engine/engine.ts`, `writes.ts`, `identity.ts`; `src/worker/trust.ts` | [02](../../../spec/02-model.md#multi-event-appends-that-must-stay-atomic) |
| `src/server/schedules.ts` | ported | `src/engine/engine.ts`, `do.ts`, `schedules.ts` | [05](../../../spec/05-schedules-tasks.md#schedules) |
| `src/server/watch.ts` | ported | `src/engine/watchers.ts`; `src/app/index.ts` | [04](../../../spec/04-watchers.md) |
| `src/server/trust.ts` | ported | `src/worker/trust.ts` | [03](../../../spec/03-identity-access.md#the-verifier-chain) |
| `src/server/access.ts`, `grants.ts`, `auth.ts` | vendored, ported (`authorize`) | `src/upstream/server/`; `src/engine/access.ts`, `engine.ts` | [03](../../../spec/03-identity-access.md#grants) |

`grep -rn -E "upstream [a-z0-9/-]+\.ts" src` lists every port by function.

## Clients

| Upstream | How | bordeaux | Spec |
| --- | --- | --- | --- |
| `src/cli/embedded.ts` (`createApp`) | run, relied on | `src/cli/bdx.ts` | [07](../../../spec/07-clients.md#how-it-runs-a-command) |
| `src/client/node.ts` (`connect()`, `BOARD_TOKEN`) | relied on | `src/cli/bdx.ts` `EARLY_MS` and its 60 s refresh | [07](../../../spec/07-clients.md#how-it-runs-a-command) |
| `src/cli/commands.ts` | shimmed (re-export) | `src/upstream/cli/commands.ts`; the flags `bdx` intercepts | [07](../../../spec/07-clients.md#commands-bordeaux-adds) |
| `src/api/protocol.ts`, `src/client/client.ts`, `sse.ts`, `src/server/backend-http.ts`, `registrant.ts`, `routing.ts`, `sandbox.ts`, `tails.ts`, `watch-run.ts`, `attempts.ts` | vendored | `@dosu/bordeaux/app` (`src/app/index.ts`) | [07](../../../spec/07-clients.md#dosubordeauxapp) |
| `src/server/wait-until.ts` | vendored, relied on | `src/worker/index.ts` installs `Symbol.for('@vercel/request-context')` | [00](../../../spec/00-overview.md#working-around-upstream) |
| `src/version.ts` | shimmed | `src/upstream/version.ts` `VERSION` | |

## The inspector

| Upstream | How | bordeaux | Spec |
| --- | --- | --- | --- |
| `dist/inspect/` (built from `src/inspect/app/`) | run (re-hosted asset) | `wrangler.jsonc` `assets`; served by `src/worker/inspect.ts` | [07](../../../spec/07-clients.md#inspector) |
| `src/inspect/shell.ts`, `style.ts` | vendored | `src/worker/inspect.ts` | [07](../../../spec/07-clients.md#inspector) |
| `src/inspect/handler.ts`, `page.ts`, `server.ts` | read | what the page calls; the proxy in `src/worker/inspect.ts` allows only the board's API | [07](../../../spec/07-clients.md#inspector) |

## Sync

| Upstream | How | bordeaux | Spec |
| --- | --- | --- | --- |
| `src/sync/slack.ts`, `github.ts`, `linear.ts` | run, relied on (`@vercel/connect/chat` imports) | the alias to `src/sync/connect-chat.ts`; `@dosu/bordeaux/sync` (`src/sync/index.ts`) | [06](../../../spec/06-sync.md) |
| `test/sync-fixtures.ts` | adapted | `test/sync-fixtures.ts` (its header names the commit) | [06](../../../spec/06-sync.md) |

## Outside the package

| Upstream | How | bordeaux | Spec |
| --- | --- | --- | --- |
| `skills/board/` (repo root) | adapted | `skills/board/` at the repo root (each file's header names the commit) | [07](../../../spec/07-clients.md#skill-and-templates) |
| `packages/board/CHANGELOG.md` | read | what each release says changed; the pull request's list starts here | |
