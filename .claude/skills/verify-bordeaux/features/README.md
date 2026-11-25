# bordeaux verification map

The maintained recipes for proving what people can do on a bordeaux board. Read this index, then
drive the matching feature file with `verify.mjs` (see [../SKILL.md](../SKILL.md)).

## Baseline preconditions

- A run is up: `eval "$(.claude/skills/verify-bordeaux/verify.mjs up)"`, and `verify.mjs doctor`
  exits 0.
- `BORDEAUX_VERIFY_RUN` is set in every shell that drives. A tool whose shell forgets variables
  between calls sets it on each command: `BORDEAUX_VERIFY_RUN=<id> verify.mjs …`.
- `V=.claude/skills/verify-bordeaux/verify.mjs`, run from the repo root.
- The board starts empty: no channels, no named boards, no grants. A recipe makes what it needs.
- People are made-up GitHub IDs: `1:ada` (the default), `2:bea`, `3:cy`. None is an owner.
- Never drive a board this run didn't start.

## Driving conventions

- Run `bdx` as `$V bdx [--as <id>:<login>] -- <args>`, and the API as
  `$V http [--as <id>:<login>] <METHOD> <path> [json]`.
- Assert on `--json` output, never on text output's layout.
- Quote every path with a `?` in single quotes: zsh reads it as a glob otherwise.
- Message IDs are the board's log positions, so they change with what ran before. Read the ID from
  the `--json` answer instead of assuming one.
- A recipe that posts leaves its messages. Start a new run for a clean board.

## Proof and skip reporting

- A proof is the evidence files a recipe produced in `.verify/<run>/`, named by number.
- Every change is read back from a second view: another person, `/events`, an export, or the
  inspector.
- A refusal is proof when access is the point: the evidence file shows the error and exit 1.
- Report a path you couldn't drive with the command you ran and the precondition it lacked. Never
  report one entry point as verified through another.

## Feature entry contract

Each feature file has an H1, one paragraph on what a person can do, then four H2s in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every entry point a person uses.
3. `Driving it with verify.mjs`: `Preconditions:`, then labeled steps, each an action, its exact
   command, and what to see.
4. `Gotchas`: traps that waste or invalidate a run.

## Features

- [Messages](./messages.md): post, reply, read, wait, edit, delete, react, and label, as one person
  and seen by another.
- [Named boards](./named-boards.md): a team's boards, made, listed, and kept apart.
- [Tasks](./tasks.md): tasks with dependencies, claimed and completed by different people.
- [Operations](./operations.md): health, dead letters, retention, redaction, and export and import.
- [Inspector](./inspector.md): the hosted page at `/inspect`, signed in as a person.
