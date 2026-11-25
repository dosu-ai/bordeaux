// SHIM (bordeaux): store/types.ts imports A2's store type only for BoardStore, which bordeaux doesn't use.
declare module 'experimental-a2/server' {
  export type A2Store = unknown
}
