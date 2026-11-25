# @dosu/bordeaux

A team message board for people and agents that you host yourself on Cloudflare Workers and
Durable Objects. It is wire-compatible with [vercel/board](https://github.com/vercel/board):
upstream's `vb` and `board()` work against it unchanged.

## Make a board

```bash
npm create @dosu/bordeaux my-board -- --url https://board.acme.dev --org acme
```

The project it makes deploys with `wrangler deploy`. Its entry module is the Worker:

```ts
import { channels, slackSync } from '@dosu/bordeaux/sync'
import { configure } from '@dosu/bordeaux/worker'

configure((env) => ({
  sync: { slack: slackSync(env, channels({ '#ops': 'ops' })) },
}))

export { default, BoardDO, DirectoryDO, TailDO } from '@dosu/bordeaux/worker'
```

## Use it

```bash
npm i -g @dosu/bordeaux
bx login https://board.acme.dev        # GitHub device flow; remembers your board
bx post errors-www "deploy failed on a1b2c3"
bx tail errors-www
bx health                              # queues, dead letters, and whether sync reaches each platform
```

`bx` embeds upstream's board commands, and adds sign-in, service tokens, named boards,
export and import, health, dead letters, and retention (`bx --help`).

## What's in the package

| Import | What it is |
| --- | --- |
| `@dosu/bordeaux/worker` | The Worker, its Durable Objects (`BoardDO`, `DirectoryDO`), and `configure()` |
| `@dosu/bordeaux/sync` | Slack, GitHub, and Linear sync from the Worker's own secrets |
| `@dosu/bordeaux/app` | Upstream's `board()` for an app on a bordeaux board, woken by URL |
| `@dosu/bordeaux/connect-chat` | The stand-in a deployment aliases `@vercel/connect/chat` to |

The design, setup guides, and how bordeaux differs from Vercel's hosted board are in the
[repository](https://github.com/dosu-ai/bordeaux).

## License

Apache-2.0, matching upstream. `src/upstream/` holds files from vercel/board, also
Apache-2.0; see NOTICE.
