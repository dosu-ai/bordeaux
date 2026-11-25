// `durable()`: bordeaux's Backend for upstream's board(). Each protocol method runs in the board's
// Durable Object; `discovery` and `me` need nothing the board keeps, so the Worker answers them.
import { HttpError, type Backend, type BoardBinding, type Caller, type Discovery, type Me } from '@vercel/board'
import { identityOf, toWire } from '../engine/identity.ts'
import type { Envelope } from '../engine/do.ts'
import type { BordeauxEnv } from './env.ts'

/** The upstream version bordeaux speaks the protocol of (spec 00). */
export const UPSTREAM_VERSION = '0.56.1'

/** Every protocol method, as upstream's src/api/protocol.ts lists them at the pinned commit. */
const METHODS = 'discovery me channels createChannel actors channelMessages threads message post posted edit delete react label schedule schedules cancelSchedule tasks createTask createTasks createdTasks claimReadyTask claimTask renewTask releaseTask completeTask failTask blockTask unblockTask reopenTask assignTask setTaskNeeds cancelTask grants createGrant createGrants updateGrant explain revokeGrant schemas schema createSchema upload attachment uploadStart uploadFinish watchers register matches ack events typing readSource joinSource synced linked syncImport syncReceipt syncThread syncFind syncCopies inboxPush inboxNext inboxAck inbox'.split(' ')

/**
 * The grants a board starts with, as upstream's do (src/server/trust.ts): g1, every person may do
 * everything; g2 and g3 name projects and apps, which a bordeaux board has none of. Kept grants
 * arrive with the grants milestone (M2).
 */
const STARTING_GRANTS = [
  { id: 'g1', principals: [{ kind: 'all-users' as const }], can: { '*': 'all' as const } },
  { id: 'g2', principals: [{ kind: 'all-projects' as const, environments: ['production', 'preview', 'development'] }], can: { '*': ['read', 'post', 'react', 'label', 'sync'] as const } },
  { id: 'g3', principals: [{ kind: 'all-apps' as const }], can: { '*': ['read', 'post', 'react', 'label'] as const } },
]

/** The Durable Object a board lives in: one team per deployment for now (Q4), keyed so more can come. */
export const boardKey = (name: string | null) => `default/${(name ?? 'default').toLowerCase()}`

export function durable(env: BordeauxEnv): Backend {
  let binding: BoardBinding | null = null
  const stub = () => env.BOARD.get(env.BOARD.idFromName(boardKey(binding?.name ?? null)))

  const discovery = async (): Promise<Discovery> => ({
    version: UPSTREAM_VERSION,
    url: env.BORDEAUX_URL,
    audience: env.BORDEAUX_URL,
    team_id: null,
    // No Vercel project: clients send the token they have rather than mint one through Vercel.
    project_id: null,
    sync: [],
  })

  const me = async (caller: Caller): Promise<Me> => {
    const { principal, author, actor } = identityOf(caller)
    return {
      actor: actor.id,
      principal: principal.id,
      kind: actor.kind,
      handle: actor.handle,
      name: actor.name,
      avatar: actor.avatar,
      profile: author.profile,
      ...(actor.via ? { via: { ...actor.via } } : {}),
      expiresAt: principal.expiresAt?.toISOString() ?? null,
      can: principal.access.summary(),
    }
  }

  const remote = (method: string) => async (caller: Caller, input: unknown) => {
    const answer = (await stub().call(method, toWire(caller), input)) as Envelope
    if (!answer.ok) throw new HttpError(answer.error.status, answer.error.code, answer.error.message, answer.error.hint !== undefined ? { hint: answer.error.hint } : {})
    return answer.value
  }

  const methods = Object.fromEntries(METHODS.map((method) => [method, method === 'discovery' ? discovery : method === 'me' ? me : remote(method)]))

  return {
    ...(methods as unknown as Omit<Backend, 'routes' | 'keeps' | 'bind' | 'trust'>),
    routes: [],
    // The board lives here: board() lets its people in by the grants it keeps.
    keeps: true,
    trust: { grants: async () => STARTING_GRANTS },
    bind(given: BoardBinding) {
      if (binding) throw new Error('durable: this backend already serves a board: create one per board()')
      binding = given
    },
  }
}
