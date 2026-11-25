// `durable()`: bordeaux's Backend for upstream's board(). Each protocol method runs in the board's
// Durable Object; `discovery` and `me` need nothing the board keeps, so the Worker answers them.
import { HttpError, type Backend, type BoardBinding, type Caller, type Discovery, type Me } from '@vercel/board'
import { identityOf, toWire } from '../engine/identity.ts'
import type { Envelope } from '../engine/do.ts'
import type { BordeauxEnv } from './env.ts'
import { directory } from './auth.ts'
import { createTrust } from './trust.ts'

/** The upstream version bordeaux speaks the protocol of (spec 00). */
export const UPSTREAM_VERSION = '0.56.1'

/** Every protocol method, as upstream's src/api/protocol.ts lists them at the pinned commit. */
const METHODS = 'discovery me channels createChannel actors channelMessages threads message post posted edit delete react label schedule schedules cancelSchedule tasks createTask createTasks createdTasks claimReadyTask claimTask renewTask releaseTask completeTask failTask blockTask unblockTask reopenTask assignTask setTaskNeeds cancelTask grants createGrant createGrants updateGrant explain revokeGrant schemas schema createSchema upload attachment uploadStart uploadFinish watchers register matches ack events typing readSource joinSource synced linked syncImport syncReceipt syncThread syncFind syncCopies inboxPush inboxNext inboxAck inbox'.split(' ')

/** The Durable Object a board lives in: one team per deployment for now (Q4), keyed so more can come. */
export const boardKey = (name: string | null) => `default/${(name ?? 'default').toLowerCase()}`

export function durable(env: BordeauxEnv, name: string | null = null): Backend {
  let binding: BoardBinding | null = null
  const url = name === null ? env.BORDEAUX_URL : `${env.BORDEAUX_URL}/b/${name.toLowerCase()}`
  const stub = () => env.BOARD.get(env.BOARD.idFromName(boardKey(name)))

  const discovery = async (): Promise<Discovery> => ({
    version: UPSTREAM_VERSION,
    url,
    audience: url,
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

  const trust = createTrust({
    board: stub,
    binding: () => {
      if (!binding) throw new Error("durable: this backend isn't serving a board yet")
      return binding
    },
    issuer: env.BORDEAUX_URL,
    // A person whose last sign-in found them an owner of the GitHub org, or in BORDEAUX_OWNERS (decided, Q2a).
    isOwner: async (principal) => principal.kind === 'person' && principal.id.startsWith('bordeaux:user:') && (await directory(env).isOwner(principal.id)),
  })
  const GRANT_METHODS = ['grants', 'createGrant', 'createGrants', 'updateGrant', 'explain', 'revokeGrant'] as const
  const local: Record<string, (caller: Caller, input: never) => Promise<unknown>> = { discovery, me }
  for (const method of GRANT_METHODS) local[method] = (caller, input) => (trust[method] as (identity: unknown, input: unknown) => Promise<unknown>)(identityOf(caller), input)

  // A direct upload's URL is the board's own: the Worker takes its bytes (spec 08, "Files").
  local.uploadStart = async (caller, input) => {
    const started = (await remote('uploadStart')(caller, input)) as { id: string; secret: string; headers: Record<string, string>; expiresAt: string }
    return { id: started.id, url: `${url}/__bordeaux/uploads/${started.id}?t=${started.secret}`, headers: started.headers, expiresAt: started.expiresAt }
  }

  const methods = Object.fromEntries(METHODS.map((method) => [method, local[method] ?? remote(method)]))

  return {
    ...(methods as unknown as Omit<Backend, 'routes' | 'keeps' | 'bind' | 'trust'>),
    routes: [],
    // The board lives here: board() lets its people in by the grants it keeps.
    keeps: true,
    trust: { grants: () => trust.stored() },
    bind(given: BoardBinding) {
      if (binding) throw new Error('durable: this backend already serves a board: create one per board()')
      binding = given
    },
  }
}
