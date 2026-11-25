// The board's grants (spec 03): the six grant methods, judged in the Worker by board()'s own policy
// (`binding.accessNow`, `binding.explain`) and stored in the board's DO, in session `access`.
// Ported from upstream's src/server/trust.ts at the pinned commit; each function names its original.
// What's different: the state and the conditional append are RPCs, and a person is an owner when
// the GitHub org says so (spec 03, decided Q2a).
import { HttpError, type BoardBinding, type Identity, type Protocol } from '@vercel/board'
import { checkGrantChange, compileAccess, parseCan, type Access, type GrantShape, type WrittenCan } from '../upstream/server/access.ts'
import {
  checkCan,
  checkGrant,
  checkPrincipal,
  GITHUB_ISSUER,
  grantIssuers,
  issuerName,
  joined,
  removes,
  workflowPath,
  type GrantPrincipal,
  type Known,
  type StoredGrant,
} from '../upstream/server/auth.ts'
import { badRequest, forbidden, notFound } from '../upstream/server/errors.ts'
import { grantIndex, grantView, serviceGrant, storedGrant, type AccessState, type GrantRow } from '../engine/access.ts'
import type { Envelope } from '../engine/do.ts'

type Board = { accessState(): Promise<{ state: AccessState; index: number }>; appendAccess(ifIndex: number, events: { type: string; payload: unknown }[]): Promise<Envelope> }
type In<M extends keyof Protocol> = Protocol[M]['input']
type Out<M extends keyof Protocol> = Protocol[M]['output']

type Named = { what: string; doing: string }
const THIS_GRANT: Named = { what: 'this grant', doing: 'this grant' }
const ISSUER: Named = { what: 'naming an oidc issuer', doing: 'naming an oidc issuer' }
const NO_ACCESS = compileAccess([])
type AccessIn = (principal: Known, grants: readonly StoredGrant[]) => Promise<Access | null>
type Standing = { caller: Access; own: Access; then?: { caller: Access; own: Access } }

/** `grants` with no `everyone` in them (upstream trust.ts `withoutEveryone`). */
const withoutEveryone = (grants: readonly StoredGrant[]): StoredGrant[] =>
  grants.flatMap((grant) => {
    const principals = grant.principals.filter((principal) => principal.kind !== 'everyone')
    return principals.length === 0 ? [] : [{ ...grant, principals }]
  })

const unreachable = (what: string) => forbidden(`this token can't ${what}: it needs manage wherever that grant reaches`)
const namesIssuer = (principals: readonly GrantPrincipal[]) => principals.some((principal) => principal.kind === 'oidc')

/** Runs `attempt` again each time another grant write lands first (upstream writes.ts `whileHeadMoves`). */
class Moved extends Error {}
async function whileHeadMoves<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt()
    } catch (error) {
      if (!(error instanceof Moved)) throw error
      if (tries === 10) throw new HttpError(503, 'unavailable', 'the board kept changing while it checked: try again')
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5 * tries))
    }
  }
}

export function createTrust(options: {
  board: () => Board
  binding: () => BoardBinding
  /** The board's own issuer, which g4 names. */
  issuer: string
  /** Whether a person is a board owner: an owner of its GitHub org, or one BORDEAUX_OWNERS names. */
  isOwner: (principal: Identity['principal']) => Promise<boolean>
}) {
  const accessIn: AccessIn = (principal, grants) => options.binding().accessNow(principal, grants)
  const logins = () => options.binding().logins

  /** Appends while the head is still `index`, or throws `Moved` for the caller to look again. */
  async function append(index: number, events: { type: string; payload: unknown }[]): Promise<number[]> {
    const answer = await options.board().appendAccess(index, events)
    if (!answer.ok) throw new HttpError(answer.error.status, answer.error.code, answer.error.message)
    const value = answer.value as { moved: true } | { indexes: number[] }
    if ('moved' in value) throw new Moved()
    return value.indexes
  }

  /** The grants as they are, with g4 written on a board that has never had a grant write. */
  async function latest(): Promise<{ state: AccessState; index: number }> {
    const found = await options.board().accessState()
    if (found.index > 0) return found
    const g4 = serviceGrant(options.issuer)
    try {
      await append(0, [{ type: 'grant.created', payload: { ...g4, by: 'board:client' } }])
    } catch (error) {
      if (!(error instanceof Moved)) throw error
    }
    return options.board().accessState()
  }

  /** Whether `identity` may list the grants: manage at `*`, or an owner, as far as its `x-board-can` allows (upstream `lists`). */
  async function lists({ principal }: Identity): Promise<boolean> {
    if (principal.access.at('manage', '*')) return true
    return (await options.isOwner(principal)) && (principal.scope === undefined || compileAccess(parseCan(principal.scope)).at('manage', '*'))
  }

  async function mayList(identity: Identity, what: string) {
    if (!(await lists(identity))) throw forbidden(`this token can't ${what}: it needs manage at *`)
  }

  /** What the caller may do on `grants`, and by its own limits alone: null for an owner no `x-board-can` narrows (upstream `changerAccess`). */
  async function changerAccess(identity: Identity, grants: readonly StoredGrant[]): Promise<{ caller: Access; own: Access } | null> {
    const { principal } = identity
    if (await options.isOwner(principal)) {
      if (principal.scope === undefined) return null
      const scoped = compileAccess(parseCan(principal.scope))
      return { caller: scoped, own: scoped }
    }
    const [caller, own] = await Promise.all([accessIn(principal, grants), accessIn(principal, withoutEveryone(grants))])
    if (caller === null || own === null) throw forbidden("this token can't change grants: it may do nothing on this board")
    return { caller, own }
  }

  /** What a grant write is judged by, with a lockout judged on `left` (upstream `standingOf`). */
  async function standingOf(identity: Identity, before: readonly StoredGrant[], left?: readonly StoredGrant[]): Promise<Standing | null> {
    const access = await changerAccess(identity, before)
    if (access === null || left === undefined) return access
    if (await options.isOwner(identity.principal)) return { ...access, then: access }
    const [caller, own] = await Promise.all([accessIn(identity.principal, left), accessIn(identity.principal, withoutEveryone(left))])
    return { ...access, then: { caller: caller ?? NO_ACCESS, own: own ?? NO_ACCESS } }
  }

  /** A refusal unless `standing` may change grants so (upstream `judge`, on upstream's `checkGrantChange`). */
  async function judge(identity: Identity, standing: Standing | null, change: { changed?: { can: WrittenCan }; revoked?: { can: WrittenCan } }, after: readonly GrantShape[], { what, doing }: Named = THIS_GRANT) {
    if (standing === null) return
    const refused = checkGrantChange({ ...standing, after, ...change })
    if (refused?.reason === 'reach') {
      if (change.revoked && !(await lists(identity))) throw unreachable(what)
      throw forbidden(`${change.revoked ? `this token can't ${what}: it` : what} reaches ${refused.pattern}, where you can't manage grants`)
    }
    if (refused?.reason === 'lockout') {
      const where = change.revoked && !(await lists(identity)) ? 'where it reaches' : `in ${refused.pattern}`
      throw new HttpError(409, 'grant_lockout', `${doing} would leave you unable to manage grants ${where}`, {
        hint: 'Name yourself with manage there, in a grant made before it or in the same write. Or send lockMeOut to go ahead: only someone who still manages grants there could change it then.',
      })
    }
    if (refused) throw forbidden(`you can't let anyone in: everyone gets ${refused.permission} in ${refused.pattern}, which you can't`)
  }

  async function mayGrant(identity: Identity, change: { changed?: { can: WrittenCan }; revoked?: { can: WrittenCan } }, before: readonly StoredGrant[], after: readonly GrantShape[], named: Named = THIS_GRANT, left?: readonly StoredGrant[]) {
    await judge(identity, await standingOf(identity, before, left), change, after, named)
  }

  /** Makes `bodies`' grants in one append, all or none (upstream trust.ts `create`). */
  async function create(identity: Identity, bodies: readonly In<'createGrants'>['grants'][number][], lockMeOut: boolean | undefined) {
    const indexes = await whileHeadMoves(async () => {
      const { state, index } = await latest()
      const before = Object.values(state.grants).map(storedGrant)
      const made: StoredGrant[] = []
      for (const body of bodies) made.push({ id: `g${state.nextGrant + made.length}`, ...checkGrant(body, grantIssuers([...before, ...made]), null, logins()) })
      const after = [...before, ...made]
      const standing = await standingOf(identity, before, lockMeOut ? undefined : after)
      for (const [at, grant] of made.entries()) {
        const named: Named = made.length === 1 ? THIS_GRANT : { what: `grant ${at + 1} of ${made.length}`, doing: `grant ${at + 1} of ${made.length}` }
        await judge(identity, standing, { changed: grant }, after, named)
        if (namesIssuer(grant.principals)) await judge(identity, standing && { caller: standing.caller, own: standing.own }, { changed: { can: { '*': 'all' } } }, after, ISSUER)
      }
      return append(index, made.map((grant) => ({ type: 'grant.created', payload: { principals: grant.principals, can: grant.can, by: identity.actor.id } })))
    })
    const { grants } = (await options.board().accessState()).state
    return indexes.map((at) => {
      const made = Object.values(grants).find((grant) => grant.event === at)
      if (!made) throw new Error('a grant was made but its log has no record of it')
      return grantView(made)
    })
  }

  /** The event that makes an update, or why it can't (upstream trust.ts `updated`). */
  async function updated(identity: Identity, state: AccessState, { id, add, remove, can, lockMeOut }: In<'updateGrant'>) {
    const index = grantIndex(id)
    const row: GrantRow | undefined = index === null ? undefined : state.grants[index]
    if (!row) {
      if (!(await lists(identity))) throw unreachable(`update ${id}`)
      throw notFound(`grant not found: ${id}`, 'grant_not_found')
    }
    const before = Object.values(state.grants).map(storedGrant)
    const named: Named = { what: `update ${id}`, doing: `updating ${id}` }
    await mayGrant(identity, { revoked: row }, before, before.filter((other) => other.id !== storedGrant(row).id), named)
    const others = grantIssuers(Object.values(state.grants).filter((other) => other.id !== row.id).map(storedGrant))
    let principals = [...row.principals]
    for (const input of remove ?? []) {
      const removal = checkPrincipal(input, others, true, null, logins())
      const kept = principals.filter((principal) => !removes(removal, principal))
      if (kept.length === principals.length) throw badRequest(`${id} doesn't name that ${removal.kind} principal`, 'not_in_grant')
      principals = kept
    }
    for (const input of add ?? []) {
      const added = checkPrincipal(input, [...others, ...grantIssuers([{ principals }])], false, null, logins())
      const at = principals.findIndex((principal) => joined(added, principal) !== null)
      if (at === -1) principals.push(added)
      else principals[at] = joined(added, principals[at]!)!
    }
    if (principals.length === 0) throw badRequest(`that leaves ${id} naming no one: revoke it instead`, 'grant_empty')
    if (principals.length > 32) throw badRequest('a grant names at most 32 principals', 'invalid_grant')
    const next = can === undefined ? row.can : checkCan(can)
    const after = [...before.filter((other) => other.id !== storedGrant(row).id), { id: storedGrant(row).id, principals, can: next }]
    const widens = add !== undefined || can !== undefined
    await mayGrant(identity, { revoked: row, ...(widens ? { changed: { can: next } } : {}) }, before, after, named, lockMeOut ? undefined : after)
    if (namesIssuer(principals.filter((principal) => !row.principals.includes(principal)))) await mayGrant(identity, { changed: { can: { '*': 'all' } } }, before, after, ISSUER)
    return { type: 'grant.updated', payload: { id: row.id, principals, can: next, by: identity.actor.id } }
  }

  /** The principal an explain query names (upstream trust.ts `principalNamed`), with bordeaux's people. */
  function principalNamed(query: In<'explain'>): Known {
    if (query.user !== undefined) {
      if (query.user.includes('@')) throw badRequest(`this board can't look up ${query.user}: name the user by their GitHub user ID`)
      return { id: `bordeaux:user:${query.user}`, kind: 'person', handle: query.user }
    }
    if (query.project !== undefined) {
      // As on upstream's local board: a project grant is kept, and lets in a token that names it.
      if (!/^prj_[A-Za-z0-9]+$/.test(query.project)) throw badRequest(`this board can't look up the project ${query.project}: name it by ID, prj_…`)
      const environment = query.environment ?? 'production'
      return { id: `vercel:project:${query.project}:${environment}`, kind: 'deployment', handle: query.project, facts: { issuer: 'vercel', iss: '', claims: { project_id: query.project, environment } } }
    }
    if (query.github !== undefined) {
      const repository = query.github
      const claims: Record<string, string> = { repository }
      const branch = query.branch ?? 'main'
      if (query.workflow !== undefined) claims.workflow_ref = `${repository}/${workflowPath(query.workflow)}@refs/heads/${branch}`
      claims.ref = `refs/heads/${branch}`
      if (query.event !== undefined) claims.event_name = query.event
      return { id: `github:repo:${repository}`, kind: 'workflow', handle: repository, facts: { issuer: 'github', iss: GITHUB_ISSUER, claims } }
    }
    const iss = query.oidc!
    const claims: Record<string, string> = {}
    for (const pair of query.claim ?? []) {
      const at = pair.indexOf('=')
      if (at <= 0) throw badRequest(`a claim is name=value, and ${pair} isn't one`)
      claims[pair.slice(0, at)] = pair.slice(at + 1)
    }
    let name: string
    try {
      name = issuerName(iss)
    } catch {
      throw badRequest(`an oidc issuer is an https URL, got ${iss}`)
    }
    return { id: `oidc:${name}:${claims.sub ?? 'explain'}`, kind: 'workflow', handle: claims.sub ?? 'oidc', facts: { issuer: 'oidc', iss, claims } }
  }

  return {
    /** What board() checks requests against. */
    async stored(): Promise<StoredGrant[]> {
      return Object.values((await latest()).state.grants).map(storedGrant)
    },
    async grants(identity: Identity): Promise<Out<'grants'>> {
      await mayList(identity, 'list grants')
      return { grants: Object.values((await latest()).state.grants).sort((a, b) => a.id - b.id).map(grantView) }
    },
    async createGrant(identity: Identity, { lockMeOut, ...body }: In<'createGrant'>): Promise<Out<'createGrant'>> {
      const [grant] = await create(identity, [body], lockMeOut)
      return { grant: grant! }
    },
    async createGrants(identity: Identity, { grants, lockMeOut }: In<'createGrants'>): Promise<Out<'createGrants'>> {
      return { grants: await create(identity, grants, lockMeOut) }
    },
    async updateGrant(identity: Identity, input: In<'updateGrant'>): Promise<Out<'updateGrant'>> {
      const id = await whileHeadMoves(async () => {
        const { state, index } = await latest()
        const event = await updated(identity, state, input)
        await append(index, [event])
        return event.payload.id
      })
      return { grant: grantView((await options.board().accessState()).state.grants[id]!) }
    },
    async explain(identity: Identity, query: In<'explain'>): Promise<Out<'explain'>> {
      const named = query.user !== undefined || query.project !== undefined || query.github !== undefined || query.oidc !== undefined || query.app !== undefined
      if (named) await mayList(identity, 'explain what another principal may do')
      if (query.app !== undefined) return { channel: query.channel, pattern: null, over: [], level: null, grants: [], capped: null, can: [] }
      const { id, kind, handle, facts, scope } = identity.principal
      const principal: Known = named ? principalNamed(query) : { id, kind, handle, ...(facts ? { facts } : {}), ...(scope !== undefined ? { scope } : {}) }
      const decided = await options.binding().explain(principal, query.channel)
      const { grants } = (await latest()).state
      const shown = (await lists(identity)) ? decided.grants : []
      return {
        channel: query.channel,
        pattern: decided.pattern,
        over: decided.over,
        level: decided.level,
        grants: shown.flatMap((grant) => {
          const row = grants[grantIndex(grant.id) ?? 0]
          return row ? [grantView(row)] : []
        }),
        capped: null,
        can: decided.permissions,
      }
    },
    async revokeGrant(identity: Identity, { id, lockMeOut }: In<'revokeGrant'>): Promise<Out<'revokeGrant'>> {
      return whileHeadMoves(async () => {
        const { state, index } = await latest()
        const at = grantIndex(id)
        const row = at === null ? undefined : state.grants[at]
        if (!row) {
          if (!(await lists(identity))) throw unreachable(`revoke ${id}`)
          return { revoked: false }
        }
        const before = Object.values(state.grants).map(storedGrant)
        const after = before.filter((other) => other.id !== storedGrant(row).id)
        await mayGrant(identity, { revoked: row }, before, after, { what: `revoke ${id}`, doing: `revoking ${id}` }, lockMeOut ? undefined : after)
        await append(index, [{ type: 'grant.deleted', payload: { id: row.id, by: identity.actor.id } }])
        return { revoked: true }
      })
    },
  }
}
