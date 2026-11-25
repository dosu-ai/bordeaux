// Who a caller is, as it crosses from the Worker to the board's Durable Object. board() hands the
// backend a caller whose access is a compiled object; RPC carries data, so the Worker sends its
// summary and the DO compiles it again (`compileAccess` is upstream's public API).
import type { Caller, Identity, SelfCaller } from '@vercel/board'
import { compileAccess, FULL_ACCESS, parseCan, type AccessSummary } from '@vercel/board/access'
import { badRequest } from '../upstream/server/errors.ts'

/** An identity as RPC carries it. */
export type WireIdentity = {
  principal: Omit<Identity['principal'], 'access'> & { can: AccessSummary }
  author: Identity['author']
  actor: Identity['actor']
  /** A request board() verified, as opposed to the board's own code writing in-process. */
  request: boolean
  /** Set when a schedule's send posts. */
  schedule?: { id: number; n: number }
  /** How the board's own code is writing, when it is: `engine` is board()'s own sync. */
  via?: string
}

/** The board's own code, through its handle: `board:client`, or `board:client:<profile>` with `as(profile)`. */
const CLIENT_ACTOR = 'board:client'
const MIDDLEWARE_ACTOR = 'board:middleware'
const SYNC_ACTOR = 'board:sync'
/** A watcher's or a handle profile's name (upstream src/server/watch.ts `ID`). */
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** A piece of the board's own deployment, writing as `actor` with full access (upstream writes.ts). */
export function deploymentIdentity(actor: string, handle: string): Identity {
  return {
    principal: { id: actor, kind: 'deployment', handle, access: FULL_ACCESS, expiresAt: null },
    author: { actor, principal: actor, profile: null },
    actor: { id: actor, kind: 'deployment', handle, name: handle, avatar: null },
  }
}

/** Who the board's own code is, before a handle's `can` narrows it (upstream a2.ts `ownIdentity`). */
function ownIdentity(caller: SelfCaller): Identity {
  const { self, origin } = caller
  if (origin.via?.kind === 'watcher') return deploymentIdentity(`board:watch:${self}`, self ?? 'watch')
  if (origin.via?.kind === 'middleware') return deploymentIdentity(MIDDLEWARE_ACTOR, 'middleware')
  if (origin.via?.kind === 'engine') return deploymentIdentity(SYNC_ACTOR, 'sync')
  if (self === null) return deploymentIdentity(CLIENT_ACTOR, 'client')
  if (!ID.test(self)) throw badRequest(`as: profiles use lowercase letters, numbers, - and _, got: ${self}`)
  return deploymentIdentity(`${CLIENT_ACTOR}:${self}`, self)
}

/** Who a caller is, and what it may do now (upstream a2.ts `identityOf`). */
export function identityOf(caller: Caller): Identity {
  if ('identity' in caller) return caller.identity
  const identity = ownIdentity(caller)
  if (caller.can === undefined) return identity
  const { principal } = identity
  return { ...identity, principal: { ...principal, scope: caller.can, access: principal.access.narrow(parseCan(caller.can)) } }
}

/** A request, as opposed to a write the board's own code makes in-process (upstream a2.ts `fromRequest`). */
const fromRequest = (caller: Caller) => 'identity' in caller && (caller.origin.via?.kind ?? 'api') === 'api'

export function toWire(caller: Caller): WireIdentity {
  const { principal, author, actor } = identityOf(caller)
  const { access, ...rest } = principal
  const { schedule } = caller.origin
  return {
    principal: { ...rest, can: access.summary() },
    author,
    actor,
    request: fromRequest(caller),
    ...(schedule && !fromRequest(caller) ? { schedule } : {}),
    ...(caller.origin.via?.kind ? { via: caller.origin.via.kind } : {}),
  }
}

export function fromWire(wire: WireIdentity): Identity & { request: boolean; schedule?: { id: number; n: number }; via?: string } {
  const { can, ...principal } = wire.principal
  return {
    principal: { ...principal, access: compileAccess(can) },
    author: wire.author,
    actor: wire.actor,
    request: wire.request,
    ...(wire.schedule ? { schedule: wire.schedule } : {}),
    ...(wire.via ? { via: wire.via } : {}),
  }
}
