# 05 · Schedules and tasks

## Schedules

### Routes

| Route | Body or query | Answer |
| --- | --- | --- |
| `POST /schedules` | `{ channel\|re, text, labels?, noSync?, attachments?, in?, at?, every?, until?, for?, times? }` | 201 `{ schedule, mentions? }` |
| `GET /schedules` | `re?`, `channel?`, `by?`, `all?` | `{ schedules }`, oldest first, pending only unless `all` |
| `POST /schedules/:id/cancel` | — | `{ schedule, canceled }`. Cancelling twice answers `canceled:false`. |

Permissions: creating needs `post`, plus `label` when labels are set. Cancelling is allowed for
the creator while it may still post there, or for anyone with `manage` in the channel. For
anyone else the schedule doesn't exist (404).

`ScheduleView` has these fields: `id` (`s<n>`), `channel`, `re`, `text`, `labels`, `noSync`,
`attachments`, `first`, `every` (ms or null), `until`, `times`, `sent`, `next`, `last`, `state`
(pending, done, or canceled), `canceled{by, reason}`, `by`, `author`, `createdAt`.

### Timing

There is no cron syntax.

- **Formats.** A duration matches `^\d+(\.\d+)?(s|m|h|d)$`. An instant is ISO-8601 with an
  offset.
- **When to start.** Exactly one of `in`, `at`, or `every` sets the start; `in` and `at`
  exclude each other.
  - The first send is at `at`, or else at now plus `in` or `every`.
  - An `at` more than 60 s in the past is refused.
- **Repeats.** `every` must be at least 1 minute.
- **When to stop.** At most one of `until`, `for`, or `times`, and only together with
  `every`. Every instant must fall within 366 days of now.
- **Replies.** A reply schedule (`re`) attaches to the thread's root and takes its channel from
  that root.

### Lifecycle

1. **Creating** appends `schedule.created`. It stores the creator as
   `{author, principal: facts + scope (never the token), actor}`, and marks it `blind` if the
   creator couldn't read the channel. It then arms the first send.
2. **Due** is a timer, `schedule.due{id, n, at}`. Timers can't be revoked: a stale one (one
   where `next ≠ at` or `sent ≠ n`) does nothing.
3. **Send-time check.** At send time the board re-checks access with
   `accessNow(stored principal)` under the grants as they are then. The send needs `post`,
   plus `read` for a reply and `label` when there are labels. If the check refuses, the
   schedule is canceled with reason `revoked`. If the reply's root was deleted, it is canceled
   with reason `thread_deleted`.
4. **Sending** posts **through `board()` as the creator**, so middleware and mention
   resolution run. The post's ID is `derive('board-schedule', id, n)`, so a crash before the
   send is recorded never posts twice. If the middleware drops the send, the schedule is
   canceled with reason `dropped`.
5. **Recording** appends `schedule.fired{id, n, message, next}` and arms the next send. Slots
   that were missed are skipped, never replayed. Sending stops at `times` or `until`.

**Δ** bordeaux runs timers on Durable Object alarms, so pending sends survive restarts and
deploys. `local()` loses them on restart; Vercel's board keeps them.

Upstream hands sends from one Vercel deployment to the next with `schedule.takeover` and, since
0.57.0, `schedule.takeover.armed`, which records how far the new deployment armed them. A
board's Durable Object is its only sender and keeps its timers across deploys, so bordeaux
writes neither event.

The send happens in the Durable Object, but it must pass through `board()`, so the
DO calls the Worker's internal `/__bordeaux/schedule-send` entrypoint over the self service
binding. That entrypoint calls `binding.handle(creatorCaller).post(...)` (see
[08](08-cloudflare.md#consumers-and-the-worker)).

## Tasks

A task is **a thread with a state**. The root carries `task` and the label
`board.task=<state>`, so reads, tails, watchers, sync, and the inspector need nothing new to
handle tasks.

### State

`task = { state, owner (principal), by (actor), for, needs[], epoch, claim{actor,until,token-hash}|null, blocked{kind,reason}|null, result, reason }`.
Views drop the token hash. Event views also drop `along`.

| Event | Allowed from | Resulting state |
| --- | --- | --- |
| created | an undeleted root that isn't yet a task | `waiting` if it has needs, else `ready` |
| ready | waiting | ready |
| claimed | ready, with `epoch = current + 1` | claimed |
| renewed | claimed, same epoch | claimed |
| released / expired | claimed, same epoch | ready |
| completed | claimed, same epoch | completed (with `result`) |
| failed | claimed, same epoch | failed (with `reason`) |
| blocked | waiting, ready, or claimed | blocked; the claim ends |
| unblocked | blocked | waiting or ready |
| canceled | anything but completed or canceled | canceled |
| reopened | failed | ready |
| needs_changed | waiting, ready, or blocked | the needs are replaced; state becomes waiting or ready unless blocked |
| assigned | any | `for` changes |

### Routes

| Route | Body | Answer |
| --- | --- | --- |
| `POST /tasks` | `{channel, text, labels?, noSync?, attachments?, id?}` or `{re}`, plus `needs?, for?, claim?, lease?, token?` | 201 `{task, claim?, mentions?}` |
| `POST /tasks/batch` | `{channel, tasks[1..100]{key?,text,labels?,needs?: (id\|{key})[], for?}, id?, request?}` | 201 `{tasks}`. One append; all or none. |
| `GET /tasks/batch/:id` | `request?` | `{tasks}`, or 404 `batch_not_found` |
| `GET /tasks` | `channel, state (open\|all\|<state>), label[], by, owner, for, needs, after, limit≤500, latest` | `{tasks: ThreadSummary[], cursor}`, oldest first |
| `POST /tasks/claim` | `{channel, label?, from?: principal[]≤32, lease?, wait≤300, token?}` | `{task, claim}` or `{task: null}` |
| `POST /tasks/:id/claim` | `{lease?, token?}` | `{task, claim{epoch, token, until}}` |
| `POST /tasks/:id/renew` | `{epoch, token, lease?}` | `{task, until}` |
| `POST /tasks/:id/release` | `{epoch, token}` | `{task}` |
| `POST /tasks/:id/complete` | `{epoch, token, result?}` | `{task}` |
| `POST /tasks/:id/fail` | `{epoch, token, reason}` | `{task}` |
| `POST /tasks/:id/block` | `{reason, kind? (≠edited), epoch?, token?}` | `{task}` |
| `POST /tasks/:id/unblock` · `/reopen` | — | `{task}` |
| `POST /tasks/:id/assign` | `{for: actor\|null}` | `{task}` |
| `POST /tasks/:id/needs` | `{needs: id[]≤20}` | `{task}` |
| `POST /tasks/:id/cancel` | `{reason}` | `{task}` |

### Rules

**Permissions.**
- A new task thread needs `post`. Labels, adopting a thread (`re`), and claiming need
  `label`.
- `block` without a claim, `unblock`, `reopen`, `assign`, `needs`, and `cancel` are for the
  owner (while it may still post or label there) or for anyone with `manage`. Anyone else gets
  403 `task_not_owned`.

**Claims.**
- The lease is 30 to 3600 seconds, 900 by default.
- The token is 16 random bytes in base64url, or one the caller sends. The board stores only
  `sha256(token)` and compares in constant time.
- A lapsed claim counts as `ready`. Claiming it appends `task.expired` and `task.claimed` in
  the same append.
- Re-claiming by ID with the live claim's own token returns that claim, so a retry is safe.
- When a claim is refused, the error is the first of these that applies: `task_waiting`,
  `task_blocked`, `task_finished`, `task_assigned`, `task_claimed`.

**Fencing.** `renew`, `release`, `complete`, `fail`, and `block` with a claim all need
`claimed`, the same epoch, a lease that hasn't lapsed, and the right token. Otherwise they
answer 409 `claim_lost`.

**Claiming the next ready task.** `claimReadyTask`:
- considers roots labeled `board.task ∈ {ready, claimed}` in the channel or subtree, oldest
  first;
- prefers a task assigned to the caller, then the oldest unassigned task whose owner is the
  caller or is listed in `from`;
- with `wait`, holds until a task becomes claimable, or until the caller goes away.

**Needs.**
- Each need must exist, be a task, be readable by the caller, and not be canceled. Otherwise
  the request answers 400 `invalid_needs`, with the same wording whichever of those failed.
- Adding needs is refused if it would form a cycle. The walk visits at most 500 tasks.
- When a need completes, every dependent whose last open need it was gets `task.ready` in the
  same append.
- **Δ** bordeaux keeps a `task_needs(need, task)` index, so completion is O(dependents)
  rather than a scan of every waiting task.

**Holds from messages.**
- If a non-owner, or any platform import, edits a root whose task is waiting, ready, or
  claimed, the board appends `task.blocked{kind:'edited'}`.
- Deleting an open task root appends `task.canceled{reason:'deleted'}` before
  `message.deleted`.

**Lease timers.**
- Each claim or renew arms a `lease.due` timer. When it fires, `task.expired` is appended if
  that epoch still holds the claim.
- Lapsed claims are also treated as `ready` at read time.

⚠ Upstream SPEC.md says a list writes `task.expired` for lapsed claims; `local()` does not.
bordeaux follows `local()`: lists write nothing, and the timer writes the expiry.

**Waiting requests.** Waiting claims (`wait`), `/events` long-polls, and
`/watchers/matches?wait` are held in the Durable Object as in-memory waiters. Each is woken by
the append that could satisfy it, never by polling. Upstream `local()` polls every 100 ms,
backing off to 1 s.
