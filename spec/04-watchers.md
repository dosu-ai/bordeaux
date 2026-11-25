# 04 · Watchers and wake-ups

A watcher is a `vb tail` expression with code attached. On Vercel there are two kinds:

- The board's **own config watchers** run in its process.
- A **deployment's watchers** are registered with Vercel's API. The API matches events against
  them, then wakes the deployment's path. The deployment pulls its matches and acks them.

bordeaux supports both. It replaces wake-by-path with **wake-by-URL** and
**wake-by-binding**.

## Tail expressions

Upstream's `parseWatchTail` (`src/api/tail.ts`) is normative. A tail is one optional
positional channel (`chan` or `prefix/`), plus these flags:

| Flag | Meaning |
| --- | --- |
| `--re <id>` | One thread |
| `--by <handle\|actor>` | One author |
| `--mentions <@handle\|actor>` | Messages that mention someone. A bare `--mentions` (meaning "me") is an error in a watcher. |
| `--label k[=v\|w]` | A label; repeatable |
| `--source <key\|board>` | Where the message came from |
| `--text <words>` | A text match |
| `--all` | Every event |

`--after` and any other flag answer 400 `bad_watcher`. Watcher IDs follow two rules:

- Config watchers: `^[a-z0-9][a-z0-9_-]{0,63}$`.
- Registered watchers: `^[A-Za-z][A-Za-z0-9-]{0,31}$`. These double as profile names.

## Matching

Matching is the `board-watchers` consumer. It runs per thread lane, in log order.

- **Events matched:** every message event, receipt, and `task.*` event. `thread.synced` never
  matches. Receipts and `task.renewed` match only with `--all`.
- **Match test:** with criteria, an event matches when its message matched before *or* after
  the event. With no criteria, any event about a message matches.
- **Self-writes:** a watcher never wakes on its own writes. Those are writes by
  `board:watch:<id>` or `<registrant>+<id>`. The one exception is a `message.posted` that is
  one of its own scheduled sends.
- **Access:** a registered watcher sees only what its registrant may read *now*.
  `accessNow(principal)` is evaluated once per event per registrant.
- **Appends:** each match is appended as `watch.matched`. Its ID is derived from
  `(watcher key, event id)`, so matching is idempotent. All matches for one registrant from
  one event go in a single append.
- **Sync matches:** a registrant with sync entries also gets `@sync` matches for synced events
  where it holds `sync`.

## Config watchers (the board's own)

These are declared in `bordeaux.config.ts`:

```ts
watch: {
  triage: { tail: 'support', run: async ({ event, board }) => { … } },
}
```

`run` executes in the **Worker**, because it is operator code. The Durable Object holds the
match queue and wakes the Worker through a self service binding (see
[08](08-cloudflare.md#consumers-and-the-worker)). Each `run` behaves as follows:

- It acts as `board:watch:<id>`. Its writes take IDs derived from the trigger event and the
  call order, so a retried run that writes in the same order is idempotent.
- Retries run in order within a thread, and threads run in parallel. On the 5th failed
  attempt it appends `watch.failed{matched,thread,error≤500}`. A run that is killed without
  throwing is abandoned at attempt 10. It never dead-letters.
- A watcher that is removed from the config skips the matches it left queued.

## Registered watchers

### Routes

| Route | Semantics |
| --- | --- |
| `POST /watchers` | Body: `{ watch: {id:{tail}}, sync?: [{key,platform}], url? }`. Replaces the caller's registration. Needs `read` somewhere, and `sync` somewhere if `sync` is given. Answers 400 `too_many_watchers` above 64. A sync key that collides with the board's own answers 409 `sync_key_taken`. A narrowed caller gets 403. A registration that changes nothing writes nothing. `hash` = the first 32 hex characters of the sha256 of the canonical watchers. |
| `GET /watchers` | With `manage` everywhere: every registration. Otherwise: the caller's own. |
| `GET /watchers/matches?limit≤50&wait≤25` | Leases up to `limit` queue heads for 5 minutes. Holds up to `wait` seconds for one. Answers 404 `no_registration` if the caller has none. |
| `POST /watchers/matches/:id/ack` | Body: `{ lease, error?, skip? }`. Answers 404 `no_match` or 409 `stale_lease`. |

### Queue semantics

These are exactly upstream's `foldQueue`:

- There is one queue per `(watcher | @sync | @inbox:<key>, thread)`. Only the head of a queue
  is ever handed out.
- A pull leases every free head: no live lease, and `retryAt` has passed. The lease ID is 16
  random bytes in hex. The lease event ID is derived from `(match, attempt)`, so two
  concurrent pulls cannot both lease the same head.
- A head is affected at pull time as follows:
  - Its lease has lapsed: `watch.expired`, which counts as an attempt.
  - Its registrant can no longer read it: `watch.skipped`.
  - It has had 5 attempts: `watch.failed`, and the queue moves on.
- An ack takes one of three forms:
  - Success: `watch.acked`, and the head is removed.
  - With `error`: `watch.acked{error, retryAt}`, where
    `retryAt = now + min(30s, 1s·2^(n−1))`.
  - With `skip`: `watch.skipped`.

### As built (M2)

- **Matching runs in the board's DO** after each write, from a stored position, so a restart
  picks up where it stopped. It's upstream's `dispatch` (src/server/watch.ts) and queue
  (src/server/registered.ts), with the queue kept per registrant in `bx_queues`.
- **Δ Access at registration.** Upstream works out a registrant's access at each match with
  board()'s policy, which lives in the Worker. bordeaux matches with the access the registrant
  had when it registered, and each pull filters again by what it may read then. A registrant
  whose access narrowed gets less, never more; one whose access widened re-registers (its
  hash changes when its watchers do, and any registration refreshes the access).
- **Δ Wakes come from the DO's alarm**, not a Queue: a registrant with matches and a `url` gets
  one `POST <url>/wake` per batch of matches, with `x-board-watchers` set to its hash, retried
  with backoff when it fails. Not yet covered by a test (the test runner can't receive it).
- Config watchers (`board({ watch })` in `bordeaux.config.ts`) and the `@sync` queue come with
  the template and sync (M3).

## Wake-ups without Vercel (Δ)

| Mechanism | Registration | Who uses it |
| --- | --- | --- |
| **Pull** | no `url` | Anything long-lived: a Node server, an agent loop, `vb` with a tail. It holds `GET /watchers/matches?wait=25` open. This is upstream behavior. |
| **Wake by URL** | `url: "https://app.acme.dev/api/board"` | Serverless apps on any host, including Vercel itself. **Δ** `local()` answers 501 `no_wake_by_url` and Vercel answers 400; bordeaux accepts it. |
| **Wake by binding** | `binding: "<service>"` (bordeaux extension field, only accepted from callers verified through a service binding) | Workers in the same account. bordeaux calls the app's `wake()` RPC method. No public URL is needed. |
| **Wake by path** | `path` | Not supported: 501 `no_wake_by_path`. The conformance check expects exactly this, and discovery leaves out `wake_by_path`. |

**What a wake-up is.** It follows upstream's decision log: "a registration carries no code …
the board wakes with no event and no credential".

- It is `POST <url>/wake`, with header `x-board-watchers: <hash>` and an empty body.
- It authorizes nothing. The woken app pulls `/watchers/matches` with **its own** credential,
  and anything it gets comes from that pull.
- So a wake-up that is forged, replayed, or misdirected costs a pull and leaks nothing.
- **Δ** bordeaux also signs each wake with a short JWT, `x-bordeaux-wake: <jwt>` (`aud` = the
  registered URL, `exp` 60 s). Apps that want to shed unsolicited traffic can verify it.
- If the hash doesn't match the app's current watchers, the app re-registers before it pulls
  (this is the upstream registrant behavior).

**When to wake.**

- On each new `watch.matched` for a registrant with no live wake in flight, bordeaux enqueues
  one wake. Wakes are coalesced per registrant, with at most one in flight.
- The app answers `{ ran }`, or 202 after 2 seconds while it keeps draining. Either counts as
  delivered.
- A failed wake (network error, 5xx, or 429) backs off from 1 minute, doubling to 1 hour, as
  Vercel's board does. Matches stay queued and unleased while this happens, so a later
  pull still finds them.
- A registration whose wakes have failed for 7 days is marked `unreachable` in `GET /watchers`.
  It is never deleted automatically.
- Delivery runs on a Cloudflare Queue (see [08](08-cloudflare.md#wake-ups)), so the Durable
  Object never holds an outbound request.

**The app side.** Upstream's `http()` backend never registers watchers. Upstream's `vercel()`
backend registers only with Vercel's API. So bordeaux ships `@dosu/bordeaux/app`, a `Backend` that
apps pass to upstream `board()`: `board({ backend: bordeaux({ url, token }), watch })`. Its
behavior matches what `vercel()` does on Vercel:

- It registers on first use and on `POST /watchers`.
- It serves `POST /wake`: it pulls, runs, and acks until the queue is drained, re-registering
  when the hash is stale.
- It skips its own writes.
- With no public URL known (a dev server), it registers without `url` and pulls on its own.

See [07](07-clients.md#bordeauxapp).
