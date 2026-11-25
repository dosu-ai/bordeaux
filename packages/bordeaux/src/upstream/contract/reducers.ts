// SHIM (bordeaux): upstream's reducers are A2 reducers. bordeaux keeps these views in tables, and its
// session (src/engine/session.ts) recognizes each by name.
export const channelsReducer = { name: 'board.channels' } as const
export const actorsReducer = { name: 'board.actors' } as const
