# M0 spike report

Date: 2026-11-25 · Upstream: `@vercel/board` 0.56.1 · wrangler 4.168.0 (local workerd) ·
Chat SDK 4.45.0

The spike answers each **(verify)** in the spec, plus the `bx` checks Q13 added. Everything
ran locally in `wrangler dev` (workerd), except where a row says "docs". Nothing was deployed
to a Cloudflare account.

## Verdicts

| # | Question | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Does upstream `board()` (default build) run in workerd? | **Yes**, with `nodejs_compat`. Bundle 1.4 MB (266 KB gzip). | `src/worker.ts`: discovery, `me`, 401 without a token, zod 400s, the stub's 501 in upstream's error shape, SSE (`: connected`), and `?wait=` long-poll all behave. |
| 2 | Does upstream's `waitUntil` work on Workers? | **Yes, with a shim.** Install `globalThis[Symbol.for('@vercel/request-context')] = { get: () => als.getStore() }` and run each request in an `AsyncLocalStorage` holding `ctx`. | `/__spike/wait-until`: a task queued exactly as upstream queues it finished 1.5 s after the response. |
| 3 | Do service-binding `props` reach a `WorkerEntrypoint` as `ctx.props`? | **Yes**, over both RPC and `fetch`. | `app/`: the app Worker's `{ service: 'www', env: 'production' }` arrived in `BoardEntrypoint`. Local only; re-check once deployed. |
| 4 | Do `chat` and `@chat-adapter/{slack,github,linear}` run on Workers? | **Yes.** All three load, verify webhook signatures, and reach board's inbox. The Container fallback (Q8) is probably unnecessary. | `src/sync.ts` + `tools/webhooks.mjs`: Slack `url_verification` 200 with the challenge, GitHub `ping` 200 `pong`, Linear 200. Bad signatures: 401, 401, 400. Bundle 4.9 MB (794 KB gzip). |
| 5 | Does aliasing `@vercel/connect/chat` to a stub work? | **Yes.** wrangler's `alias` replaces it; upstream's modules load with our adapters. Option (b), installing Connect inert, isn't needed. | `wrangler.sync.jsonc`, `stubs/connect-chat.ts` |
| 6 | Does `bx` work on `createApp` with `BOARD_URL`/`BOARD_TOKEN` set in-process? | **Yes.** `whoami` reports `source BOARD_TOKEN`; errors print in upstream's format under the name `bx`. | `tools/bx.mjs` |
| 7 | Does a long `tail` survive token expiry under `bx`? | **Yes.** Upstream used the first token until 60 s before its `exp`, then re-read `BOARD_TOKEN` and picked up `bx`'s refreshed one. No 401s. | `BX_TTL=100 bx tail`: token `5563a2ce` for 9 requests, then `2e763663` for 8. |
| 8 | Can `bx` take over `list` and `--name`? | **Yes**, by handling them before `createApp` sees the args. | `tools/bx.mjs` |
| 9 | Does upstream `vb` work against bordeaux unmodified? | **Yes.** `vb whoami` with `BOARD_URL` + `BOARD_TOKEN`. | |
| 10 | Does `vb grants create --user 12345` send `{ userId }`? | **Yes**: `principals: [{ kind: 'user', userId: '12345' }]`. | spike stub's recorded input |
| 11 | Does R2 enforce a checksum on a presigned PUT? | **Not needed for parity.** R2's `PutObject` supports a signed `Content-MD5`, but SHA-256 is listed only as a multipart (composite) checksum (docs). Upstream's own `local()` ignores the optional `sha256` and checks only the size. So: sign `content-type` and `content-length` into the URL, and HEAD the object for its size at `uploadFinish`. | docs: R2 presigned URLs, S3 API compatibility; upstream `local()` `uploadStart`/`uploadFinish` |
| 12 | Durable Object limits | **10 GB SQLite per object** (unlimited per account on Workers Paid, 5 GB on Free); 8 MB max row or value. CPU limit is 30 s by default (configurable to 5 min), counts active work only, and **resets on every request or WebSocket message**. No wall-clock limit while a caller stays connected. Alarm handlers get 15 min. | docs: Durable Objects limits |
| 13 | Worker size | No compressed-size limit; 64 MiB uncompressed. The sync bundle (4.9 MB) is far below that. | docs: Workers limits |

## Findings that change the spec

- **Always set `url`.** Without it, `board()` takes its URL from the request's host. Over a
  service binding that's `http://board`, and discovery and token audiences follow it. bordeaux
  must configure its public URL (spec 08 already requires one for production; it's now required
  everywhere).
- **The request-context shim is a must**, not an optional public-ish seam: without it, upstream
  drops background work (retries, sync deliveries) when the response returns.
- **`bx` help is Vercel-branded.** `createApp`'s help header says "your Vercel team's message
  board" and lists only upstream's commands. `bx --help` must print its own header and its own
  commands, then upstream's list. This is cosmetic, not a reason to leave embedding.
- **The Chat SDK adapters call their platform at startup** to learn the bot's user ID. With
  real secrets this is one call per isolate; worth caching in KV or the DO in M3.

## Not covered (needs a Cloudflare account)

- `ctx.props` and Chat SDK in production (only local workerd was used).
- R2: that a signed `content-length` rejects a different-size body on a real presigned PUT.
- Load and storage behavior under real limits (M4).

## Running it

```bash
pnpm install
npx wrangler dev                                  # board() on the stub: :8787
npx wrangler dev -c app/wrangler.jsonc -c wrangler.jsonc --port 8788   # ctx.props
npx wrangler dev -c wrangler.sync.jsonc --port 8789 && node tools/webhooks.mjs
node tools/bx.mjs whoami
```

The secrets in these configs are spike placeholders, not credentials.
