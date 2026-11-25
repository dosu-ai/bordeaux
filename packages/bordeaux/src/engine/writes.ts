// The write helpers upstream's tasks.ts imports from its src/server/writes.ts, on the board's DO.
// The DO is the log's only writer, so `appendFrom` looks and appends in its write lock and never has
// to look again, and its appends apply the tables before they return (`untilApplied` has nothing to wait for).
import type { Identity } from '@vercel/board'
import type { BoardEvent } from '../upstream/contract/events.ts'
import type { ActorsState, ChannelsState, Message, Task } from '../upstream/contract/folds.ts'
import { authorize, type Access, type Permission } from '../upstream/server/access.ts'
import { actorSeen, ownedActor } from '../upstream/server/actors.ts'
import { wroteAs } from '../upstream/server/auth.ts'
import { notFound } from '../upstream/server/errors.ts'
import type { Reader } from '../upstream/server/feed.ts'
import type { MessageFilter, MessageTables, Page } from '../upstream/store/types.ts'
import type { NewEvent } from './log.ts'

export type { Identity }
export type Events = NewEvent[]

/** More events for a root's own append, given the ID and thread key it will have (upstream `Along`). */
export type Along = () => Promise<{ position: number; events: (root: { id: number; thread: string }) => Events }>
/** The same, for several roots' one append (upstream `AlongEach`). */
export type AlongEach = () => Promise<{ position: number; counts: readonly number[]; events: (roots: readonly { id: number; thread: string }[]) => Events[] }>

/** What a write reads and appends through: the shape upstream's tasks.ts takes, on the DO. */
export type WriteContext = {
  session: { state<N extends string>(reducer: { name: N }): Promise<{ state: N extends 'board.actors' ? ActorsState : ChannelsState; index: number }> }
  reads: {
    tables: MessageTables
    message(id: number): Promise<Message | null>
    position(): Promise<number>
    roots(filter: MessageFilter, page: Page): Promise<Awaited<ReturnType<MessageTables['roots']>>>
    reader(access: Access, messages: Iterable<Message>): Promise<Reader>
  }
  /** Appends in the board's write lock, after everything before it. */
  exclusive<T>(write: () => Promise<T>): Promise<T>
  /** Appends to the board's session, folding and applying the tables in the same step. */
  append(events: Events): Promise<BoardEvent[]>
}

/** Looks at the board and appends what it decides, in one step of the write lock. */
export async function appendFrom(ctx: WriteContext, look: () => Promise<{ position: number; events: Events }>): Promise<BoardEvent[]> {
  return ctx.exclusive(async () => {
    const { events } = await look()
    return events.length === 0 ? [] : ctx.append(events)
  })
}

/** The DO applies each write to the tables before it returns. */
export async function untilApplied(_ctx: WriteContext, _rows: readonly { index: number }[]) {}

/** What a look throws when its reads don't reflect one index: on the DO they always do. */
export const movedOn = () => Object.assign(new Error('the board moved on while a write read it'), { code: 'LAST_INDEX_MISMATCH' })

/** A message the caller may act on with `permission`; one it can't read answers 404 (upstream writes.ts). */
export async function authorizeMessage(ctx: WriteContext, access: Access, permission: Permission, id: number) {
  const message = await ctx.reads.message(id)
  const missing = () => notFound(`message not found: #${id}`, 'message_not_found')
  if (!message) throw missing()
  return { message, proof: authorize(access, permission, message.channel, missing) }
}

/** Whether `identity` is a task's owner (upstream writes.ts `ownedBy`). */
export const ownedBy = (task: Pick<Task, 'owner' | 'by'>, identity: Pick<Identity, 'principal' | 'actor'>) => wroteAs(identity, { principal: task.owner, actor: task.by })

/** Whether the board checked who a write is by, as it shows them (upstream writes.ts `verifiedAs`). */
function verifiedAs({ principal, author, actor }: Identity): boolean {
  if (principal.kind === 'external') return (actor as { verified?: true }).verified === true
  if (principal.id.startsWith('board:')) return false
  const named = ownedActor(principal, author, actor)
  return named.handle === actor.handle && named.name === actor.name && named.avatar === actor.avatar && named.via?.name === actor.via?.name && named.via?.environment === actor.via?.environment
}

/** The `actor.seen` a write carries, or null when the board knows its author already (upstream writes.ts `seenFor`). */
export function seenFor(identity: Identity, actors: ActorsState) {
  const { verified: _verified, ...actor } = identity.actor as Identity['actor'] & { verified?: true }
  return actorSeen(verifiedAs(identity) ? { ...actor, verified: true } : actor, actors, identity.principal.facts?.issuer === 'host')
}
