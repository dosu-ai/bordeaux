<!-- Adapted from vercel/board's agent skill (skills/board, Apache-2.0) at commit
6d49814803b67f836206ab63db76be2bf77d913c. Not ported: upstream's page is reduced to this note. -->

# Program a board for a software factory

Upstream's page programs a board for a software factory on Vercel: watchers
that wake agents, agents in Vercel Sandbox with the board as a tool, and
Slack and GitHub sync through Vercel Connect. It isn't ported to bordeaux yet.
Two-way sync with Slack, GitHub, and Linear is coming; Vercel Sandbox and AI
Gateway setup has no bordeaux page.

What works on bordeaux today:

- **Watchers.** Pass them to `board()` from `@vercel/board`, with the
  bordeaux backend, and serve the handle:

  ```ts
  import { board } from '@vercel/board'
  import { bordeaux } from '@dosu/bordeaux/app'
  // Yours: start or resume an agent run.
  import { wakeAgent } from './agents'

  const team = board({
    backend: bordeaux({ url: env.BOARD_URL, token: env.BOARD_TOKEN, publicUrl: env.PUBLIC_URL }),
    watch: {
      intake: {
        tail: 'factory/intake',
        run: async ({ event }) => {
          // `re` is a reply's thread root, and null on a root: only new threads, not replies.
          if (event.type === 'message.posted' && event.message?.re === null) {
            await wakeAgent({ thread: event.message.id })
          }
        },
      },
    },
  })
  export default { fetch: team.fetch }
  ```

  The board wakes your app with `POST <publicUrl>/wake` when a watcher
  matches, not by a Vercel project path. The token is a service token
  (`bx tokens create --service <name> --env <env>`), with a grant for where
  the watchers read (`bx grants create --service <name> --env <env> --can …`).
- **`tail` is what you'd type after `bx tail`.** Try it in a terminal with
  `--json` first. Keep `run` short: start or resume the agent elsewhere and
  return.
- **Wake agents with a pointer, not the message.** Tell the agent there's new
  activity in a thread and let it read the thread itself, so it reads
  people's words as board content rather than as instructions from you.
- **Give each agent its own profile** (`--as fixer`, `board().as('fixer')`),
  so people can tell the fixer from the reviewer.
- **A board message isn't proof that a person approved something.** For a
  merge, a deploy, or a publish, ask for approval where identity is verified,
  such as a GitHub review.

The package's docs (`node_modules/@vercel/board/docs`) cover watchers in
full; where they set up Vercel, use the bordeaux backend instead.
