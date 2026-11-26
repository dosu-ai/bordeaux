---
name: upstream-upgrade
description: Move bordeaux to a new @vercel/board release. Use when npm has a newer @vercel/board than bordeaux's pin, or when asked to upgrade, re-vendor, or re-check upstream. Covers finding the pin, diffing upstream against it, re-vendoring, reviewing the engine's ports, re-checking every workaround, updating the pinned version in the docs, running the checks, and opening the PR, draft PR, or issue.
---

# Upgrade bordeaux to a new upstream release

bordeaux pins one `@vercel/board` release and keeps up with upstream one release at a time
([spec/00, "Tracking upstream"](../../spec/00-overview.md#tracking-upstream), decided in
[Q11](../../QUESTIONS.md#q11)). This skill moves the pin. People follow it, and so does the
daily routine that watches npm for new releases.

Read [AGENTS.md](../../AGENTS.md) in full first and follow it: it wins where this skill
disagrees. Then read spec/00's "Working around upstream" and "Tracking upstream".

An upgrade keeps bordeaux wire-compatible with upstream's protocol and at parity with
Vercel's hosted board. It ends in one pull request, a draft pull request, or an issue (see
[Finish](#finish)).

## Never

- Edit a vendored file in `packages/bordeaux/src/upstream/` by hand. Rerun the script.
- Merge a pull request, push to `main`, or deploy (`wrangler deploy`, `wrangler secret`).
- Open anything on vercel/board. bordeaux can't contribute upstream.
- Link or cite a private repo other than dosu-ai/bordeaux.

## 1. Find the pin and the release

The pin is `PIN` in `packages/bordeaux/scripts/vendor-upstream.mjs`: a version and the
vercel/board commit the vendored files came from. The same version is the `@vercel/board`
dependency in `packages/bordeaux/package.json`.

```bash
node -e "import('./packages/bordeaux/scripts/vendor-upstream.mjs').then(m => console.log(m.PIN))"
npm view @vercel/board version
```

If npm's version equals `PIN.version`, there is nothing to do: stop, with no branch, pull
request, or issue. If several releases came out since the pin, go straight to the newest, and
read every changelog entry in between.

Before starting, check that no one has it already: an open pull request or issue for the
version, or a branch named `upstream/<version>`.

```bash
gh pr list --state open --search "@vercel/board <version>"
gh issue list --state open --search "upstream <version>"
git ls-remote --heads origin "upstream/<version>"
```

## 2. Get upstream at both commits

Clone vercel/board (public) outside this repo. A release's commit is its tag,
`@vercel/board@<version>` (releases before 0.15 are tagged `vboard@<version>`). The pin can be a
commit on upstream's `main` after its release's tag, so diff from `PIN.commit`, not from the
old tag.

```bash
UP=$(mktemp -d)/board
git clone --filter=blob:none https://github.com/vercel/board.git "$UP"
OLD=<PIN.commit>
NEW=$(git -C "$UP" rev-list -n 1 "@vercel/board@<version>")
git -C "$UP" log --oneline "$OLD..$NEW" -- packages/board
git -C "$UP" diff "$OLD" "$NEW" -- packages/board/CHANGELOG.md
```

If `$OLD` isn't an ancestor of `$NEW` (`git -C "$UP" merge-base --is-ancestor $OLD $NEW`),
the pin came from a commit after the new tag: diff `$OLD..$NEW` anyway and read what goes
backwards with care, or wait for the next release.

## 3. Diff what bordeaux depends on

Start with the files that define the protocol and the backend:

```bash
git -C "$UP" diff --stat "$OLD" "$NEW" -- packages/board/src packages/board/docs/04-reference packages/board/test/sync-fixtures.ts skills/board
git -C "$UP" diff "$OLD" "$NEW" -- \
  packages/board/src/api/routes.ts packages/board/src/api/protocol.ts \
  packages/board/src/server/backend.ts packages/board/src/contract \
  packages/board/src/conformance packages/board/docs/04-reference/03-http.md
```

Map each change to the spec section and the bordeaux code it affects.
[references/map.md](references/map.md) lists, for each upstream file bordeaux vendors, ports,
or relies on, where it lands in bordeaux and which spec section describes it. Keep a note per
change as you go: the upstream commit, what changed, what it touches here, and how you handled
it (vendored as is, ported, a new **Δ**, or nothing to do and why). That note becomes the pull
request's body.

- **`api/routes.ts`** is the route table: request and response shapes. A new or changed
  route changes [spec/01](../../spec/01-protocol.md)'s inventory, and may need a backend
  method.
- **`api/protocol.ts`** lists the protocol methods. A new method goes in
  `packages/bordeaux/src/worker/backend.ts` `METHODS` and needs a handler in the Durable
  Object (`src/engine/do.ts`, `engine.ts`).
- **`server/backend.ts`** is the `Backend` contract `durable()` implements. bordeaux doesn't
  vendor it: `src/upstream/server/backend.ts` is a shim that re-exports its types from
  `@vercel/board`, so `pnpm check` shows what no longer fits.
- **`contract/*`** is the data model: events, folds, schemas. Most of it is vendored, so the
  diff lands in `src/upstream/contract/`. A new event or fold can change what the DO writes
  and how its tables are built ([spec/02](../../spec/02-model.md)).
- **The conformance kit** (`src/conformance/`) is what CI runs against bordeaux. A new
  check is a behavior bordeaux must have; read it before you run it.

## 4. Bump and re-vendor

On a branch named `upstream/<version>`:

1. Set the new version in `packages/bordeaux/package.json`,
   `packages/create-bordeaux/template/package.json`, and `packages/hosted/package.json`
   (Dosu's hosted Worker), and `PIN` (version and the full
   `$NEW` commit) in `vendor-upstream.mjs`. Run `pnpm install`.
2. Check out the new commit and rerun the script:

   ```bash
   git -C "$UP" checkout "$NEW"
   pnpm --filter @dosu/bordeaux vendor "$UP"
   git diff --stat packages/bordeaux/src/upstream
   ```

   The script copies `FILES` byte for byte and warns if the checkout isn't the pin. Read
   every hunk it changed.
3. Fix what the new files import. A vendored file that now imports something not vendored
   needs it added to `FILES` (when it's pure: no A2, Vercel, or Node-only code at runtime) or
   a shim beside it that starts with `// SHIM (bordeaux)`. A file upstream removed comes out of
   `FILES` and `src/upstream/`.
4. Re-check every shim against the module it stands in for:
   `grep -rln "SHIM (bordeaux)" packages/bordeaux/src/upstream`. The shims are bordeaux's own
   code, so update them by hand, `version.ts`'s `VERSION` included.

## 5. Review the ports

`src/engine/` ports upstream functions that bordeaux can't vendor, mostly from
`server/a2.ts` (upstream's engine) and `server/writes.ts`. Each port names its upstream
function in its doc comment. List them:

```bash
grep -rn -E "upstream [a-z0-9/-]+\.ts" packages/bordeaux/src
git -C "$UP" diff "$OLD" "$NEW" -- packages/board/src/server/a2.ts packages/board/src/server/writes.ts \
  packages/board/src/server/watch.ts packages/board/src/server/trust.ts \
  packages/board/src/server/schedules.ts packages/board/src/server/access.ts
```

For each upstream function that changed, find its port and bring the behavior over. Port,
don't paraphrase: keep upstream's order of checks, its errors, and its edge cases. A **Δ**
stays unless upstream's change removed its reason; then drop it here and in the spec. A new
function that does protocol work gets a port with a doc comment naming it
(`(upstream a2.ts \`syncFind\`)`). When a port looks odd, read upstream at `$NEW` before
changing it.

## 6. Re-check every workaround

Each one depends on upstream details that can move without notice. The
[Q7 table](../../QUESTIONS.md#how-each-upstream-mismatch-is-handled-under-q7) lists them;
check each row still holds, and update the table when one changes.

- **Build-time aliases.** `@vercel/connect/chat` maps to bordeaux's stand-in
  (`src/sync/connect-chat.ts`) in `packages/bordeaux/wrangler.jsonc`, `test/wrangler.jsonc`,
  `vitest.config.ts`, and `packages/create-bordeaux/template/wrangler.jsonc`. Check what
  upstream imports from it, and that the stand-in exports every name:

  ```bash
  git -C "$UP" grep -n "@vercel/connect" "$NEW" -- packages/board/src
  ```

  A new import of a Vercel or Node-only module in code the Worker bundles needs a new alias
  in all four places, or a better seam (spec/00's order).
- **PATCHES.md.** Every `pnpm patch` is listed there with its reason, and in the root
  `package.json` under `pnpm.patchedDependencies`. There are none today. If there are, each
  must still apply (`pnpm install` fails otherwise) and still be needed: drop one upstream
  made unnecessary.
- **`waitUntil`.** `src/worker/index.ts` installs `Symbol.for('@vercel/request-context')`,
  which upstream's `server/wait-until.ts` (vendored) reads. Check the symbol and the shape
  it reads.
- **The inspector.** `wrangler.jsonc` serves upstream's prebuilt page from
  `node_modules/@vercel/board/dist/inspect`. Check `app.js` is still there, and diff
  `src/inspect/handler.ts`, `page.ts`, and `server.ts` for routes the page now calls: the
  hosted inspector's proxy (`src/worker/inspect.ts`) gives it nothing that isn't in the
  board's API.
- **What `bdx` relies on.** `bdx` (`src/cli/bdx.ts`) runs upstream's commands through
  `createApp({ appName: 'bdx' })` with `BOARD_URL` and a fresh `BOARD_TOKEN` set in-process
  ([spec/07](../../spec/07-clients.md#how-it-runs-a-command)). Diff:
  - `src/cli/embedded.ts`: `createApp`'s options, and that without `login` or `token` it
    still takes the token from `BOARD_TOKEN`; `teamBoard` and what it does with no URL.
  - `src/client/node.ts` `connect()`: when it reads `BOARD_TOKEN`, how long it caches a
    token, and when it reads the variable again. `bdx` refreshes it every 60 s and fetches
    one `EARLY_MS` before expiry; that must stay ahead of upstream's re-read.
  - `src/cli/commands.ts` and its flags: what `bdx` intercepts before `createApp` sees it
    (`list`, `--name`, `--scope`, `--ensure`, `grants create --github-user` and
    `--service`), and the help it prints after its own.

  If any of these changed, check `bdx` end to end with
  [verify-bordeaux](../../.claude/skills/verify-bordeaux/SKILL.md).
- **Upstream's skill and test fixtures.** `skills/board` and `test/sync-fixtures.ts` are
  adapted from upstream at the pin and say so in their headers. Port what changed in
  upstream's `skills/board` and `packages/board/test/sync-fixtures.ts`, and move their headers
  to `$NEW`.

## 7. Update the docs

Find every place that names the old version or commit:

```bash
git grep -n -e "<old version>" -e "<first 7 of OLD>" -- . ':!spike' ':!pnpm-lock.yaml'
```

`spike/` records what ran on the day; leave it. Update the rest, including:

- the spec: spec/00 (the version upstream is at), spec/01 (the protocol version), spec/07
  (what `bdx` relies on);
- AGENTS.md's pin, and PARITY.md's, which names the version it compares against;
- README.md and NOTICE (the commit, and its date in the README);
- `UPSTREAM_VERSION` in `src/worker/backend.ts`, and tests that name the version
  (`test/inspect.test.ts`);
- the Q7 table's header in QUESTIONS.md.

Then the substance. Each change from step 3 that bordeaux now handles updates its spec
section: a new route or field, a **Δ** with its reason, or an **As built** note where the code
differs from what the spec said. A change people can see gets a PARITY.md row.

## 8. Test

Add or update vitest tests for each behavior you ported: a test pins what a user can
observe, and fails without the change. Then run all three checks as CI does:

```bash
pnpm check
pnpm test
pnpm --filter @dosu/bordeaux conformance --groups core,paging,search,schedules,tasks,grants,schemas,attachments,watchers,sync
```

Conformance runs the new kit from `node_modules` against a fresh local board. Every group must
pass, sync included. A new check that fails is a parity gap: fix bordeaux, don't skip it. If a
check can't run where you are, say so in the pull request, with what you ran instead.

## Finish

One of three, each against `main`:

- **A pull request** when the upgrade is done and the checks pass. Title it
  `chore(upstream): upgrade @vercel/board to <version>`, or `feat(upstream): …` when users get
  something new. The body follows AGENTS.md: one line, then **Users**, **Protocol / parity**,
  **Performance / I/O**, and **Tests**. Under them, list each upstream change, how you handled
  it, and a link to its vercel/board commit.
- **A draft pull request** when you got part of the way but a change needs a person: a design
  decision, a new Cloudflare binding, a secret, a `pnpm patch`, or a check you couldn't make
  pass. Put what needs a person at the top of the body, then the same body as above.
- **An issue** titled `upstream <version> needs a person` when you couldn't produce useful
  code at all. Say what changed upstream, what it breaks here, and what you tried.
