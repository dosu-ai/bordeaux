# 06 · Sync

Sync keeps one board thread in step with threads on Slack, GitHub, Linear, or any platform
that has a Chat SDK adapter. Upstream implements it inside `board()`: providers, sync
functions, webhooks, and the inbound and outbound pipelines. It stores its records through
protocol routes that any backend answers.

bordeaux runs sync **on the board**, the same way `local()` does. Vercel's hosted board can't
yet do this.

## What is reused unchanged

These upstream pieces run as-is in the bordeaux Worker:

- **The sync model.** Entries are keyed by a name you pick. Each entry is one `SyncProvider`
  plus one sync function. Map keys are the platform's own identifiers: Slack channels, GitHub
  repos, Linear teams.
- **The helpers** `channels()`, `repos()`, `teams()`, `mirror()`, `into()`, and `render()`,
  with their defaults. GitHub defaults to `into`, because a GitHub repo may be public.
- **The seven rules.**
  1. A message is delivered to every synced external thread except the one it came from.
  2. Roots start platform threads only where the platform can start threads.
  3. Inbound events are kept only for threads that are synced or channels that are routed.
  4. A thread starts at most once.
  5. Attaching a channel target backfills it.
  6. The adapter decides how external threads are grouped.
  7. Replies go into the sub-thread they answer.

  Board labels never sync out.
- **The built-in providers.** Slack (custom author names and avatars, files, link snapshots,
  `readSource` and `joinSource`, typing), GitHub (PR and issue lifecycle as `state`, `review`,
  `head`, `ci.*`, `tag.*`, and `assignee.*` labels), Linear (issue state, priority, project,
  and comment sub-threads), and `chatSdk()` for any other adapter.
- **Receipts and failures.**
  - `message.synced`, `message.files_synced`, `message.sync_failed` (after 5 tries, starting at
    1 s and doubling), and `thread.synced{cause}`.
  - A failure shows up in `undelivered` on the message view.
  - A late delivery re-reads the message before sending, so it carries later edits and skips
    messages that were deleted.
- **Routes.** `POST /webhooks/:key` (no token; the adapter checks the platform's signature),
  `POST`/`GET /messages/:id/sync`, `GET /links`, `POST /messages/:id/typing`,
  `GET /sources/:key/read`, `POST /sources/:key/join`, and `GET /inbox/:key`.

## What bordeaux changes

### Credentials without Vercel Connect (Δ)

On Vercel, Connect holds the platform credentials. It hands out short-lived bot tokens and
verifies webhooks with Vercel OIDC. bordeaux instead passes upstream's providers **their own
Chat SDK adapters**, built from Worker secrets (Secrets Store bindings):

| Platform | Secrets | Webhook verification |
| --- | --- | --- |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | Slack signing secret |
| GitHub | `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET` | HMAC-SHA256. Installation tokens are minted in the Worker and cached for up to 55 minutes. |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` | Linear signature |

This path is upstream's own documented "without Connect" setup. It also brings back the full
GitHub event set, which Connect doesn't forward today.

**Packaging blocker.** Upstream's `sync-slack`, `sync-github`, and `sync-linear` modules
statically import `@vercel/connect/chat`, even when you pass your own adapter. bordeaux will
do one of the following:

- **(a)** Alias `@vercel/connect/chat` to a bordeaux stub at bundle time *(chosen)*. The
  stub's `connect*Adapter` functions throw "bordeaux uses your own adapter". They are never
  called, because bordeaux always passes its own adapter.
- **(b)** Fallback: install `@vercel/connect` as an inert dependency. Not needed: M0
  confirmed the alias works.

See [QUESTIONS Q7](../QUESTIONS.md#q7) and
[Working around upstream](00-overview.md#working-around-upstream).

### Where the pipelines run

| Stage | `local()` | bordeaux |
| --- | --- | --- |
| Webhook ingress | `board()` route | Worker: `board()` route, unchanged |
| Inbox storage | `inbox:<key>:<channel>` sessions in SQLite | BoardDO `inbox` table. Raw payloads are capped at 256 KB per event and kept for 30 days (**Δ** retention; upstream keeps them forever). |
| Inbound consumer (`board-inbox`), one lane per external thread | in process | The DO queues the item. The Worker runs the sync function, triggered by a wake over the self binding. Writes go back to the DO through `syncImport`. |
| Outbound consumer (`board-sync`), one lane per board thread | in process | The DO queues `@sync` matches. The Worker delivers them through the provider and records receipts through `syncReceipt`. |
| Retries | A2: 10 tries, then dead letter | The same counts. Backoff uses DO alarms and the dead-letter table ([02](02-model.md#the-log)). |

Both queues reuse the registered-watcher queue machinery (leases, acks, and per-thread order)
from [04](04-watchers.md#queue-semantics). The Worker is the queue's own registrant.

**As built (M3).**
- The pipelines run in the board's DO, not the Worker ([08](08-cloudflare.md#consumers-and-the-worker)).
- The inbox is queue `@inbox:<key>` in `bx_queues`, not a table of its own. A raw payload is
  kept with its item until it's handled; one over 256 KB of JSON is cut short as it's pushed,
  and a dead letter's goes after 30 days (spec 02, "Retention").
- Credentials: `@dosu/bordeaux/sync` builds each provider from Worker secrets (`slackSync`,
  `githubSync`, `linearSync`). `configure()` takes `(env) => config`, so a deployment's sync
  can read them. Setup: [docs/sync.md](../docs/sync.md).
- Linear also takes `LINEAR_API_KEY` in place of the client credentials.
- Tested end to end with Chat SDK's fake platform (`test/own-sync.test.ts`), and Slack's
  webhook verification with a real `slackSync` provider. A live round trip with a real Slack
  workspace passed on a deployed board (2026-11-25).
- **Gotcha (live).** Upstream caps the Slack client it builds for a Connect connector (3
  retries, 30 s per request) because the client's default, 10 retries over about 30 minutes
  with no timeout, outlives any function. An adapter you pass yourself gets no such cap, so
  `slackSync` sets the same one (`SLACK_CLIENT`). The live check's first two events, sent within two minutes of installing the app, never
  landed in time; a stalled Slack call under the uncapped default would explain it, but it
  wasn't caught in the act. Every later event (six of them, five before the cap) landed in
  under 2 s, routed by `#name` or by ID.
- **Inbox dedupe (Δ retention).** An inbox takes a platform event once by its derived ID,
  remembered per inbox (the board's own, or each registrant's, as upstream keeps them) in
  `bx_inbox_seen` for 30 days. Upstream keeps every ID in its inbox sessions
  forever. Before this, a repeat was dropped only while the first was still queued, and a
  Slack reaction resent 200 ms later landed twice. `bdx export` doesn't carry the table, so a
  board moved within a platform's retry window may take a resend again.
- GitHub and Linear ran live too: issues, a PR, comments both ways, a board root opening a
  Linear issue, and no echo of either app's own writes.
- **Gotcha (Linear).** Linear sends an app's webhooks only after the app's first token, so
  a new deployment hears nothing from Linear until the app signs in. The sync check
  (`bdx health`, and the Worker's cron) readies each provider, which fetches that token. Not
  checked live: the test app already had its first token when the check was built.
- **Failures and dead letters.** The board keeps its last 50 failures (`BoardDO.ownFailures()`):
  its own runs that threw, and events matching couldn't handle, which are passed so they
  never hold up the rest. What a queue gives up on (10 tries for the board's own runs, 5 for
  a registrant's, as upstream) is kept with its event in `bx_dead` (`deadLetters()`), and
  `replayDead(id)` puts it back on its queue. `bdx dead-letters` lists them and `--retry <id>`
  replays one; `bdx health` shows the count and the latest failure.
- **Slow runs.** A run of the board's own code that outlasts a minute keeps its lease while
  the runner moves on, and is acked when it settles: it's never run twice at once.
- **A sync whose secrets aren't set is left out**, with an error in the logs; the boards
  work without it.
- Upstream's intake drops an event whose channel the routing doesn't map, without a log
  line. `slackSync(…, { debug: true })` logs the adapter's side.
- **Gotcha.** A provider that can't reach its platform's API at startup can hold up the
  others in the same isolate, because board() starts every provider on the first webhook.

### Runtime compatibility

- The sync code needs `node:async_hooks` and `node:crypto`. Both work under the `nodejs_compat`
  flag.
- `chat` and `@chat-adapter/{slack,github,linear}` load on Workers and verify webhook
  signatures ([M0](../spike/m0/REPORT.md)). Full delivery round trips are still M3's to prove.
- **Fallback (decided, Q8; likely unneeded after M0):** run sync in a **Cloudflare Container**, which runs the full
  Node runtime. It runs upstream `board()` with the `@dosu/bordeaux/app` backend and the sync
  entries, and speaks to the board through the "sync elsewhere" routes (`/sync/*`,
  `/inbox/*`, and `@sync` registrations).
  - The Worker forwards `/webhooks/:key` to the Container.
  - Wakes reach the Container through its Durable Object binding.
  - The protocol was built so that sync can run off-board, so nothing in the BoardDO changes.
- Chat SDK's in-memory state is best-effort, which is why bordeaux's correctness comes from
  the log and not from the SDK.

### Waiting on tables

Upstream's webhook waits up to 2 seconds (`GATE_WAIT_MS`) for the board's tables to catch up.
bordeaux tables are never behind, so this wait never triggers.

## Sync elsewhere

Any deployment can run its own sync against a bordeaux board over HTTP. It registers sync
entries with `POST /watchers {sync: […]}`, pushes platform events with `inboxPush`, pulls them
with `inboxNext`/`inboxAck`, and writes with `syncImport`/`syncReceipt`. It acts as
`<principal>+<key>:user:<id>`.

bordeaux MUST support this flow, for two reasons: conformance's `sync` group exercises it, and
it is how an `@dosu/bordeaux/app` deployment keeps its own platform credentials.

## Out of scope for v1

- Linking a person's accounts across platforms. Upstream doesn't do this either.
- Creating channels, repositories, or issues on a platform. The one exception is opening a
  Linear issue from a board root, which upstream supports.
