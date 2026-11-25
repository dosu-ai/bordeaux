# Messages

A person posts a thread to a channel, others read it, reply, and wait for what comes next. Its
author can edit or delete it; anyone can react or label it.

## Sub-features

- `msg-post`: a new thread in a channel, with labels.
- `msg-reply`: a reply in a thread.
- `msg-read`: a channel's latest threads, or one thread with every reply.
- `msg-wait`: block until the next matching event, from a cursor.
- `msg-edit`: the author changes the text; anyone else is refused.
- `msg-delete`: the author leaves a tombstone.
- `msg-react-label`: a reaction and a label on someone else's message.
- `msg-api`: the same post through `POST /messages`, seen on `/events`.

## How to get to it (user POV)

- `bdx post <channel> <text>`, `bdx reply <id> <text>`, `bdx read [channel|id]`,
  `bdx wait <channel> --after <cursor>`, `bdx edit`, `bdx delete`, `bdx react`, `bdx label`.
- `POST /messages` and `GET /events` on the board's API, as `vb` and `board()` use them.
- The inspector's composer (see [inspector.md](./inspector.md)).

## Driving it with verify.mjs

Preconditions:

- A fresh run, `doctor` exits 0.

- **Post.** As ada, run `$V bdx -- post deploys "build 42 is green" --label env=prod --json`. Exit
  0, `outcome` is `posted`, `message.labels.env` is `prod`. Note `message.id` as `<root>`.
- **Read as another person.** Run `$V bdx --as 2:bea -- read deploys --json`. `threads[0].message`
  has the same ID, text, and `by.principal` `bordeaux:user:1`. Note `cursor`.
- **Wait, then reply.** In the background, run
  `$V bdx --as 2:bea -- wait deploys --after <cursor> --timeout 30s --json`. Then, as ada, run
  `$V bdx -- reply <root> "rolling out now" --json`. The wait exits 0 with an `event` of type
  `message.posted` whose `payload.re` is `<root>`.
- **Read the thread.** Run `$V bdx --as 2:bea -- read <root>`. The root and the reply, `↳`, by ada.
- **Edit refused.** Run `$V bdx --as 3:cy -- edit <root> "not mine"`. Exit 1, `only the author can
  edit a message`.
- **Edit.** Run `$V bdx -- edit <root> "build 42 is green, shipping"`, then read it as bea: the new
  text, with `editedAt` set in `--json`.
- **React and label.** As bea, run `$V bdx --as 2:bea -- react <root> 🚀` and
  `$V bdx --as 2:bea -- label <root> owner=bea`. Read as ada with `--json`: `reactions.rocket` is
  `["bordeaux:user:2"]`, and `labels.owner` is `bea`.
- **Delete.** As ada, run `$V bdx -- delete <root>`. Read `<root>` as bea with `--json`:
  `message.deleted` is true, its text is empty, and the reply is still there.
- **API.** Run `$V http --as 2:bea POST /messages '{"channel":"deploys","text":"from the API"}'`,
  then `$V http GET '/events?after=<cursor>&all=true'`. The post is a `message.posted` event by
  `bordeaux:user:2`.

## Gotchas

- `bdx read <channel>` answers `channel_not_found` for a channel on another board: check `--name`.
- `wait` with no `--after` waits from now, so start it before the post, or pass the cursor from a
  read.
- Two `verify.mjs` commands at once may number their evidence files out of order; `log.txt` keeps
  the real order.
- Everything posted stays in the evidence. Post made-up values only, never a real secret.
