// The board's grants, as session `access` of its log keeps them. Ported from upstream's
// src/server/trust.ts at the pinned commit (the fold, the starting grants, and the views), without
// A2: the board's DO folds the session, and the Worker judges grant writes (src/worker/trust.ts).
import type { GrantView, PrincipalView } from '@vercel/board'
import { z } from 'zod'
import type { WrittenCan } from '../upstream/server/access.ts'
import type { GrantPrincipal, StoredGrant } from '../upstream/server/auth.ts'

export const ACCESS_SESSION = 'access'

/** A grant as the fold keeps it: `event` is the index of the event that made it, null for a starting one. */
export type GrantRow = { id: number; event: number | null; principals: GrantPrincipal[]; can: WrittenCan; by: string | null; at: number | null }
export type AccessState = { grants: Record<string, GrantRow>; nextGrant: number }

/** The grants a board starts with, as upstream's do: g1 people, g2 projects, g3 apps (spec 03). */
const STARTING_GRANTS: Record<string, GrantRow> = {
  1: { id: 1, event: null, principals: [{ kind: 'all-users' }], can: { '*': 'all' }, by: null, at: null },
  2: { id: 2, event: null, principals: [{ kind: 'all-projects', environments: ['production', 'preview', 'development'] }], can: { '*': ['read', 'post', 'react', 'label', 'sync'] }, by: null, at: null },
  3: { id: 3, event: null, principals: [{ kind: 'all-apps' }], can: { '*': ['read', 'post', 'react', 'label'] }, by: null, at: null },
}

export const startingAccess = (): AccessState => ({ grants: structuredClone(STARTING_GRANTS), nextGrant: 4 })

/** **Δ g4**: every bordeaux service token, with the reach a Vercel team's projects get (spec 03). */
export const serviceGrant = (issuer: string) => ({
  principals: [{ kind: 'oidc' as const, issuer, claims: { sub: 'service:*' } }],
  can: { '*': ['read', 'post', 'react', 'label', 'sync'] } as WrittenCan,
})

type AccessEvent =
  | { type: 'grant.created'; index: number; createdAt: Date; payload: { principals: GrantPrincipal[]; can: WrittenCan; by: string } }
  | { type: 'grant.updated'; index: number; createdAt: Date; payload: { id: number; principals: GrantPrincipal[]; can: WrittenCan; by: string } }
  | { type: 'grant.deleted'; index: number; createdAt: Date; payload: { id: number; by: string } }

/** Upstream's access fold. */
export function foldAccess(state: AccessState, event: AccessEvent): AccessState {
  const at = new Date(event.createdAt).getTime()
  switch (event.type) {
    case 'grant.created': {
      const id = state.nextGrant++
      state.grants[id] = { id, event: event.index, principals: event.payload.principals, can: event.payload.can, by: event.payload.by, at }
      break
    }
    case 'grant.updated': {
      const row = state.grants[event.payload.id]
      if (row) Object.assign(row, { principals: event.payload.principals, can: event.payload.can, by: event.payload.by, at })
      break
    }
    case 'grant.deleted':
      delete state.grants[event.payload.id]
      break
  }
  return state
}

/** The access session's events, checked as they're appended (upstream src/contract/contract.ts). */
const ActorId = z.string().min(1).max(500)
const Permission = z.enum(['read', 'post', 'react', 'label', 'sync', 'manage'])
const GrantCan = z.record(z.string().min(1).max(200), z.union([z.literal('all'), z.array(Permission)]))
const Principals = z.array(z.looseObject({ kind: z.string() })).min(1).max(32)
export const accessEvents = {
  'grant.created': z.object({ principals: Principals, can: GrantCan, by: ActorId }),
  'grant.updated': z.object({ id: z.number().int().positive(), principals: Principals, can: GrantCan, by: ActorId }),
  'grant.deleted': z.object({ id: z.number().int().positive(), by: ActorId }),
}

export const grantId = (id: number) => `g${id}`
/** The index a grant's ID names: `g12` for 12. Null for one that names none. */
export function grantIndex(id: string): number | null {
  const found = /^g([1-9]\d{0,15})$/.exec(id)
  return found ? Number(found[1]) : null
}

/** A principal as views show it. */
function principalView(principal: GrantPrincipal): PrincipalView {
  switch (principal.kind) {
    case 'user':
      return { kind: 'user', userId: principal.userId, email: principal.email ?? null }
    case 'project':
      return { kind: 'project', projectId: principal.projectId, name: principal.name ?? null, environments: [...principal.environments], teamId: principal.teamId ?? null }
    case 'github':
      return { ...principal, repositoryId: principal.repositoryId ?? null }
    case 'oidc':
      return { kind: 'oidc', issuer: principal.issuer, claims: Object.fromEntries(Object.entries(principal.claims).map(([name, value]) => [name, typeof value === 'string' ? value : [...value]])) }
    case 'all-projects':
      return { kind: 'all-projects', environments: [...principal.environments] }
    case 'app':
      return { kind: 'app', clientId: principal.clientId, name: principal.name ?? null }
    default:
      return { kind: principal.kind } as PrincipalView
  }
}

export const grantView = (row: GrantRow): GrantView => ({
  id: grantId(row.id),
  principals: row.principals.map(principalView),
  can: Object.fromEntries(Object.entries(row.can).map(([pattern, grant]) => [pattern, grant === 'all' ? 'all' : [...grant]])) as GrantView['can'],
  // A bordeaux board has no team roles.
  capped: false,
  by: row.by,
  at: row.at === null ? null : new Date(row.at).toISOString(),
})

export const storedGrant = (row: GrantRow): StoredGrant => ({ id: grantId(row.id), principals: row.principals, can: row.can })
