// SHIM (bordeaux): the parts of upstream's src/server/auth.ts the vendored files use. Types come from
// @vercel/board/access; `wroteAs` is copied from auth.ts at the pinned commit (Apache-2.0).
export type { Claims, Principal } from '@vercel/board/access'

/** Whether `caller` wrote `by`: its principal did, as itself, or as the profile it writes as now. */
export const wroteAs = (caller: { principal: { id: string }; actor: { id: string } }, by: { principal: string; actor: string }) =>
  by.principal === caller.principal.id && (caller.actor.id === caller.principal.id || by.actor === caller.actor.id)
