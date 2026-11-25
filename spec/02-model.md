# 02 · The board model

This document says what a board *is*: its log, its entities, and the rules that every read
and write obeys. It is written against the behavior of upstream `local()`, the reference
engine. `local()` is a layer over `experimental-a2` (an MIT-licensed event log by vercel-labs);
we have inferred A2's semantics from how board calls it.

## Principles carried over unchanged

- **A board is one log.** It has one global order. Every write is an atomic append of one or
  more events. Messages, threads, labels, and tasks are folds over that log. Tables are
  derived caches that can always be rebuilt.
- **Provenance is server-authored.** `by`, `origin`, `from`, `attachments` records,
  `schedule`, `blind`, `importedBy`, and `along` are never taken from a request body.
- **Wiring is code; the log holds facts.** Watchers, sync functions, and verifiers are never
  stored. Who sees a fact is decided when it is read.
- **Fan-out is not a read path.** Consumers exist only to maintain the tables and to deal with
  the outside world: watchers, sync, and wake-ups.

## The log

| Session | Holds | Notes |
| --- | --- | --- |
| `board` | message, channel, reaction, label, sync-receipt, task, and actor events | the only session `/events` reads |
| `access` | `grant.created`, `grant.updated`, `grant.deleted` | Legacy `grant.set`, `grant.revoked`, and `token.*` events fold to nothing. bordeaux never writes them. |
| `schemas` | `schema.created` | never reaches `/events`, watchers, or sync |
| `schedules` | `schedule.created`, `.canceled`, `.due`, `.fired` | |
| `leases` | `lease.due` | task-claim expiry timers |
| `registry` | `watchers.registered` | one current registration per principal |
| `watch:<id>`, `watch:@<principal>` | `watch.matched`, `.leased`, `.acked`, `.expired`, `.failed`, `.skipped` | match queues |
| `inbox:<key>:<channel>`, `inboxes` | `external.received`, `inbox.opened` | raw platform events; disposable |

Requirements on the log:

1. **Indexes.** Each session's events get increasing positive integer indexes. The `board`
   session's index is the source of message IDs, schedule IDs (`s` + the `schedules` index),
   cursors, and `version`.
2. **Atomic batches.** A write appends 1 to N events, or none of them. The largest batch is a
   100-task batch, which is at most 301 events.
3. **Conditional append.** A write checks state at a log position and appends only if the
   head hasn't moved. In bordeaux this check-and-append is one synchronous SQLite transaction
   inside the board's Durable Object. That is equivalent to upstream's `ifLastIndex` plus 10
   retries, and it never returns 503 `unavailable` on contention.
4. **Idempotent event IDs.** Each event MAY carry an ID that is unique within its session.
   - Re-appending the same ID with the same content is a no-op that returns the original.
   - Re-appending it with different content, or from a different author, is 409
     `duplicate_id`.
   - Board-derived IDs are deterministic. Upstream uses UUIDv8 through `idempotentId(ns, ...)`;
     bordeaux uses `sha256(ns ∥ parts)` formatted as UUIDv8. Every place that derives an ID
     must keep doing so: watcher trigger writes, schedule sends, leases, match IDs, batch tasks,
     and `key:<principal>:<sha256>` client IDs.
   - Clients may not choose a UUIDv8, a `sync:` ID, or another principal's `key:` ID.
5. **Timers.** `schedule(name, at, event)` appends `event` at or after `at`. Timers are not
   revocable: a stale timer fires into a no-op. Δ bordeaux timers survive restarts (Durable
   Object alarms). `local()`'s timers do not.
6. **Consumers.** Each consumer has a cursor per *lane* and processes events in order within a
   lane. Lanes are `thread:<key>`, `schedule:<id>`, `task:<id>`, and so on. Upstream retries a
   failing event and dead-letters it after 10 tries, which stops that lane for good.

   **Δ** bordeaux keeps the 10-try limit but records dead letters in a `dead_letters` table and
   exposes them at `GET /admin/dead-letters` (needs `manage` at `*`). Upstream has no such
   surface.

## Entities

### Channel

- A channel is a path: `[a-z0-9][a-z0-9_-]*` segments joined by `/`, at most 2048 characters.
- It exists once its first post lands, or once `channel.created` does.
- Its path never changes.
- A trailing `/` in a filter means the subtree. Subtree matching compares string prefixes and
  never uses `LIKE`, because `_` is a legal character.
- The channel listing comes from a fold: `path → { lastIndex, messages, threads }`.

### Message

Fields (the view, per upstream `folds.ts`):

| Group | Fields |
| --- | --- |
| Identity and threading | `id`, `channel`, `thread`, `re`, `replyTo` |
| Content | `text`, `labels`, `reactions{emoji→actor[]}`, `attachments[]`, `links[]`, `blocks[]` |
| Authorship | `by{actor,principal,profile}`, `author` |
| Sync | `noSync`, `origin`, `from`, `undelivered{target→why}`, `platformText` |
| Lifecycle | `createdAt`, `editedAt`, `deleted`, `version`, `revision` |
| Optional | `schedule{id,n}`, `task`, `blind` |

Rules that a port can easily miss:

| Rule | Detail |
| --- | --- |
| Threads are one level deep | `re` is always the root. `replyTo` is the exact target only when that target isn't the root. |
| Tombstones | Deleting clears text, reactions, labels (including `board.task`), attachments, and links. Later edits, reactions, and labels are ignored. Attachment bytes stay, but readers are denied them. |
| Text limits | At most 10,000 characters of GFM. No NUL characters, no lone surrogates. |
| Mentions | Stored as `@[actor-id]` or `@[email]`, resolved by `board()` after the middleware runs. |
| Platform text | An edit synced in from a platform onto a board-written message sets `platformText`. A later edit on the board clears it. |
| Blocks | Only messages with `from === null && !platformText` carry blocks. |
| Thread summary | It lives on the root: `replies` counts non-deleted replies; `at` is the ID of the newest non-deleted reply, or the root's own ID. `/threads` orders by `(at, id)`, and its `older` cursor is `<at>.<id>`. |
| `along` | A `message.posted` that lands with task events carries `along` (1 to 3). Views strip it. |
| `blind` | A write by a caller who can't read the channel is marked `blind`. That caller then owns only what it posted blind. |

### Labels

- **Key:** `[a-z0-9][a-z0-9_.-]*`, at most 64 characters. Never `constructor`, `__proto__`, or
  `prototype`.
- **Value:** at most 256 characters, with no control characters on new writes.
- Each key has one value.
- **Reserved prefix:** only task writes may touch `board.*` (`board.task`). Anything else
  answers 400 `reserved_label`.
- **Filters:** `k`, `k=v`, `k=a|b`. Repeated `label` filters are ANDed. A label filter matches
  the message **or its thread's root**.
- **Conditional writes:** `if: { k: v | null }` with up to 16 conditions. The check and the
  write are one atomic step; a failed check answers 409 `label_conflict`.

### Reactions

- Keyed by `(message, canonical emoji, actor)` and idempotent.
- Emoji names match `^[a-z0-9_+-]+$`, at most 64 characters, normalized to Chat SDK names.
  bordeaux reuses upstream's emoji table (`src/contract/emoji-table.ts`).

### Actors

- `actor.seen{actor,kind,handle,name,avatar,via?,platform?,host?,verified?}` is written **in
  the same append** as the actor's first write, and again whenever any of those details
  change.
- Handles are display hints only. Several actors may share one.
- The `byHandle` index is lowercased.
- Mention resolution:
  1. Only actors the caller can see are candidates.
  2. A board actor beats a platform user.
  3. Otherwise, the one sole writer in the thread wins.
  4. Otherwise, the mention stays as typed.

### Attachments

| Property | Rule |
| --- | --- |
| ID | 22 characters of base64url |
| Metadata | `name`, `type`, and `size` are recorded from what was stored, never from what the client claimed |
| Limits | 4 MB per upload; 25 MB for sync imports; 100 MB for direct uploads; 10 per message |
| Who may read | the uploader, and anyone who can read a non-deleted message carrying the file |
| Carrier lookup | through `board_terms(term='^')` |
| Storage | **Δ** R2 ([08](08-cloudflare.md#files)) |

### Schemas and blocks

- **Registry.** Schemas are versioned and immutable. `name` matches `^[a-z][a-z0-9._-]{0,79}$`;
  `version` runs from 1 to 99,999.
  - Registering an identical definition again answers `created: false`; key order doesn't
    matter.
  - A different definition under the same `name@version` answers 409 `schema_immutable`.
  - Registering needs `manage` at `*`.
  - At most 500 versions per board.
- **Built-ins.** `git-commit@1` and `vercel-deployment@1` are reserved and listed first.
- **Definitions** are structural JSON Schema only. `$ref`, `pattern`, `uniqueItems`, and
  custom keywords are refused. Limits: 32 KB, 512 nodes, 64 subschemas, depth 16.
- **Blocks** are top-level fences ```` ```json#name@ver ````.
  - `board()` checks them on post, edit, and schedule, and answers 400 `invalid_block` or
    `schema_not_found`.
  - Imported platform text is never checked.
  - bordeaux reuses `@vercel/board/schemas` (`checkDefinition`, `checkValue`, `findBlocks`),
    which has no dependencies.

### Threads and tasks

A thread is identified by its root ID. Its lane key is the root's event ID. A task is a root
whose `task` field is set; see [05](05-schedules-tasks.md#tasks).

## Events

These are the `board` session's events, which `/events` and watchers see. Every event carries
`thread`, except `channel.created` and `actor.seen`.

| Type | Payload |
| --- | --- |
| `message.posted` | `channel text re replyTo thread labels noSync by origin from attachments links schedule? blind? importedBy? along?` |
| `channel.created` | `channel by` |
| `message.edited` / `.deleted` / `.linked` | `id text? links? by from` |
| `reaction.added` / `.removed` | `id emoji by from` |
| `labels.changed` | `id set unset by` |
| `thread.synced` | `target cause(config\|request) kind(channel\|thread) by` |
| `message.synced` / `.files_synced` / `.sync_failed` | `id target external\|files\|error syncedBy?` |
| `actor.seen` | actor fields |
| `task.created` / `assigned` / `needs_changed` / `ready` / `claimed` / `renewed` / `released` / `expired` / `completed` / `failed` / `blocked` / `unblocked` / `canceled` / `reopened` | `id thread …` (see [05](05-schedules-tasks.md)) |

These events are hidden from `/events` unless `all` is set: `actor.seen`, `thread.synced`,
`message.synced`, `message.files_synced`, and `task.renewed`.

## Multi-event appends that must stay atomic

- `actor.seen` + `message.posted` (+ `thread.synced` for sync targets in the post).
- Task root: `message.posted` + `task.created` [+ `task.ready`] [+ `task.expired` +
  `task.claimed`].
- `task.completed` + one `task.ready` per dependent whose last open need it was.
- Deleting a task root: `task.canceled{reason:'deleted'}` **before** `message.deleted`.
- An edit to an open task root by a non-owner: `message.edited` + `task.blocked{kind:'edited'}`.
- Claiming a lapsed task: `task.expired(old epoch)` + `task.claimed`.

## Reads

| Rule | Detail |
| --- | --- |
| Write consistency | A write answers after its events are applied to the tables. **Δ** bordeaux applies the log append and the table update in **one transaction**, so list reads never lag. (`local()` may lag list reads by up to 10 seconds.) |
| Filters | `channel`, `channels` (the set the caller can read), `re`, `by` (actor or principal sets), `mentions` (terms and prefixes), `from`, `text` (case-insensitive substring over lowercased text; `%` and `_` are literal), `labels` (matched on the message or its root). |
| Before or after | Feed and watcher matching loads the message and its root as of `index - 1` (`board_versions`), folds the event in, and delivers the event if either state matches. The SQL filter and the in-memory predicate MUST agree. bordeaux ports upstream's shared test. |
| Paging | `/messages` pages forward with `after`. `/threads` pages backward with `older` → `before`; a `before` that never came from `older` answers 400 `invalid_cursor`. `/channels` pages with `next`, and `/tasks` with `cursor`. |

## Retention (Δ, decided Q9)

Upstream never deletes anything. A bordeaux board lives in one Durable Object, whose SQLite
holds up to 10 GB (confirmed in [M0](../spike/m0/REPORT.md)), so three things that grow without bound get retention rules.
Messages and the board log itself are never pruned.

| What | Rule | Visible effect |
| --- | --- | --- |
| Raw platform events (sync inbox) | Kept 30 days. Raw payloads are capped at 256 KB per event; larger ones are stored truncated, with `raw.truncated: true`. | `GET /inbox/:key` and `vb inbox` show at most 30 days. |
| Per-change message copies (`board_versions`) | Copies older than 30 days are compacted to the latest copy per message, plus any copy a consumer that hasn't caught up still needs. | Replaying `/events` from a cursor more than 30 days old matches filters on each message's state *after* each event, not before. |
| Attachment bytes of deleted messages (R2) | Deleted 30 days after the message is deleted (`bx gc`, which also runs on a daily cron) | `GET /attachments/:id` already answers 404 for these, so nothing changes. |

**As built (M4).** `engine.gc()` runs from `bx gc` (`POST /admin/gc[?board=]`) and the
Worker's daily cron (`0 4 * * *`, every board). It removes:
- dead letters older than 30 days, which hold the raw payloads of what failed. A raw payload
  waits in its queue only until it's handled, so there's no other copy to prune;
- remembered inbox IDs older than 30 days (the dedupe table);
- message copies from before the cutoff (the newest log index older than 30 days, or the
  matching position if that's behind it), except each message's latest copy at the cutoff;
- the bytes and record of a file whose messages were all deleted more than 30 days ago, of a
  file no message ever used within 30 days of its upload, and of a direct upload whose URL ran
  out before it finished. A file stored before upload times were kept counts from its first gc.

Raw payloads are capped as they're pushed: one whose JSON is over 256 KB is kept as
`{ truncated: true, bytes, json }`, its JSON cut short.

## Redaction (Δ, decided Q9)

Deleting a message leaves a tombstone, but the original text stays in the log's
`message.posted` and `message.edited` events. Redaction removes it, for when a message leaks a
secret.

**How to redact.** Use `POST /admin/messages/:id/redact {reason}` or
`bx redact <id> --reason "leaked token"`. This needs a board owner or `manage` at `*`.

**What one transaction does:**
1. Deletes the message first if it isn't deleted already, with the usual `message.deleted`, so
   feeds and watchers see it go away.
2. Rewrites the message's `message.posted` and every `message.edited`, `message.linked`, and
   `labels.changed` payload for it. `text`, `links`, `attachments`, and label values become
   empty, and `redacted: true` is set. Event IDs, indexes, `by`, and timestamps are kept, so
   cursors, versions, and IDs stay valid.
3. Removes every `board_versions` and `board_terms` row for the message.
4. Removes inbox raw events that produced it (looked up through `board_external_messages`).
5. Deletes its attachment bytes from R2 immediately, instead of after 30 days.
6. Appends `message.redacted{id, by, reason, at}` to an `admin` session. That session is
   never shown on `/events`, but `GET /admin/redactions` lists it.

**Options and limits:**
- With `--everywhere`, it also deletes the synced copies on each platform through the
  provider's `delete`.
- Redaction cannot recall copies already read by clients, tails, watchers, webhooks, or
  exports.
- This departs from upstream's "the log is immutable", on purpose, and only through this one
  admin path.

**As built (M4).** `engine.redact()` (`src/engine/redact.ts`), from `POST /admin/messages/:id/redact[?board=]`
(manage at `*` on the default board, as for every admin route) and `bx redact`. It differs from the steps above where
upstream's contract or bordeaux's storage asks it to:
- **Text becomes `[redacted]`, not empty.** Upstream's schema refuses an edit with empty text, and
  its clients parse what the feed sends, so an empty edit would break an export's import and a
  `vb tail` reading from before. A post reads the same, for one rule. Label values become empty,
  links and attachments go, and the origin's `context` (platform text) becomes null.
- **Queued items, not an inbox session.** bordeaux keeps a raw platform payload only while a
  queue holds it, so step 4 drops the queued items and dead letters that say anything of the
  message: an inbox's platform events about it (by its `board_external_messages` keys), and
  watcher and sync matches about it. A match for its `message.deleted` stays: a sync needs it to
  delete the board's copies.
- **The platform copies.** Upstream's sync already deletes, on each platform, the copies the
  board made when the message is deleted (step 1), so every redaction does. It never deletes the
  original a platform sent, so `--everywhere` tries that one, through the board's own sync's
  provider. A platform may refuse: a Slack app's bot token deletes only the app's own messages,
  so a person's Slack message answers `cant_delete_message`, and `bx redact` exits 1 and says
  to delete it there. A message a sync elsewhere imported (`importedBy`) is that sync's to
  delete: the answer says so.
- **Files.** Its attachments' bytes and records go at once, unless another message carries one.
- **The TailDO forgets.** It keeps the newest events and board reads in memory for its readers
  (spec 08), so the route has it drop them.
- `GET /admin/redactions[?board=]` and `bx redactions` list them. An export carries session
  `admin`; an import keeps the rewritten payloads but not their `redacted: true`, which upstream's
  schema strips.
- Not covered: a schedule's own text (session `schedules`) when a schedule posted it. Cancel the
  schedule too.

**Checked live (2026-11-25)** on the test deployment's default board, synced with
`#bordeaux-test` in a real Slack workspace. A person posted a fake key in the channel; it came
onto the board as #38, and a board reply with the same key (#39) went back to the Slack thread
as the app.
- `bx redact 39`: one event rewritten, two copies removed. Upstream's sync deleted the app's
  copy from the Slack thread within 10 s.
- `bx redact 38 --everywhere`: the board side went as for #39; Slack refused to delete the
  person's message (`cant_delete_message`), and `bx` said so and exited 1. The person deletes
  it in Slack.
- Afterwards `/events?after=37&all=true`, from the board and through the TailDO (`wait=2`),
  showed the posts as `[redacted]` and both deletions; the board's export held no trace of the
  key; `bx redactions` listed both.
- Not checked live: files, queued inbox items, and GitHub or Linear originals.


## Limits

| Thing | Limit |
| --- | --- |
| Board name | 1–64 characters, no `/` |
| Channel path | 2048 characters |
| Text | 10,000 characters |
| Label key / value | 64 / 256 characters |
| Attachments or links per message | 10 |
| Upload / sync import / direct upload | 4 MB / 25 MB / 100 MB |
| Client `id` | 200 characters |
| Ref (message ID, schedule ID, cursor) | 128 characters |
| Pages | threads: default 50, max 500; channels: default 100, max 500; messages: default 50, max 500 |
| `/events` | `wait` up to 300 s; `last` up to 100; 200 log events scanned per page |
| `/watchers/matches` | `wait` up to 25 s; `limit` up to 50 |
| Label `if` conditions | 16 |
| Grants per batch / principals per grant | 16 / 32 |
| `x-board-can` | 4000 characters |
| Sync entries per registration | 32 |

These limits are part of the protocol. bordeaux MUST NOT relax them, even where Cloudflare
could, because the Zod table enforces them upstream of the backend anyway. One exception:
**Δ** limits that come only from Vercel's platform (lease cap 300 s, long-poll cap 25 s,
100-message `/messages` cap) follow `local()` instead.
