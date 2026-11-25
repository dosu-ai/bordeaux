---
name: verify-bordeaux
description: Start a throwaway local bordeaux board and drive it as people do, through the `bdx` CLI, the board's HTTP API, and the hosted inspector, recording each command as evidence. Use it to prove a change to the Worker, the board's Durable Object, or `bdx` works end to end, beyond what vitest shows, before you say it works.
---

# Verify bordeaux

bordeaux is upstream's board protocol on Cloudflare: a Worker, and a Durable Object per board.
People reach it through `bdx` (`packages/bordeaux/src/cli/bdx.ts`), which embeds upstream's
commands, and through its HTTP API and the inspector page at `/inspect`. This skill starts the
real Worker under `wrangler dev`, signs made-up people in through the dev route, and runs the
built `bdx` as them.

Everything goes through one helper, run from the repo root:

```bash
.claude/skills/verify-bordeaux/verify.mjs <command>
```

`pnpm install` must have run. Nothing here needs GitHub, Slack, or a Cloudflare account.

## Launch

```bash
eval "$(.claude/skills/verify-bordeaux/verify.mjs up)"
```

`up` builds `dist/bdx.mjs` (the file npm ships), starts `wrangler dev` on a free port with a fresh
`--persist-to` directory and `BORDEAUX_DEV=1`, and waits until the board answers discovery at its
own URL. It then signs in person `1:ada`. It prints `export BORDEAUX_VERIFY_RUN=<id>`; every other
command reads that variable. A tool whose shell forgets variables between calls sets it on each
command: `BORDEAUX_VERIFY_RUN=<id> verify.mjs doctor`. Ready takes 5 to 15 s.

Runs are isolated: each has its own port, state, and people, so two can run side by side. The
helper never drives `pnpm dev`'s board on 8790 or a deployed one.

## Doctor

```bash
.claude/skills/verify-bordeaux/verify.mjs doctor
```

Read-only. It checks that the run's `wrangler dev` is alive, that it (not another process) owns the
port, that discovery answers with the run's URL, which commit the run started at, that
`/admin/doctor` reports every binding, and that the dev sign-in route is on. Exit 1 on any `fix`.
Run it first, and again whenever something looks off. On `fix`, run `down`, then `up`.

## Drive

**`bdx`, as a person.** Everything after `--` is `bdx`'s own arguments:

```bash
V=.claude/skills/verify-bordeaux/verify.mjs
$V bdx -- post deploys "build 42 is green" --label env=prod --json
$V bdx --as 2:bea -- read deploys --json
```

`--as <github id>:<login>` picks the person; the first use signs them in through
`POST /__dev/token`, with their own config directory. The default is `1:ada`. Each person is a
plain team member with no `owner` claim. The helper clears `BOARD_URL`, `BOARD_TOKEN`,
`BOARD_NAME`, and `BOARD_PROFILE`, so your shell can't point `bdx` elsewhere. Use `--json` for
anything you assert on; the text output is for people and changes.

**The HTTP API, as a person**, for what `bdx` doesn't expose:

```bash
$V http GET '/events?after=0&all=true'
$V http --as 2:bea POST /messages '{"channel":"deploys","text":"from the API"}'
```

**The inspector** is a web page. Open `<board url>/inspect/login?id=1&login=ada` in the built-in
browser (the board URL is in `.verify/<run>/001-up.txt`): a dev board signs that person in with no
GitHub. Then read the page with `read_page`/`find`.

**Notes.** `$V note "<what you checked and saw>"` adds a line to the evidence, for what a browser
step showed.

The feature map, [features/README.md](features/README.md), has the recipe for each feature. Read
it before driving, and drive every entry point a feature lists.

## Evidence

Every `up`, `doctor`, `bdx`, `http`, and `note` writes a numbered file to `.verify/<run>/` at the
repo root (gitignored), with `log.txt` listing them in order. A `bdx` file has the command, the
person, stdout, stderr, and the exit code; an `http` file has the request and the response. `down`
adds the Worker's log. Tokens are replaced with `<jwt>` and `<refresh>`, and `verify.mjs bdx --
token` refuses to run.

A proof:

- Drives the real path: `bdx` or the HTTP API as a signed-in person, never the Durable Object's
  RPC methods, vitest helpers, or SQL.
- Shows the action and the state after it from a second view: post as one person, then read it
  back as another, or on `/events`.
- Checks side effects a person can see: the feed, `bdx health`, an export, a file's download.
- Shows refusals too: a 403 or a `bdx` error is evidence when the change is about access.

Sync to Slack, GitHub, and Linear can't be proven here: those need a deployed board and real apps
(docs/sync.md). Say so rather than counting a local run as a sync proof.

## Cleanup

```bash
.claude/skills/verify-bordeaux/verify.mjs down
```

`down` stops the process group `up` started (never by name), saves the Worker's log as evidence,
and deletes the run's state and people. `.verify/<run>/` stays. Run `down` after every run,
including a failed one, before starting another. Delete old `.verify/` runs by hand when you no
longer need them.

## Helpers

- [`verify.mjs`](verify.mjs) is the only helper. `verify.mjs` with no command prints its usage.
  The run's state lives in `$TMPDIR/bordeaux-verify-<run>/` (`run.json`, `state/`,
  `config-<id>/`, `wrangler.log`) until `down`.
