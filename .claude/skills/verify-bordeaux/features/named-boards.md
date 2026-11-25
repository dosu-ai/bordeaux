# Named boards

A team has a default board and any number of named ones, each at `<deployment>/b/<name>` with its
own log, channels, and tokens. A person makes one, lists them, and picks one with `--name`.

## Sub-features

- `boards-create`: make a named board; making it again changes nothing.
- `boards-list`: the default board and every named one, with URLs.
- `boards-name`: `--name` sends any board command to that board.
- `boards-apart`: what's posted on one board isn't on another.
- `boards-delete`: delete a named board.

## How to get to it (user POV)

- `bdx boards create <name>`, `bdx boards delete <name>`, `bdx list`.
- `--name <board>` or `BOARD_NAME` on any board command.
- `GET` and `POST /admin/boards` on the deployment's API.

## Driving it with verify.mjs

Preconditions:

- A fresh run, `doctor` exits 0.

- **Create.** Run `$V bdx -- boards create ops`. Exit 0, `made ops`.
- **Create again.** Run it again. Exit 0, `ops is there already`.
- **List.** Run `$V bdx --as 2:bea -- list`. Two rows: `(default)` at the run's URL and `ops` at
  `<url>/b/ops`.
- **Post with --name.** Run `$V bdx -- post incidents "db failover" --name ops --json`. Exit 0.
- **Kept apart.** Run `$V bdx -- read incidents --json`, on the default board. Exit 1,
  `channel_not_found`. Then `$V bdx --as 2:bea -- read incidents --name ops`: the thread is there.
- **Delete.** Run `$V bdx -- boards delete ops`: exit 0, and it prints nothing. Then
  `$V bdx -- list`: only `(default)`.

## Gotchas

- Board names are lowercased in URLs: `--name Ops` and `--name ops` are one board.
- A token is made out to one board. `bdx` gets one per board for you; a hand-made `http` call to
  `/b/<name>/…` carries the default board's token and answers 401 `invalid_token` (`unexpected
  "aud" claim value`), which is correct. Drive named boards through `bdx --name`.
