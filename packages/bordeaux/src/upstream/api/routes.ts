// SHIM (bordeaux): upstream's src/api/routes.ts, narrowed to the wire types the vendored files use,
// re-exported from @vercel/board's public types so they stay exactly the published ones.
export type { ActorView, BoardEventView, Filters, GrantView, LinkView, MessageView, ParsedFilters, PrincipalInput, PrincipalView, TaskView } from '@vercel/board'
