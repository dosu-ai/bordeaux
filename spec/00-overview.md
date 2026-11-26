# 00 · Overview

## Goals

1. **Wire parity.** A bordeaux board answers the whole board protocol of `@vercel/board`
   0.56.1. That covers every route, status, error code, header, and event shape. Unmodified
   upstream clients must work against it, both the `vb` CLI and `board()` with `BOARD_URL`.
2. **Behavioral parity.** It must pass `@vercel/board/conformance` in every group. Where
   upstream's two engines disagree, bordeaux matches `local()`: upstream calls it the
   reference engine and runs its own tests against it. Where `local()` is weaker than Vercel's
   hosted board, bordeaux matches Vercel's hosted behavior. Those cases are restarts, wake-ups,
   and direct uploads.
3. **Hosted-board parity without Vercel.** These are the things Vercel's API does for a team:
   - keeps many named boards per team
   - creates the default board on first use
   - verifies people and machines
   - wakes deployments whose watchers match
   - fires schedules durably
   - stores files

   bordeaux must do each of them using only Cloudflare and the OIDC issuers you choose.
4. **Sync on the server.** Vercel's hosted board does not run sync yet (`board({ sync })` on
   it throws). bordeaux runs sync on the board, as `local()` does. This goes past hosted
   parity.
5. **Self-hostable in minutes.** It is a Worker template plus `wrangler deploy`. It has one
   config file, which holds wiring as code: sync entries, watchers, middleware, and verifiers.
6. **Hosted for teams that don't deploy.** A GitHub org installs Dosu's App and gets a board
   at `<org>.board.dosu.ai`, from one shared Worker ([09](09-hosted.md)). It runs the same
   code as a self-hosted board, without a team's own config code.

## Non-goals

These follow upstream's non-goals for v1, plus bordeaux's own:

- Full-text search beyond what upstream does. Upstream does a case-insensitive substring
  match on `text`, and bordeaux does the same.
- Accounts, a login page, sessions, roles, or moderation. The identity provider is someone
  else.
- A hosted web UI of bordeaux's own. The upstream inspector is the UI (see
  [07](07-clients.md)).
- Forking or modifying upstream. bordeaux consumes `@vercel/board` exactly as published on
  npm and does not contribute upstream. Where upstream code doesn't fit Workers, bordeaux
  substitutes modules at build time or supplies its own code around upstream's (see
  [Working around upstream](#working-around-upstream)). It never edits upstream's files.
- Vercel-only surfaces with no meaning off Vercel: Deployment Protection bypass headers,
  `vercel link` discovery, `x-vercel-oidc-token`, and the `vercel-deployment@1` schema's
  semantics. The name `vercel-deployment@1` stays reserved because conformance lists the
  built-ins.

## What "parity" means, precisely

A feature is at parity when all of the following hold:

| Level | Test |
| --- | --- |
| **Wire** | Upstream's route table (`src/api/routes.ts`) validates every bordeaux response. The status codes and error codes match [01](01-protocol.md). |
| **Conformance** | `vb conformance --url <bordeaux>` reports no failures in `core`, `paging`, `search`, `schedules`, `tasks`, `grants`, `schemas`, `attachments`, `watchers`, and `sync`. A check counts as skipped only for the reasons upstream's own `vb serve` gets for skipping it (see [01 §Conformance](01-protocol.md#conformance)). |
| **Client** | The upstream `vb` CLI, `board()` over `http()`, and the inspector each run their documented flows against bordeaux. That excludes flows that create a Vercel project. |
| **Hosted** | Each hosted-board capability in [PARITY.md](PARITY.md) has a Cloudflare mechanism with the same observable behavior. |

## Layering

```
          upstream clients (unmodified)                   bordeaux app-side package
   bdx · vb · board() over http() · inspector page       @dosu/bordeaux/app: board() backend for
                    │  HTTPS, Bearer JWT                  Workers/Node apps, wake-ups, tokens
                    ▼                                                │
 ┌──────────────────────────── bordeaux Worker (stateless) ─────────┴─────────────┐
 │ upstream board() (default build): router, zod validation, policy, middleware, │
 │ mentions, blocks, SSE, sync adapters and webhooks                              │
 │ bordeaux: verifier chain (authenticate), token broker, wake dispatcher         │
 └────────────────────────────────────┬───────────────────────────────────────────┘
                                      │ Backend protocol over DO RPC
           ┌──────────────────────────┼───────────────────────────┐
           ▼                          ▼                           ▼
     BoardDO (one per board)   DirectoryDO (one per team)    R2 (attachments)
     SQLite: log, tables,      boards by name, ensure,        Queues (wake-ups,
     grants, schedules, tasks, signing keys                   sync deliveries)
     watcher queues; alarms
```

- **The protocol is the contract.** bordeaux's server is a `Backend` (upstream's documented
  extension point: "a backend of your own is the fourth kind, checked with
  `@vercel/board/conformance`"). It is mounted with upstream's `board()` in a Worker. The
  board itself lives in a Durable Object. [QUESTIONS.md Q1](../QUESTIONS.md#q1) weighs this
  choice against vendoring upstream's engine or a clean-room server.
- **One Durable Object per board.** Upstream is built on "a board is one log": one global
  order, atomic batches, and conditional appends against the head. A single-writer actor with
  transactional SQLite gives exactly those guarantees.
- **Wiring is code.** Sync entries, config watchers, middleware, and verifiers live in the
  operator's `bordeaux.config.ts`, which is deployed with the Worker. The log never stores
  them.

## Conventions in this spec

- **MUST**, **SHOULD**, and **MAY** are used as in RFC 2119.
- `upstream:path:line` points into vercel/board at the pinned commit, under
  `packages/board/` unless the path says otherwise.
- **Δ** marks a deliberate departure from upstream behavior.
- **⚠** marks a fact taken from upstream's code that its own docs contradict. The code wins.
- **(verify)** marks a Cloudflare platform limit to confirm before relying on it.

## Working around upstream

bordeaux cannot contribute to upstream, and it never edits upstream's files. These are the
tools it may use, in order of preference:

1. **Use a public seam.** For example: the `Backend` interface, `authenticate`, your own Chat
   SDK adapters, `BOARD_TOKEN`, and the `@request-context` `waitUntil` hook.
2. **Substitute a module at build time.** A wrangler/esbuild `alias` replaces a module that
   upstream imports with bordeaux's stub, for example `@vercel/connect/chat`. Upstream's files
   are untouched, and the alias is checked on every upgrade.
3. **Copy a pure upstream module, byte for byte.** Upstream's data model, tables, and feed are
   pure TypeScript with no A2 or Vercel at runtime. `scripts/vendor-upstream.mjs` copies the
   listed files into `src/upstream/` at the pinned commit; they're never edited by hand, and
   what they import that isn't copied is a marked shim. The upgrade reruns the script and
   reviews the diff.
4. **Re-host an upstream asset.** Ship upstream's prebuilt files, such as the inspector's
   `app.js`, from our own handler. That is allowed under Apache-2.0, with upstream's NOTICE.
5. **Write our own code around upstream's.** For example: the `bdx` CLI (around `createApp`), `@dosu/bordeaux/app`,
   and the hosted inspector handler.
6. **Last resort: an install-time patch** (`pnpm patch`). Each patch is listed in
   `PATCHES.md` with the reason it exists. The upgrade automation fails if a patch no longer
   applies.

A hard fork of `@vercel/board` is out of scope: we would own every upstream change from then
on. Our own CLI is not a fork; `bdx` embeds upstream's commands through the public
`createApp()` ([07](07-clients.md#bdx)).

## Tracking upstream

Upstream moves fast: 0.56.1, with daily changesets. bordeaux pins one upstream version per
release and keeps up through two pieces (decided, Q11):

- **An upgrade skill**, [`skills/upstream-upgrade`](../skills/upstream-upgrade/SKILL.md),
  that tells an agent how to move bordeaux to a new upstream version. It covers:
  - diffing `src/api/routes.ts`, `src/api/protocol.ts`, `src/server/backend.ts`,
    `src/contract/*`, and the conformance kit against the pinned version;
  - mapping each change to the spec section and backend code it affects;
  - rerunning `scripts/vendor-upstream.mjs` and reviewing what changed in the copied files and
    in the `a2.ts` and `writes.ts` functions `src/engine/engine.ts` ports;
  - re-checking every build-time alias and `PATCHES.md` entry, and the upstream internals
    `bdx` relies on (`createApp` options, when `BOARD_TOKEN` is re-read);
  - updating the spec's pinned version;
  - running conformance.
- **Automation** that watches npm for new `@vercel/board` releases. For each one it runs the
  skill in a scheduled agent, which opens a PR with the upgrade, or an issue explaining why
  the upgrade needs a person. A nightly run of the newest kit against the latest preview
  catches anything the diff missed.

  **As built:** a scheduled agent checks npm once a day and follows the skill. The nightly
  conformance run against the latest preview isn't built yet.
