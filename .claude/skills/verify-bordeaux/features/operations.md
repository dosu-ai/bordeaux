# Operations

What a person who manages a board uses to look after it: its health, what its queues gave up on,
retention, scrubbing a message that leaked a secret, and moving a board's whole log.

## Sub-features

- `ops-health`: queues, dead letters, timers, the code version, and sync.
- `ops-doctor`: whether the board's URL, the clock, and the token fit together.
- `ops-dead-letters`: what the queues gave up on.
- `ops-gc`: retention, now.
- `ops-redact`: scrub a message from the log, its copies, and the feed.
- `ops-export-import`: a board's log as JSON lines, into an empty board.

## How to get to it (user POV)

- `bdx health`, `bdx doctor`, `bdx dead-letters`, `bdx gc`, `bdx redact <id> --reason <why>`,
  `bdx redactions`, `bdx export`, `bdx import <file> --name <board>`.
- The `/admin/*` routes on the deployment's API.

## Driving it with verify.mjs

Preconditions:

- A fresh run, `doctor` exits 0.

- **Health.** Run `$V bdx -- health`. Exit 0: `queue nothing waiting`, `dead none`, `sync none
  configured`, and a `code` row with a version ID.
- **Doctor.** Run `$V bdx -- doctor`. Every row is `ok` but `dev fix`, which is right for a dev
  board. Exit 1 because of that row.
- **Dead letters and gc.** Run `$V bdx -- dead-letters` (`no dead letters`) and `$V bdx -- gc`
  (four rows, `0 removed` on a fresh board).
- **Redact.** Post `$V bdx -- post ops "the key is sk-test-NOTREAL" --json` and note `message.id`
  as `<id>`. Run `$V bdx -- redact <id> --reason "test secret"`. Exit 0, `events 1 rewritten`,
  `#<id> redacted`.
- **Gone from every view.** `$V http GET '/events?after=0&all=true'` no longer contains `NOTREAL`;
  `$V bdx --as 2:bea -- read <id> --json` shows `deleted` true and empty text; `$V bdx --
  redactions` lists `<id>`, ada, and the reason.
- **Export and import.** Run `$V bdx -- export > "$TMPDIR/board.jsonl"` and
  `$V bdx -- boards create copy`, then `$V bdx -- import "$TMPDIR/board.jsonl" --name copy`.
  `imported <n> events`, where n is the export's line count. Read a channel with `--name copy` to
  see the same threads.

## Gotchas

- A dev board has no grants, so every person manages everything here: `health` and `redact` work
  as bea too. Refusals for people who don't manage a board need grants made first
  (`bdx grants create`), and vitest covers them.
- `--everywhere` on `redact` needs a sync to a platform, which a local run lacks.
- `bdx export`'s output is also in the evidence file, so don't export a board holding real data.
- A redacted post's text is in the evidence file of the `post` that made it. Use made-up values.
