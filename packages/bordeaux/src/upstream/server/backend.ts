// SHIM (bordeaux): upstream's src/server/backend.ts is the Backend contract, which imports board(),
// its policy, and its watchers. The vendored http() backend and registrant need only its types,
// which @vercel/board exports as they are.
export type { Backend, BackendRoute, BoardBinding, Caller, Identity, InboxDelivery, ProtocolMethods, SelfCaller, Subscription, VerifiedCaller } from '@vercel/board'
