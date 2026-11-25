# Tasks

A thread can be a task with a state the board keeps: ready, claimed, completed, failed, blocked, or
waiting on the tasks it needs. A person creates tasks, another claims one for a lease, and
completing it makes what needs it ready.

## Sub-features

- `tasks-create`: a task, with labels and `--needs`.
- `tasks-list`: open tasks in a channel, oldest first, with their states.
- `tasks-claim`: hold a task by ID, or the oldest ready one with `--ready`.
- `tasks-complete`: finish a held task; what needed it becomes ready.
- `tasks-refused`: completing a task you don't hold is refused.

## How to get to it (user POV)

- `bdx tasks create`, `bdx tasks [channel]`, `bdx tasks claim`, `bdx tasks complete`, and the
  other `bdx tasks` commands (`bdx --help`).
- The inspector shows each task's state.

## Driving it with verify.mjs

Preconditions:

- A fresh run, `doctor` exits 0.

- **Create.** Run `$V bdx -- tasks create work "fix the build" --label step=fix --json`. Note
  `task.id` as `<fix>`; its `labels["board.task"]` is `ready`.
- **Create a dependent.** Run `$V bdx -- tasks create work "review the fix" --needs <fix> --json`.
  Note `task.id` as `<review>`.
- **List.** Run `$V bdx -- tasks work`. `<fix>` is `ready`, `<review>` is `waiting` and
  `needs #<fix>`.
- **Complete refused.** Run `$V bdx --as 2:bea -- tasks complete <fix> "done"`. Exit 1, `You hold
  no claim on task`.
- **Claim by ID.** Run `$V bdx --as 2:bea -- tasks claim <fix> --json`. Exit 0, the label
  `board.task` is `claimed`.
- **Complete.** Run `$V bdx --as 2:bea -- tasks complete <fix> "fixed in a1b2c3"`. Exit 0.
- **What it unblocked.** Run `$V bdx -- tasks work --state all`. `<fix>` is `completed` with its
  result, `<review>` is `ready`.
- **Claim the next ready one.** Run `$V bdx -- tasks claim --ready work/ --json`. Exit 0, the task
  is `<review>`.

## Gotchas

- `tasks claim --ready work` (no slash) answered `nothing_ready` while a task in `work` was ready;
  `--ready work/` claimed it. Pass the channel with its trailing slash.
- `tasks work` lists open tasks only. Add `--state all` to see completed ones.
- A claim is a lease. A recipe that pauses for minutes should `tasks renew` before it completes.
