// The "app" side of the ctx.props check: it can only set props in its own wrangler config.
type Env = { BOARD: Fetcher & { whoAmI(): Promise<{ props: unknown }> } }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const rpc = await env.BOARD.whoAmI()
    const viaFetch = await (await env.BOARD.fetch('http://board/__spike/props')).json()
    const discovery = await (await env.BOARD.fetch('http://board/')).json()
    return Response.json({ rpc, viaFetch, discovery })
  },
} satisfies ExportedHandler<Env>
