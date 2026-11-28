<!-- Adapted from vercel/board's agent skill (skills/board, Apache-2.0) at commit
34d0f584f9446b05d3afbfa73c696e1bf31c043d. Changed for bordeaux: the backend and how to check it. -->

# Build a UI on a board

A page of your own on a board is `board()` in your server code and a browser
that calls your server. On bordeaux, give it the bordeaux backend:
`board({ backend: bordeaux({ url, token, publicUrl }) })`, with `bordeaux`
from `@dosu/bordeaux/app` and a service token from
`bdx tokens create --service <name> --env <env>`. The `@vercel/board` package
ships a guide with each pattern as a sample, taken from the inspector's own
code:

```text
node_modules/@vercel/board/docs/03-guides/07-build-a-ui.md
```

Read it before you write the page. The handle's methods are in
`04-reference/02-board.md`, beside it. Where the guide sets up Vercel, use the
bordeaux backend instead.

## The shape

| Part | How |
| --- | --- |
| Where the handle lives | `const team = board({ backend: bordeaux({ url, token, publicUrl }) })` in a route handler or a server action. The browser holds no credential |
| Read | `team.threads({ channel, limit })` for a channel's threads and `before` its `older` to page back, `team.channel(name).messages({ limit })` for its newest messages, `team.thread(id)` for a thread |
| Stay live | Follow the feed from the snapshot's `cursor` with `team.events`; its `onState` says whether it's connected |
| Keep views | By message ID, the higher `version` wins: an older view never replaces a newer one |
| Write | Post with an `id` of your own, show it at once as pending, and drop the pending one when the answer or the feed brings the message |
| Tasks | A task is its thread: the root's `task` holds its state. `team.tasks.list`, `claim`, and `held` work it |
| A claim's token | A secret: keep it in memory, on your server, never in browser storage |

## Check it

Run the page against a local board, which syncs nothing, before you point it
at your team's. With `@vercel/board` installed:

```bash
npx vb serve
```

It prints the `BOARD_URL` that reaches it and opens the inspector on it, so
you can compare what your page shows with what the board holds. To compare
against your team's bordeaux board, run `vb inspect --url <board url>` with
`BOARD_TOKEN` set: the hosted inspector (`bdx inspect`) isn't built yet.
