> You are the owner and long-term maintainer of this codebase, and its design is up to you. Treat the codebase like a garden: prune and weed regularly, so it stays healthy and manageable over time.

# agents guide

bordeaux is vercel/board's protocol on Cloudflare: upstream's `board()` runs in a Worker,
and each board is a Durable Object. One package does the work, `@dosu/bordeaux`
(`packages/bordeaux`), and `npm create @dosu/bordeaux` (`packages/create-bordeaux`) makes a
deployment of it. [spec/](./spec) is the design, [PARITY.md](./PARITY.md) says where we match
Vercel's hosted board and where we don't, and [QUESTIONS.md](./QUESTIONS.md) records the
decisions behind both. Read the spec before changing behavior. This guide is adapted from
upstream's own (vercel/board, Apache-2.0).

## run it

```bash
pnpm install
pnpm check                                   # typecheck every package
pnpm test                                    # vitest, in workerd
pnpm --filter @dosu/bordeaux conformance     # upstream's conformance kit against a local board
```

There's no CI yet: run all three before you push. Conformance starts a fresh `wrangler dev`
per run and prints why each skipped check skipped. Every group passes today, `sync`
included; keep it that way.

Tests run in workerd through `@cloudflare/vitest-pool-workers`, on `test/wrangler.jsonc`
(main `test/worker.ts`, which calls `configure()` with `test/config.ts`). Nothing leaves the
runner: `vitest.config.ts`'s `outboundService` answers every outbound fetch, Slack's Web API
included. Sync is tested against Chat SDK's fake platform (`test/sync-fixtures.ts`, upstream's
`fakePlatform`). Auth is real: tokens come from the dev route (`test/helpers.ts`
`tokenFor`), signed and verified as a deployed board does.

A test pins what a user can observe (a route's answer, what lands on the board, what a
platform was sent), never internals. Break what it claims to test and watch it fail before
you trust it. Two tests in one run hitting vitest's 5 s timeout under load is a flake; the
same test failing alone is not.

## upstream

bordeaux cannot contribute to vercel/board, and never edits upstream's files. The pin is
`@vercel/board` 0.56.1 at `6d49814` (`scripts/vendor-upstream.mjs` `PIN`).
[spec/00](./spec/00-overview.md#working-around-upstream) ranks the ways around it; prefer
the earliest that works:

1. a public seam (`Backend`, `authenticate`, your own Chat SDK adapters, `createApp()`);
2. a build-time alias (`@vercel/connect/chat` → `@dosu/bordeaux/connect-chat`), set in every
   `wrangler.jsonc` and in `vitest.config.ts`;
3. a pure module copied byte for byte into `src/upstream/` by `pnpm vendor <checkout>`;
4. re-hosting a prebuilt asset (the inspector's `app.js`, from Static Assets);
5. our own code around upstream's (`bx`, `@dosu/bordeaux/app`, the hosted inspector);
6. last, a `pnpm patch`, listed with its reason in `PATCHES.md`.

- **`src/upstream/` is upstream's.** Never edit a vendored file by hand: add it to the
  script's `FILES` and rerun it. What a vendored file imports that isn't vendored is a shim
  beside it, marked `// SHIM (bordeaux)`.
- **Port, don't paraphrase.** Code that mirrors upstream (`src/engine/`) names the upstream
  function it ports in its doc comment (`(upstream a2.ts \`syncFind\`)`) and keeps its
  behavior. Where we differ on purpose, mark it **Δ** with the reason, in the code and in
  the spec. When a port looks odd, read upstream's source at the pin before "fixing" it.
- **A difference users can see** goes in PARITY.md.

## other private repos

Never link or cite a private repo other than this one, Vercel's or ours: not its PRs,
issues, commits, or files, and not in code, comments, tests, fixtures, docs, commit
messages, or PR descriptions. Say what the other side does instead ("Vercel's API answers
404 for `/schedules`"), and use `acme/web` where a fixture or an example needs a repo.

## pr titles and descriptions

**Title:** `<type>(<area>): <what it does>`, in the imperative, about 60 characters at most:
`fix(sync): cap slackSync's Slack client as upstream does`. A milestone's PR may be titled
`M<n>: <what it delivers>`.

- `type` is `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, or `chore`, with `!` when it
  breaks someone.
- `area`, when one fits: `engine`, `worker`, `sync`, `inspector`, `cli`, `app`,
  `template`, `upstream` (a re-vendor or an upgrade), `spec`, `docs`.
- No narration and no second clause: two changes are two PRs.

**Body:** one line on what it does and for whom. Then four answers, each `none` when nothing
applies:

```markdown
- **Users:** none | the new or changed command, route, config, or output; "breaking" if it is.
- **Protocol / parity:** none | what changes against upstream's protocol or Vercel's board, and PARITY.md's row.
- **Performance / I/O:** none | what each affected call now costs: DO round trips, writes, platform calls, alarms.
- **Tests:** what's covered and at what level (vitest in workerd, conformance, a live board), and what's faked and why.
```

Evidence matches the claim: a fix names the test that fails without it. A live check says
which board and platform it ran against and what it did and didn't show. One screen; no
file lists.

## the docs (`docs/`, `spec/`, `README.md`)

- **The docs describe the code.** Where the spec and the code disagree, the code wins and
  the spec gets an **As built** note saying how and why. A change people will notice
  updates its page.
- **Say what was and wasn't proven.** A live run records its date, its setup, what passed,
  and what was never checked. Don't credit a fix with a result it didn't produce.
- **Upstream's voice:** present tense, short sentences, no em-dashes, hype, or filler;
  "board" lowercase. Samples are paste-complete, and every import is shown.

## the hosted inspector (`src/worker/inspect.ts`)

Upstream's prebuilt page at `<board>/inspect`, acting as the person signed in with GitHub's
web flow. The page itself is upstream's: never change it, and give it nothing that isn't in
the board's API.

- **The proxy acts as a person, so it trusts only its own page.** It requires the page's
  `x-inspect-token`, refuses a `Sec-Fetch-Site` other than `same-origin`, needs this
  origin's `Origin` on writes, refuses relative paths, and caps bodies (1 MB, uploads 4 MB).
  Keep all of them.
- **The sign-in lives in two HttpOnly cookies on the board's own `/inspect` path**: each
  named board's inspector signs in separately. The board never keeps a GitHub token.
- **Check it in a browser** against `pnpm dev` (`/inspect/login?id=<n>` signs in a made-up
  person on a dev board) before saying a change works.

## cli design (`src/cli/`)

`bx` embeds upstream's commands through `createApp()`, so it reads like `vb`: plain and
quiet, for a person at a terminal first, `--json` for programs. What bordeaux adds (`login`,
`token`, `tokens`, `boards`, `export`/`import`) follows the same rules.

- **Say what happened, then stop.** One line per fact, lowercase phrases, no banners or
  recaps. No emoji, color, or box drawing.
- **Columns, not colons**, aligned when rows stack; paths as people write them (`~/…`); fit
  80 columns.
- **Errors are data**, shaped like upstream's: what failed and why, then at most two ways
  out. `--json` is one document.
- **Never print a secret.** A token goes where it's asked for (`bx token` prints the one
  you asked for), never into a log line or an error.

## layering

Worker → upstream `board()` → `durable()` backend → the board's Durable Object.

- **The Worker** (`src/worker/index.ts`) routes: the token broker (`/auth/*`), admin
  (`/admin/*`), JWKS, direct uploads, the inspector, then `board()` per board (`boardOf`,
  one per isolate). Revocation is checked before `board()`, because `board()` caches a
  verified principal.
- **`board()` is the policy.** It verifies the caller, works out access, runs the middleware,
  and calls the backend with the caller it verified. bordeaux adds no policy of its own
  around it.
- **`durable()`** (`src/worker/backend.ts`) forwards each protocol method to the board's DO
  over RPC: `call(method, wireIdentity, input, boardName)`. The caller crosses as data
  (`src/engine/identity.ts`), with its access as a summary the DO compiles again. Errors come
  back as an envelope the Worker rethrows as upstream's `HttpError`.
- **The DO** (`src/engine/do.ts`, `engine.ts`) owns one board: its log, tables, files'
  records, timers, and queues. Its alarm runs what isn't a request: schedule sends, task
  leases, wakes, and the board's own watchers and sync (`runOwn`), through a `board()` built
  in the DO from the same config (`boardOf`, `bindingOf`).
- **A deployment's own code** is `configure()` (`src/worker/config.ts`): middleware for every
  board; watchers and sync for the default board. `configure((env) => …)` for anything built
  from secrets (`@dosu/bordeaux/sync`).

## invariants

- **No pre-AGI mechanisms.** Don't hard-code what a model would decide better in context:
  canned decorations, keyword triggers, heuristics that rewrite a message. Deliver what the
  author wrote and give agents the tools.
- **One log per board.** Every board fact is an event in the DO's `bx_log`, in session
  `board`, `access`, `schemas`, or `schedules`. Tables and folds are built from it with
  upstream's code (`src/upstream/store/sql.ts`, `contract/folds.ts`); nothing else writes
  them. Bookkeeping people don't read (queues, timers, seen inbox IDs, failures) lives in
  `bx_*` side tables, never in the log.
- **Writes are exclusive.** A check-then-append runs inside the engine's `exclusive()` lock,
  so two writes never both pass a check that only one should.
- **Folds mutate in place.** Never share a fold's state object outside the fold.
- **Provenance is server-authored.** `by`, `mentions`, `origin`, and sync fields are never
  read from a request body.
- **Secrets never pass through a model.** Secrets go to `wrangler secret put` by a prompt the
  person types into, or straight from one API's answer into it, never printed, never typed
  into a form for them. Test values live in `test/wrangler.jsonc`, marked as test values.

## a live board

`packages/bordeaux/deploy/` is gitignored: a personal test deployment of this checkout
(`npx wrangler deploy -c deploy/test/wrangler.jsonc`), wired to real Slack, GitHub, and
Linear apps. [docs/sync.md](./docs/sync.md) has the setup and the last live run. What it
taught:

- **A deploy doesn't reach a busy board.** While a client long-polls a board (an open
  inspector, `vb tail`), its DO keeps running the code and the secrets it started with.
  Close those clients, then check, before concluding a fix or a new secret didn't work.
- **`wrangler tail` drops events**, whole webhooks and DO calls included: its silence proves
  nothing. Record what you need where you can read it back, such as R2 or the DO's
  `ownFailures()` (the board's last 50 failed own runs), and remove that instrumentation
  afterwards.
- **A secret check right after `wrangler secret put`** can still hit the old version. Wait a
  few seconds and check again before asking anyone to re-enter it.
- **Platforms have their own preconditions:** Linear sends an app's webhooks only after the
  app's first token; GitHub App manifests can't enable device flow; an App's repository
  access must be "only select repositories" for a test.
- **Leave no debug routes deployed.** A `/__debug/*` route on a public board is public.
