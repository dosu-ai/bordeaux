# 08 · Implementation on Cloudflare

How bordeaux meets specs 01–07 on Workers, Durable Objects, R2, and Queues. Platform limits
marked **(verify)** must be confirmed against current Cloudflare docs before we rely on them.

## Topology

| Component | Count | Owns |
| --- | --- | --- |
| **Worker** `bordeaux` | stateless | upstream `board()` (default build) with `backend: durable(env)`, `authenticate: chain(...)`, `url`, `middleware`, `watch`, `sync`. Also the token broker routes, the hosted inspector, the internal `/__bordeaux/*` entrypoints, and the Queue consumer. |
| **BoardDO** | one per board (`idFromName("<team>/<board>")`) | the log, the tables, grants, schemas, schedules, tasks, the registry, match and inbox queues, timers, dead letters, and in-memory waiters |
| **DirectoryDO** | one per team | board names and IDs (`boards?name=`, `ensure`, `board_name_taken`), issuer signing keys, the `jti` deny-list, device-flow sessions |
| **R2** `bordeaux-files` | one bucket | attachment bytes at `<boardId>/<attachmentId>` |
| **Queue** `bordeaux-wake` | one | outbound wake-ups and their retries |
| **Static Assets** | — | the inspector's `app.js` |

**One BoardDO per board** follows from upstream's choice of one log per board: one global
order, atomic batches, and checks against the head. The DO's single-threaded execution and
transactional SQLite (`ctx.storage.sql` with `transactionSync`) give us those guarantees
directly.

## The `durable()` backend

`durable(env)` implements upstream's `Backend` interface (`src/server/backend.ts`):

- `keeps: true`, `sendsSchedulesHere: true`, and `trust.grants()` reads the access fold.
- Each protocol method makes one RPC to the BoardDO. The RPC carries `caller`, the parsed
  `input`, and the abort signal. The caller is a plain, serialized object: identity, the
  principal's compiled access summary, and origin.
  - The DO trusts the caller as given. Only the Worker can reach the DO, because the namespace
    is not exposed.
  - The DO still enforces permissions using the caller's access. Upstream's write functions
    re-check the proof's channel, and bordeaux ports that check.
- `bind(binding)` stores the binding so background work can reach the policy:
  `subscriptions` (config watcher tails and `@sync`), `run`, `receive`, `accessNow`, `handle`,
  `readSource`, `typing`, and `url`.
  - The DO runs in a different isolate, so it can't call these functions directly. It calls
    back into the Worker instead (see below).
- **Implementation strategy (as built in M1).** Two kinds of upstream code, treated
  differently:
  - **Copied byte for byte** into `packages/bordeaux/src/upstream/` by
    `scripts/vendor-upstream.mjs`, which lists them: the pure data model (`contract/*`: events,
    folds, mentions, blocks, schemas), the tables (`store/sql.ts`, `project.ts`, `types.ts`),
    the views and feed (`server/feed.ts`, `carried.ts`, `actors.ts`), and `client/ids.ts`.
    They depend on nothing of A2 or Vercel at runtime. The few modules they import that aren't
    copied are bordeaux shims marked `SHIM`, which re-export upstream's public API wherever it
    has the same thing (`@vercel/board`, `@vercel/board/access`).
  - **Ported by hand** into `src/engine/engine.ts`: the protocol methods from `a2.ts` and the
    write rules from `writes.ts`, which are written against A2's sessions. Each function names
    its upstream original. `tasks.ts`, `schedules.ts`, `registered.ts`, and `trust.ts` follow
    in M2.
  - Upstream's `Db` interface maps onto `ctx.storage.sql` plus `transactionSync`
    (`src/engine/db.ts`), so the tables run unchanged.
  - [QUESTIONS Q1](../QUESTIONS.md#q1) records why bordeaux doesn't run upstream's A2 engine.

### SQLite schema (per BoardDO)

| Table | Purpose |
| --- | --- |
| `bx_log(session, idx, id, type, payload JSON, created_at)` | the append-only log. PK `(session, idx)`, UNIQUE `id`. Payloads are checked against upstream's event schemas as they're appended. |
| `board_messages`, `board_versions`, `board_terms`, `board_sync_threads`, `board_external_threads`, `board_copies`, `board_external_messages` | upstream's tables from `store/sql.ts` `ddl()`, unchanged |
| `bx_channels`, `bx_actors` | folded state that upstream keeps as A2 reducers, written in the log's transaction. A post's client ID is `board_messages.event_id`. |
| `access_state`, `schemas`, `schedules`, `registry` | small folded side states, stored as JSON rows |
| `tasks_needs(need, task)` | **Δ** dependents index |
| `queue(queue, thread, match_id, attempts, lease_id, lease_until, retry_at, payload)` | watcher, `@sync`, and `@inbox:*` queues |
| `inbox(key, channel, id, received_at, event, raw)` | raw platform events, with retention |
| `timers(id PK, due_at, kind, payload)` | every pending timer. The alarm is set to `min(due_at)`. |
| `consumer_positions(consumer, lane, idx)` | consumer cursors per lane |
| `dead_letters(consumer, lane, idx, error, at)` | |

**Write path (as built in M1).** Every write runs in one critical section of the DO
(`exclusive`), with no I/O in between:

1. Read the board and check the conditions (`after`, `if`, `revision`, a retried client ID).
2. Decide whether `actor.seen` is needed.
3. Append the events and fold who's who and the channels, in one `transactionSync`.
4. Apply the events to upstream's tables, which advance their own `board-tables` position.
5. Wake the feed's waiters.

The DO is the log's only writer, so steps 1–3 are a conditional append that never has to retry,
where upstream's A2 uses `ifLastIndex` and tries up to 10 times. Upstream's table code is async,
so step 4 can't share step 3's transaction. A DO that stops between them catches the tables up
from the log when it starts again, before it takes a request.

**Δ** Applying each write to the tables before it answers gives read-your-writes for every read.
It replaces upstream's lag of up to 10 seconds.

### Consumers and the Worker

Consumer work runs in the DO, triggered by an alarm or by `ctx.waitUntil` after a commit. It
reads from `consumer_positions` and processes each lane in order:

| Consumer | Where the work happens |
| --- | --- |
| `board-watchers` (matching) | **In the DO.** It evaluates tails against the event before and after it changed, then appends `watch.matched` to the queues. Access for registered watchers is the stored principal's compiled access, refreshed whenever grants change (the access fold is local to the DO). |
| `board-watch` (config watcher `run`) | **As built (M3): in the DO.** Config watchers and the board's own sync queue under one registrant, `@board`, beside registered ones (`bx_queues`). A write that matches arms a `run` timer; the DO's alarm leases from `@board` and runs each item through the board's own `board()` built in the DO (`binding.run`), then acks. No self service binding: the same pattern as schedule sends. Each run gets a minute; a failure is retried with backoff, up to 10 tries. |
| `board-sync` (outbound) and `board-inbox` (inbound) | **As built (M3): in the DO**, by the same path. `@sync` matches for the board's own sync, and its platform events (`inboxPush` from the webhook route, queued as `@inbox:<key>`), run through `binding.run` and `binding.receive`; writes come back to the DO over RPC (`syncImport`, `syncReceipt`). Sync elsewhere is unchanged: its registrant pulls and acks over HTTP. |
| `board-schedule-sends` | **As built (M2):** the DO keeps its timers in `bx_timers` and its alarm at the earliest. A due send builds the board's own `board()` in the DO (the same code the Worker runs, middleware included), asks its policy for the creator's access now (`binding.accessNow`), and posts through `binding.handle(creator)`; that post comes back into the same DO over RPC. No self service binding is needed. The send's derived ID makes a retry return the message already posted; a send that fails is tried again with backoff, up to 10 times. |
| `board-leases` | **In the DO**, on an alarm: writes `task.expired`. As built (M2): leases share `bx_timers` with schedule sends. `src/engine/tasks.ts` is upstream's tasks.ts line for line but for its lease timer and its conditional appends, which run in the DO's write lock (`src/engine/writes.ts`). |
| wake dispatch | The DO sends to Queue `bordeaux-wake` ([below](#wake-ups)) |

**The pull-and-ack contract.** The Worker uses the same contract as every external registrant.
That gives the Worker's own code upstream's lease, retry, and order semantics, and keeps the
DO from ever calling out to user code. The internal entrypoints sit on a named
`WorkerEntrypoint`, so the public internet can't reach them.

**`waitUntil`.** Upstream's `wait-until.ts` looks for `globalThis[Symbol.for('@vercel/request-context')]`.
The bordeaux Worker installs one per request. It is backed by `AsyncLocalStorage`, so
concurrent requests in one isolate each reach their own `ctx.waitUntil`. M0 confirmed it works,
and that without it upstream drops background work when the response returns.

**`url` is required.** The Worker always passes `board({ url })` from config. Without it,
`board()` takes its URL from the request's host, and over a service binding that is
`http://board`, which then becomes discovery's `audience` (M0).

### Long-polls, SSE, and waiters

The routes that wait are `/events?wait≤300`, `/tasks/claim?wait≤300`,
`/watchers/matches?wait≤25`, and SSE pages.

- The DO keeps waiter lists keyed by what they wait on: the feed (with the filter's channels),
  ready tasks per channel, and a registrant's queue.
- An append resolves the matching waiters, and they re-run their read. Nothing polls.
- A held RPC keeps the DO resident and billed **(verify: duration billing)**.

For v1, waiters stay in the DO. It is simple, and boards are team-sized. For **v1.1**, a
`TailDO` fan-out layer (built in M4 after all, below):

- SSE clients connect through the Worker to a per-board TailDO over a **hibernatable
  WebSocket**.
- The TailDO follows the BoardDO's feed once and evaluates each subscriber's filter.
- Idle tails then cost nothing, and the BoardDO serves one follower instead of N.
- Upstream's own open benchmark (1, 10, and 50 concurrent tails) is our trigger: build the
  TailDO when 50 tails add more than 5 ms p99 to the write path.

**As built (M4): the TailDO is in 1.0.** On a deployed board, 50 tails added 42–49 ms to a
post's p99 without it, past the trigger, and nothing measurable with it (see "Load, as
measured").
- Every `events` call that waits (`wait > 0`: SSE pages after the first, `vb wait`) goes to
  the board's TailDO (`TAIL`, `src/engine/tail.ts`); a page that doesn't wait, and `last`,
  stay on the board's DO. Without the binding, the board's DO holds them as before.
- The TailDO follows the board with one long-poll (`tailFollow`), keeping the newest 2,000
  events and who's who as of them. Each reader's page is upstream's `pollFeed` with no wait,
  run in the TailDO; what only the board has (messages at an index, older events) it reads
  once for every reader that asks the same, and keeps, since it never changes. It stops
  following a minute after its last reader.
- A reader's first page comes from the board, so its cursor can be ahead of the TailDO: it
  waits up to 2 seconds for the follower, then reads the board itself.
- **Δ from this sketch:** no WebSockets. `board()` drives SSE in the Worker a page at a time
  through the backend's `events`, so the TailDO answers those pages over RPC and is billed
  while they wait, as the board's DO was.
- Each request still reads the grants from the board's DO (`accessState`) before `board()`
  decides access, one small RPC per SSE page. Caching them in the Worker would let a revoked
  grant work a moment longer, so they aren't.
- A reload (see "Deploys") reaches the TailDO too: a newer version's call, or the board it
  follows answering from a newer version, resets it.

**SSE length.** The Worker drives the stream: `board()` loops `events` pages. `streamMaxMs` is
15 minutes. Clients reconnect with `after` either way. Workers have no wall-clock limit while
the client stays connected, and CPU time counts only active work, resetting on each request (confirmed in [M0](../spike/m0/REPORT.md)).


**As built (M3, live).** A deploy doesn't reach a board's Durable Object while a long-poll or
SSE request is open on it: the instance keeps its old code, and its old secrets, until it's
idle. With the inspector open, a board ran the previous version for minutes after a deploy,
and switched 12 s after the inspector closed. Since the inspector re-polls continuously, an
open inspector can hold a board on old code indefinitely. Not yet handled: the fix is to end
open waits when the Worker's version changes (M4).
## Wake-ups

- **Coalescing.** On a new `watch.matched` for a registrant that has a `url` or `binding` and
  no wake in flight, the DO sends `{ boardId, principal, hash }` to the `bordeaux-wake` Queue.
- **Delivery.** The consumer looks up the registration and POSTs `<url>/wake`, or calls
  `binding.wake()`. The request carries `x-board-watchers` and `x-bordeaux-wake`. A 2xx or 202
  is delivered.
- **Retries.** A failure retries through the Queue with a delay of 60 s, doubling to 3600 s.
  The Queue's own retry limit is disabled. The DO records reachability in the registration
  row.
- **Safety.** A wake carries no event and no credential, so redelivering one is harmless.

## Files

- **Small uploads.** `upload` (up to 4 MB) stores the bytes in R2 at
  `boards/<board DO id>/attachments/<id>`. The DO keeps each file's record in `bx_files`:
  name, type, size, and uploader, which with the messages that carry it decides who may read
  it.
- **Direct uploads (Δ, as built in M2).** `uploadStart` (up to 100 MB) returns a URL on the
  board itself, `<board>/__bordeaux/uploads/<id>?t=<secret>`, instead of an R2 presigned URL.
  The Worker streams the `PUT` body into R2 through its binding, taking exactly the
  `Content-Length` the start named, once. That needs no R2 API keys and works the same on a
  local board. `uploadFinish` HEADs the object, checks the size, and marks it stored. Before
  the bytes exist it answers 409 `not_uploaded`. Like upstream's `local()`, the optional
  `sha256` isn't checked (M0).
- **Downloads.** `attachment` is authorized in the DO, which streams the R2 object back to
  board() over RPC.
- **Deletes.** Deleting a message hides its files. The bytes are deleted only by
  `bx gc`, which removes unreferenced attachments that are more than 30 days old. This is
  **Δ**: upstream never deletes bytes. **As built (M4):** see
  [02](02-model.md#retention-δ-decided-q9); the Worker's cron runs it daily.

## Multi-board and teams

- **Default board.** The DirectoryDO maps names to board IDs. A missing default board is
  created on first use, as on Vercel.
- **Named boards.** `board({ name })` and `bx boards create` add more boards.
- **Routing.** The URL path selects the board: `https://board.acme.dev/` is the default board,
  and `https://board.acme.dev/b/<name>/` is a named one.
  - Each board's discovery `url` and `audience` is its own URL. A token for one board can't be
    replayed against another. `POST /auth/token` takes an `audience` (one of the team's boards)
    and `bx` keeps an access token per board; `/admin/tokens` takes the `board` a service's
    token is for.
  - The DirectoryDO keeps the board names (`bx boards create`, `bx list`). Anyone the default
    board lets in makes one, as `ensure` does on Vercel; deleting one takes `manage` at `*` and
    leaves its Durable Object's data in place. Another isolate can serve a deleted board for up
    to 5 minutes.
  - Grants are per board, as upstream has them.
- **Teams.** v1 is single-team per deployment. The DO key prefix `<team>/` leaves room for a
  hosted multi-tenant mode later ([QUESTIONS Q4](../QUESTIONS.md#q4)).

## Limits and capacity (verify all)

| Concern | Expectation | Mitigation |
| --- | --- | --- |
| DO SQLite size | about 10 GB per object | `board_versions` keeps a full copy per change. Compact versions below the slowest consumer position, keeping the latest plus any still needed for before-state matching. Cap the inbox raw payloads. `bx export` lets you archive. |
| DO throughput | roughly 500–1,000 writes/s for small transactions | far above a team board's needs. A 100-task batch is one transaction. |
| Alarms | one per object | multiplexed through the `timers` table |
| Queue delays | up to 12 h per message | waits longer than 1 hour don't occur (the wake backoff caps at 1 h). Schedules use alarms, not Queues. |
| RPC payload | 32 MiB | uploads go Worker → R2 directly, never through the DO |
| Cold start | the DO loads SQLite lazily | channel and actor folds are cached in memory after first use |

## Deploys

A board's Durable Object keeps the code and env it started with while it's in use. A board a
client long-polls (an open inspector, `vb tail`) is never idle, so in the live run of
2026-11-25 a deploy, and a fixed secret, didn't reach it until the inspector closed.

**As built:** each protocol call carries the calling Worker's version (`version_metadata`).
When one is newer than the DO's own, the DO answers its waiting long-polls (`/events?wait=`)
at once and stops new ones from waiting, then resets itself (`ctx.abort()`) once no call or
alarm is running there, after the last answer has gone; its next request loads the new
version, and long-polling clients poll again as they always do. It resets at most once per newer version (`bx_state` `reloaded-for`), so a DO that
a gradual deployment keeps on the old version doesn't reset over and over. Every RPC to the
DO counts as running, and it waits for storage to flush first: a DO holds an answer back
until what its call wrote is durable, and resetting before then fails the caller for a write
that may have landed. Requests queued at the DO when it resets fail with its reason; they
never started, so the Worker's stubs send them once more (`retried`). The load test's first
deploy of this found posts answering 500 mid-reset; `test/deploys.test.ts` covers it. A run of the
board's own code that outlasted its minute isn't waited for: it's cut short, and its item
runs again when its lease runs out. Without the binding, nothing changes. The first deploy
that adds it can't reload a busy board yet: the DO it would reach still runs the code from
before.

`GET /admin/health` answers the version the board's DO runs (`version`) and the Worker's that
answered (`worker`); `bx health` prints them as `code`. A health call carries no caller version,
so looking never reloads a board.

**Checked live (2026-11-25)** on the test deployment's default board: an SSE tail
(`curl -N /events?channel=reload-check`) held open, and posts with `bx post`.
- Version A deployed; `bx health` showed the board on A. A post reached the tail.
- Version B deployed with the tail still open. `bx health` showed the board still on A and the
  Worker on B.
- A post from B landed, and the board reloaded: the next `bx health` showed it on B.
- Two more posts, the second after 30 s (past the TailDO's 20 s follow), reached the same
  stream. The stream never closed and carried no error, and `bx health` showed no failures.
- Not seen directly: the TailDO's own reset. Nothing reports its version; the stream carrying
  posts after the board reloaded is all this showed.

## Observability

- Workers Logs with structured fields `{board, principal, route, code, ms}`.
- Workers Analytics Engine for request, consumer-lag, and queue-depth metrics.
- `GET /admin/health` (requires `manage` at `*`) reports consumer positions against the head,
  dead letters, the oldest pending timer, and the wake backlog.
  **As built:** `GET /admin/health[?board=<name>]` and `bx health` report each queue with work
  in it (pending, leased, and retrying items per registrant, the board's own as `@board`), the
  dead-letter count and the latest one, the latest failure, and the timers, with how many are
  more than a minute past due (the alarm isn't running them). Matching runs inside each write,
  so there's no consumer position to lag. For the default board it also readies each sync's
  provider, as upstream does on first use, and says whether it reached its platform. A cron
  (`triggers.crons`, every 15 minutes in the template) runs the same sync check and logs what
  failed. Readying is also what signs a new Linear app in, so its webhooks start without a
  first post from the board.

## Testing

| Layer | How |
| --- | --- |
| Unit | Upstream's pure modules (`access`, `schemas`, `folds`, and `tail`) are imported unchanged, and their tests are ported where they test pure behavior. |
| DO | `@cloudflare/vitest-pool-workers` runs the BoardDO under Miniflare, with alarms driven by fake time. |
| Conformance | `conformance(board({ backend: durable(env) }))` in-process on every commit, and `vb conformance --url <preview>` on every PR deploy. |
| Upstream drift | A nightly job runs the conformance kit from the newest `@vercel/board` against the latest preview. A failure opens an issue. |
| Load | Before 1.0: post p99 at 10k and 100k messages, and 1/10/50 SSE tails. This mirrors upstream's benchmark table. |

**Load, as measured (2026-11-25).** `pnpm load` (`scripts/load.mjs`) against a fresh local
`wrangler dev` board (workerd and its SQLite) on one Apple M2 Max, with the client on the same
machine. Every request goes through the Worker: auth, `board()`, RPC, and the DO. About 1 KB
messages across 10 channels, a root in every five; 200 samples each.

| Messages | Post p50 / p99 | Thread read p50 / p99 | Channel's threads p50 / p99 |
| --- | --- | --- | --- |
| 10,000 | 3.9 / 10.4 ms | 2.7 / 12.0 ms | 2.9 / 9.3 ms |
| 100,000 | 3.6 / 12.3 ms | 2.8 / 17.7 ms | 3.0 / 19.0 ms |

| SSE tails (10,000 messages) | Post p50 / p99 | p99 added |
| --- | --- | --- |
| 0 | 4.0 / 16.8 ms | |
| 1 | 4.7 / 14.3 ms | none |
| 10 | 11.7 / 32.0 ms | 15 ms |
| 50 | 40.7 / 69.1 ms | 52 ms |

- Message count doesn't move a post or a read: the tables index what they read, as upstream's
  benchmark found for its own.
- **50 tails add about 52 ms to a post's p99, past the 5 ms that triggers the TailDO.** Each
  post wakes every tail's long-poll in the BoardDO, and each runs its feed read there.
- The first run, before the fix, found that a busy feed ran the DO out of workerd's 10,000
  active timers (`AbortSignal.timeout()` outlives its call) and every feed answered 500;
  `test/feed-load.test.ts` covers it.
- Not measured: tails on other machines, 100k messages with tails, and append throughput.

**On a deployed board, the same day.** `pnpm load --url` against the test deployment on
workers.dev, a named board of about 10,000 messages, from one laptop over the internet (about
120 ms there and back). 200 samples, then two repeats of 0 against 50 tails at 300.

| | Post p50 / p99 |
| --- | --- |
| 0 tails | 118–145 / 161–205 ms |
| 1 tail | 148 / 251 ms |
| 10 tails | 139 / 531 ms |
| 50 tails | 133–149 / 252–866 ms |

Thread reads and a channel's threads answered in 121–122 ms p50, 160–177 ms p99, so the board
itself adds little over the round trip. Those tails ran in the process that timed the posts,
and reading 50 streams held up the timing too: the p99s above overstate what tails cost.

**With and without the TailDO, the same day.** The same board and client, with the tails in a
process of their own (`scripts/tails.mjs`), and the same deployment with and without its
`TAIL` binding. Each run alternates 0 and 50 tails three times, 300 posts each.

| 50 SSE tails against none | Post p50 added | Post p99 added |
| --- | --- | --- |
| Without the TailDO | 14–18 ms | 42–49 ms |
| With the TailDO | 0–0.5 ms | −6 to 4 ms (the baselines vary by 12 ms) |

With the TailDO, 50 tails cost a post nothing that the network's noise doesn't hide. The
board's own time per request still wasn't measured: it has no server timing to read. Not
measured: more than 50 tails, tails from more than one machine, and 100k messages with tails.

## Milestones

| | Scope | Exit criterion |
| --- | --- | --- |
| **M0 spike** (done, [report](../spike/m0/REPORT.md)) | Upstream `board()` default build in workerd with a stub backend. Confirm the `nodejs_compat` needs, `ctx.props` on entrypoints, R2 presigned checksum, and whether Chat SDK runs on Workers. Run `bx` (embedded `createApp`) and upstream `vb` against it: `BOARD_URL`/`BOARD_TOKEN` pickup, token refresh during `tail`, and intercepting `list`/`--name`. | A spike report that answers every **(verify)** in this spec, and says whether `bx` stays embedded ([07](07-clients.md#fallback-a-standalone-bx)) |
| **M1 core** (done) | BoardDO log, tables, messages, labels, reactions, channels, actors, `/events` with SSE, the verifier chain, the token broker, and `bx` (login, token refresh, embedded commands) | conformance `core`, `paging`, and `search` pass |
| **M2 platform** (done) | grants, schemas, R2 files, schedules (alarms), tasks, registered watchers, wake-ups, `@dosu/bordeaux/app`, `npm create @dosu/bordeaux`, GitHub App setup guide, agent skill | all groups except `sync` pass. `bx export` and import work. |
| **M3 sync** (done: the live Slack round trip passed 2026-11-25, [docs/sync.md](../docs/sync.md#checking-a-live-round-trip-m3s-exit-check)) | Slack, GitHub, and Linear with secrets; inbox and outbound consumers; the hosted inspector | the `sync` group passes. A live Slack ↔ board round trip works. |
| **M4 1.0** | dead-letter UI and CLI, health, gc, load tests, full docs | the benchmarks are met |
