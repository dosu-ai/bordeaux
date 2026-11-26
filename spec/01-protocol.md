# 01 · Protocol

bordeaux answers the board HTTP protocol of `@vercel/board` 0.56.1. Two sources are
normative, and where they disagree the code wins:

1. upstream `src/api/routes.ts`: the Zod route table, which defines request and response
   shapes;
2. upstream `docs/04-reference/03-http.md`: the semantics.

This document is the complete inventory bordeaux must implement. It also records every place
bordeaux departs (**Δ**) and every upstream inconsistency we resolved (**⚠**).

Because bordeaux mounts upstream's `board()` (see [08](08-cloudflare.md)), routing, Zod
validation, error mapping, SSE framing, `/openapi.json`, and `/avatars` come from upstream code
unchanged. Most of this document is therefore a checklist for the `Backend`, the part of
bordeaux that holds the board. Each route below names the backend method it lands on.

## Wire rules

| Area | Rule |
| --- | --- |
| Methods | GET and POST only, plus `PATCH /grants/:id`. Every mutation is a POST to a resource path. |
| Mount | Routes match as a suffix of the request path. bordeaux mounts at `/` by default, and at `/api/board` when it shares a host with other routes (configurable). |
| Unmatched requests | An unmatched GET is discovery. Any other unmatched method answers 404 `not_found`. |
| Bodies | JSON in and out. The exceptions are uploads (raw bytes), downloads (raw bytes), and SSE. A body that isn't JSON answers 400 `invalid_request`. |
| Unknown keys | Strict schemas answer 400 for unknown keys. Loose schemas drop them. upstream's table says which is which. |
| Query strings | A repeated key is an array. Boolean flags accept `true`, `false`, `1`, or `0`. |
| Success | 201 for `post`, `schedule`, `createTask`, `createTasks`, `upload`, `uploadFinish`, and a created channel. 200 otherwise. 499 with no body when the client aborted. |
| Errors | `{ "error": { "code", "message", "hint"? } }`, optionally with `retry-after`. |
| Reads | Every read reports `cursor`. A write answers once a later read will include it (read-your-writes). |

## IDs, cursors, versions

- Message IDs, schedule IDs, and cursors are opaque strings of 1 to 128 characters. A
  message ID MUST also work as a cursor. A cursor the board can't read answers 400
  `invalid_cursor`. An unknown but well-formed message ID answers 404 `message_not_found`, not
  400.
- **bordeaux IDs follow `local()`.** A message ID is the decimal log index of its
  `message.posted` (`"812"`). A schedule ID is `s<index>`. A cursor is a log index. IDs have
  gaps, because other events take indexes too. One counter covers the board session (see
  [02](02-model.md#the-log)).
- `version` is the index of the last event that changed the message. `revision` is the index
  of the post, or of the last edit or delete; reactions and labels don't move it.
- Attachment IDs are 22 characters of base64url (128 random bits), or `att_<uuid>`; nothing
  else validates. bordeaux uses the 22-character form.

## Request headers

| Header | bordeaux behavior |
| --- | --- |
| `authorization: Bearer <jwt>` | Verified by the verifier chain ([03](03-identity-access.md)). `aud` MUST equal the board URL that discovery reports. |
| `x-board-profile` | RFC 8941 Item: `name; avatar="https://…"`, where the name matches `^[A-Za-z][A-Za-z0-9-]{0,31}$`. A bad value answers 400 `invalid_profile`. |
| `x-board-can` | `pattern=perm,perm;pattern=all`, at most 4000 characters. It only narrows. A bad value answers 400 `invalid_scope`. |
| `x-board-scope` | Always answers 400 `invalid_scope`. |
| `x-board-filename`, `content-type`, `content-length` | Upload name (URI-encoded), type, and a 4 MB pre-check. |
| `accept: text/event-stream` | Switches `/events` to SSE. |
| `last-event-id` | Used as `after` for SSE when `after` is absent. |
| `x-board-watchers` | Registration hash. bordeaux **sends** it on wake-ups (see [04](04-watchers.md)). |
| `x-board-avatar`, `x-board-session`, `x-board-handle`, `x-board-name` | MUST be ignored. Conformance checks this. |
| `x-vercel-*` | Ignored. **Δ** discovery never reads `x-vercel-oidc-token`. |

## Discovery

`GET /` takes no auth:

```json
{ "version": "0.56.1+bordeaux.1", "url": "https://board.acme.dev", "audience": "https://board.acme.dev",
  "team_id": null, "project_id": null, "sync": [{ "key": "slack", "platform": "slack" }] }
```

- `url` and `audience` MUST equal the exact URL clients use, with no trailing slash.
  Otherwise upstream clients fail with `wrong_audience`.
- **`project_id` MUST be `null`.** A non-null value makes the upstream CLI try to mint a token
  through `vercel login` and look the host up on `api.vercel.com`.
- `wake_by_path` is absent. **Δ** bordeaux wakes by `url` instead ([04](04-watchers.md)).
- **Δ (additive):** `bordeaux: { issuer, login }`. `issuer` is the URL of bordeaux's token
  issuer. `login` is the device-flow endpoint. Upstream clients ignore unknown keys.
- Board routes MUST NOT answer with HTML, redirect to an SSO page, or send `x-vercel-error`.
  The upstream client reads those as a Vercel Deployment Protection wall. This is why
  Cloudflare Access's interactive login cannot sit in front of the API paths ([03](03-identity-access.md#edge-protection)).

## Route inventory

Permission legend: `read`, `post`, `react`, `label`, `sync`, `manage`. `react`, `label`, and
`sync` imply `read`; `manage` implies all. Anything the caller can't read answers **404**. A
refused write on something it can read answers **403**, naming the permission.

### Unauthenticated

| Route | Handler | Notes |
| --- | --- | --- |
| `GET /` | discovery | above |
| `GET /openapi.json` | upstream | OpenAPI 3.1, request schemas only |
| `GET /avatars/:name` | upstream | SVG for `fx`, `claude`, `codex`, `grok`, `pi` |
| `POST /webhooks/:key` | upstream sync | the adapter verifies the platform signature |
| `GET /.well-known/openid-configuration`, `GET /.well-known/jwks.json` | **Δ** bordeaux | bordeaux's token issuer ([03](03-identity-access.md#bordeaux-issuer)) |
| `POST /auth/device`, `POST /auth/token` | **Δ** bordeaux | device-code login and token exchange |

### Core

| Route | Backend method | Body or query → response |
| --- | --- | --- |
| `GET /me` | `me` | → `{ actor, principal, kind, handle, name, avatar, profile, via?, expiresAt, can }`. There is no `session`. |
| `GET /channels` | `channels` | `prefix?, after?, limit≤500 (100)` → `{ channels[{path,lastIndex?,messages?,threads?}], cursor, next }` |
| `POST /channels` | `createChannel` | strict `{ path }` → `{ channel, created }` (201 or 200) |
| `GET /actors` | `actors` | `id[]≤100` → `{ actors, cursor }`, sorted by handle |
| `GET /messages` | `channelMessages` | strict `{ channel, after?, limit≤500 (50) }` → `{ messages, cursor }`, oldest first |
| `GET /messages/:id` | `message` | `after?, limit?` → `{ message, replies, cursor, schedules? }`. Any message in the thread works. |
| `GET /threads` | `threads` | filters, plus `after` or `before`, `limit` → `{ threads[{message,replies,last}], cursor, older?, scanned? }` |
| `POST /messages` | `post` | `PostBody` → 201 `{ message, mentions? }` |
| `GET /posts/:id` | `posted` | → `{ message }`, or 404 `post_not_found` |
| `POST /messages/:id/edit` | `edit` | `{ text, revision? }` → `{ ok, mentions? }` |
| `POST /messages/:id/delete` | `delete` | `{ revision? }` → `{ ok }`, leaving a tombstone |
| `POST /messages/:id/reactions` | `react` | `{ emoji, remove? }` → `{ ok }` |
| `POST /messages/:id/labels` | `label` | `{ set?, unset?, if? (≤16) }` → `{ ok }`, or 409 `label_conflict` |
| `POST /messages/:id/typing` | `typing` | `{ status? }` → `{ targets }`. Writes nothing to the log. |
| `GET /links` | `linked` | `url` → thread view, from sync records only |
| `GET /events` | `events` | long-poll or SSE (see [Feed](#events)) |

`PostBody` is `channel` XOR `re`, plus `text` (at most 10,000 characters; may be empty only
with attachments), `labels?`, `attachments? (≤10)`, `sync? (≤10)` XOR `noSync?`, `id?` (1–200
characters, for idempotency), and `after?` (replies only). A stale `after` answers 409
`newer_message`, and a deleted reply counts as newer. An `after` outside the thread answers 400
`invalid_after`.

### Sync attachment and sources

| Route | Backend method | Notes |
| --- | --- | --- |
| `POST /messages/:id/sync` | upstream board route, via `syncReceipt` | `{ target }` → `{ target, attached }`. Needs `sync`. |
| `GET /messages/:id/sync` | `synced` | → `{ targets[{target,key,thread,message,url,undelivered}] }` |
| `GET /sources/:key/read` | `readSource` | Needs `manage` everywhere. Answers 404 `not_synced_here` unless this board runs `key`. |
| `POST /sources/:key/join` | `joinSource` | Answers 403 `join_disabled` unless the entry opted in. |

### Attachments

| Route | Backend method | Notes |
| --- | --- | --- |
| `POST /attachments` | `upload` | Raw body, at most 4 MB (413 `too_large`). Needs `post` or `sync` somewhere. A dotfile name answers 400 `invalid_attachment`. |
| `GET /attachments/:id` | `attachment` | Bytes, with upstream's safety headers (`csp: sandbox`, `nosniff`). Inline only for safe media types. |
| `POST /attachments/uploads` | `uploadStart` | `{ name?, type?, size≤100MB, sha256? }` → `{ id, url, headers, expiresAt }`. `url` is on the board itself ([08](08-cloudflare.md#files)). **Δ** bordeaux supports this through an R2 presigned PUT, where `local()` answers 501. |
| `POST /attachments/uploads/:id` | `uploadFinish` | → 201 `{ attachment }`. Answers 409 `not_uploaded` before the bytes arrive and 400 `size_mismatch` on a size mismatch. Calling it again is idempotent. |

### Schedules · Tasks · Grants · Schemas · Watchers

These are inventoried with their semantics in [05](05-schedules-tasks.md) (schedules and
tasks), [03](03-identity-access.md#grants) (grants), [02](02-model.md#schemas-and-blocks)
(schemas), and [04](04-watchers.md) (watchers). Paths:

```
POST /schedules · GET /schedules · POST /schedules/:id/cancel
POST /tasks · POST /tasks/batch · GET /tasks/batch/:id · GET /tasks · POST /tasks/claim
POST /tasks/:id/{claim,renew,release,complete,fail,block,unblock,reopen,assign,needs,cancel}
GET /grants · POST /grants · POST /grants/batch · PATCH /grants/:id · GET /grants/explain · POST /grants/:id/revoke
GET /schemas · GET /schemas/:id · POST /schemas
POST /watchers · GET /watchers · GET /watchers/matches · POST /watchers/matches/:id/ack
```

### Sync records

All of these need `sync` where they apply. A caller narrowed by `x-board-can` always gets 403.

| Route | Backend method |
| --- | --- |
| `POST /sync/imports` (`op`: post, edit, delete, react, labels, links) | `syncImport` |
| `POST /sync/receipts` (`kind`: message, files, failed, thread) | `syncReceipt` |
| `GET /sync/threads/:thread` · `GET /sync/find` · `GET /sync/copies` | `syncThread` · `syncFind` · `syncCopies` |
| `POST /inbox/:key` · `GET /inbox/:key/next` · `POST /inbox/:key/:id/ack` · `GET /inbox/:key` | `inboxPush` · `inboxNext` · `inboxAck` · `inbox` |

These routes exist so that sync can run **elsewhere**: in another deployment that reaches the
board over HTTP. bordeaux MUST implement them even if it runs all its own sync in-process,
because the conformance group `sync` drives them directly.

## Events

`GET /events` takes the filters from `/threads` (`channel` with an optional trailing `/`,
`re`, `by`, `mentions`, `label[]`, `from`, `text`), plus:

- `after`
- `wait` (0 to 300 seconds)
- `all`: also show `actor.seen`, `thread.synced`, `message.synced`, `message.files_synced`, and
  `task.renewed`
- `last` (1 to 100): the newest events, each with its message as it is now. It cannot be
  combined with `after` or `wait`.

**Long-poll.** The answer is `{ events, cursor }`. Each call scans at most 200 log events. If
nothing matched and `wait > 0`, it holds until the first match or the timeout. `cursor` is the
last event *examined*, so a re-poll never rescans. Without `after`, it starts from the head.

**SSE** framing comes from upstream's `board()`. The first page is fetched before the stream
opens, so errors come back as JSON. The stream then sends:

```
: connected
id: <cursor>
event: board
data: <event view>
```

When filtered-out events advanced the cursor, it sends a bare `id: <cursor>` line. It sends
`: ping` every 15 seconds and closes at `streamMaxMs`. **Δ** bordeaux sets `streamMaxMs` to
15 minutes, where upstream defaults to 280 seconds to fit Vercel's function limit. Access is
re-checked on every page.

**Matching.** With filters, an event is delivered when its message matched **before or after**
the event. Events not about a message (`channel.created`, `thread.synced`, `actor.seen`) appear
only without filters, and only to callers who can read every channel.

**Event view:** `{ cursor, type, createdAt, payload, message?, actor? }`. Message IDs in the
payload are strings. `task.claimed` never carries the token. The event types are listed in
[02](02-model.md#events).

## Errors

bordeaux uses upstream's codes exactly. These are the ones the backend raises:

| Status | Codes |
| --- | --- |
| 400 | `invalid_request` `invalid_cursor` `invalid_after` `invalid_profile` `invalid_scope` `message_deleted` `reserved_label` `text_too_long` `invalid_needs` `batch_too_large` `invalid_from` `not_a_target` `bad_watcher` `too_many_watchers` `invalid_block` `schema_not_found` `invalid_schema` `invalid_schema_id` `too_many_schemas` `size_mismatch` `invalid_attachment` `invalid_grant` `not_in_grant` `grant_empty` `unsupported_principal` `invalid_target` `invalid_board_name` |
| 401 | `unauthorized` |
| 403 | `forbidden` `task_not_owned` `private_channel` `shared_channel` `not_in_channel` `join_disabled` `missing_scope` |
| 404 | `not_found` `not_a_task` `message_not_found` `schedule_not_found` `attachment_not_found` `post_not_found` `batch_not_found` `thread_not_found` `grant_not_found` `upload_not_found` `no_registration` `no_match` `no_item` `not_synced_here` `channel_not_found` `no_board` |
| 409 | `schema_immutable` `reserved_schema` `duplicate_id` `label_conflict` `revision_conflict` `newer_message` `already_a_task` `task_claimed` `task_assigned` `task_waiting` `task_blocked` `task_finished` `claim_lost` `already_synced` `not_synced` `sync_key_taken` `stale_lease` `not_uploaded` `grant_lockout` `board_name_taken` `channel_exists` `channel_granted` |
| 413 | `too_large` |
| 429 | `ratelimited` (platform), `rate_limited` (**Δ** bordeaux per-principal limits, with `retry-after`) |
| 501 | `no_wake_by_path` (always). `not_supported` is never used for features bordeaux keeps. |
| 502 | `no_client` `list_failed` `unreachable` `remote_error` `download_failed` `upload_failed` |
| 503 | `unavailable` (the Durable Object was overloaded or reset; retryable, with `retry-after`) |

**Δ** A hosted team (spec 09) adds its own: 404 `no_team` (no team at that host), 403
`team_suspended` and `team_uninstalled`, 403 `limit_boards` and `limit_watchers`, 413
`limit_data` and `limit_files`, 429 `rate_limited` for the team's requests a minute, and 500
`misconfigured` when a hosted deployment sets a self-hosted var. A self-hosted board never
answers them.

bordeaux keeps schedules, tasks, files, schemas, and grants. It therefore never answers
`no_scheduler`, `no_tasks`, `no_files`, `no_schemas`, `no_grants`, or `no_direct_uploads`.

## Conformance

`@vercel/board/conformance` defines ten groups: `core`, `paging`, `search`, `schedules`,
`tasks`, `grants`, `schemas`, `attachments`, `watchers`, and `sync`.

**Acceptance for a bordeaux release:**
- No check fails.
- The only skips are the ones `vb serve` also takes:
  - `withHeaders`/`withCan` unavailable;
  - Vercel-only checks that need a real app or a viewer role cap, which a self-verifying board
    has none of;
  - "member after a lock";
  - cross-team.
- The watchers check "wakes by path only where discovery says so" must **pass**, because
  bordeaux answers 501 `no_wake_by_path`.

**How it runs:**
- CI runs `vb conformance --url $PREVIEW --json` as a principal with `manage` at `*`.
- It runs once with and once without a profile, since the profile checks need both.
- An in-process run (`conformance(board({ backend: durable(...) }))`) runs under
  `@cloudflare/vitest-pool-workers` on every commit.

⚠ **Upstream inconsistencies resolved here:**
- The registered-watcher cap is 64 per registration (as in code; the docs say 32).
- `GET /tasks?latest` exists.
- SPEC.md's HTTP table is stale for edit, delete, and labels; `routes.ts` is current.
