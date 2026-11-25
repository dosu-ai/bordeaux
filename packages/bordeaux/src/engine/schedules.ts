// Scheduled messages (spec 05), in session `schedules` of the board's log. Ported from upstream's
// src/server/schedules.ts at the pinned commit: the fold, the views, the timing rules, and what a
// send decides. Where upstream arms A2 timers on a queue, the board's DO keeps its timers in
// `bx_timers` and sets its alarm to the earliest; a send posts through board() as its creator.
import { duration, type Identity, type Protocol, type ScheduleView } from '@vercel/board'
import { z } from 'zod'
import type { ActorsState } from '../upstream/contract/folds.ts'
import { actorKind, authorView, type Attachment, type Author, type Labels } from '../upstream/contract/schemas.ts'
import { ownedActor } from '../upstream/server/actors.ts'
import { wroteAs, type Principal } from '../upstream/server/auth.ts'
import { badRequest } from '../upstream/server/errors.ts'
import { ref, scheduleRef, viaOfRecord } from '../upstream/server/feed.ts'

export const SCHEDULES_SESSION = 'schedules'

/** The shortest repeat, so a typo can't flood a thread. */
export const MIN_EVERY_MS = 60_000
/** How far out a schedule reaches: its first send, stop, and repeat. */
export const MAX_AHEAD_MS = 366 * 86_400_000

type Stored = Omit<Principal, 'access' | 'expiresAt'> & { expiresAt: null }
export type Schedule = {
  id: number
  channel: string
  re: number | null
  text: string
  labels: Labels
  noSync: boolean
  attachments: Attachment[]
  first: number
  every: number | null
  until: number | null
  times: number | null
  /** Its creator, as plain data: each send works its access out again. */
  as: { author: Author; principal: Stored; actor: Identity['actor'] }
  createdAt: string
  blind: boolean
  sent: number
  next: number | null
  last: number | null
  canceled: { by: Author; reason: 'canceled' | 'thread_deleted' | 'dropped' | 'revoked' } | null
}
export type SchedulesState = { byId: Record<string, Schedule> }
export const emptySchedules = (): SchedulesState => ({ byId: {} })

/** The session's events, checked as they're appended (upstream src/contract/contract.ts). */
const Millis = z.number().int().nonnegative()
const AuthorSchema = z.object({ actor: z.string(), principal: z.string(), profile: z.string().nullable() })
export const scheduleEvents = {
  'schedule.created': z.object({
    channel: z.string().min(1),
    re: z.number().int().positive().nullable(),
    text: z.string(),
    labels: z.record(z.string(), z.string()),
    noSync: z.boolean(),
    attachments: z.array(z.looseObject({ id: z.string() })).optional(),
    first: Millis,
    every: Millis.nullable(),
    until: Millis.nullable(),
    times: z.number().int().positive().nullable(),
    as: z.looseObject({ author: AuthorSchema, principal: z.looseObject({ id: z.string() }), actor: z.looseObject({ id: z.string() }) }),
    blind: z.literal(true).optional(),
  }),
  'schedule.canceled': z.object({ id: z.number().int().positive(), by: AuthorSchema, reason: z.enum(['canceled', 'thread_deleted', 'dropped', 'revoked']) }),
  'schedule.fired': z.object({ id: z.number().int().positive(), n: z.number().int().nonnegative(), message: z.number().int().positive(), next: Millis.nullable() }),
}

type Event = { type: string; index: number; createdAt: Date; payload: Record<string, unknown> }

/** Upstream's fold. */
export function foldSchedules(state: SchedulesState, event: Event): SchedulesState {
  const payload = event.payload as never as Schedule & { id: number; n: number; message: number; next: number | null; by: Author; reason: NonNullable<Schedule['canceled']>['reason'] }
  switch (event.type) {
    case 'schedule.created': {
      const as = payload.as
      const stored = { ...as.principal, expiresAt: null } as Stored
      state.byId[event.index] = {
        id: event.index,
        channel: payload.channel,
        re: payload.re,
        text: payload.text,
        labels: { ...payload.labels },
        noSync: payload.noSync,
        attachments: payload.attachments ?? [],
        first: payload.first,
        every: payload.every,
        until: payload.until,
        times: payload.times,
        // Shown as its principal names it.
        as: { author: as.author, principal: stored, actor: ownedActor(stored as never, as.author, { ...as.actor, kind: actorKind(as.actor.kind) }) },
        createdAt: new Date(event.createdAt).toISOString(),
        blind: payload.blind ?? false,
        sent: 0,
        next: payload.first,
        last: null,
        canceled: null,
      }
      return state
    }
    case 'schedule.canceled': {
      const schedule = state.byId[payload.id]
      if (!schedule || schedule.next === null) return state
      schedule.next = null
      schedule.canceled = { by: payload.by, reason: payload.reason }
      return state
    }
    case 'schedule.fired': {
      const schedule = state.byId[payload.id]
      if (!schedule || schedule.next === null || schedule.sent !== payload.n) return state
      schedule.sent++
      schedule.last = payload.message
      schedule.next = payload.next
      return state
    }
    default:
      return state
  }
}

/** The send after one due at `at`: the next slot after now, so downtime skips missed slots instead of replaying them. */
export function nextSend(schedule: Pick<Schedule, 'every' | 'until' | 'times'>, n: number, at: number, now: number): number | null {
  if (schedule.every === null) return null
  if (schedule.times !== null && n + 1 >= schedule.times) return null
  const next = at + schedule.every * Math.max(1, Math.floor((now - at) / schedule.every) + 1)
  return schedule.until !== null && next > schedule.until ? null : next
}

/** Whether `identity` is the schedule's creator, as far as seeing and canceling it goes (upstream `createdBy`). */
export const createdBy = (schedule: Schedule, identity: Pick<Identity, 'principal' | 'actor'>) =>
  wroteAs(identity, { principal: schedule.as.principal.id, actor: schedule.as.actor.id }) &&
  identity.principal.access.can('post', schedule.channel) &&
  (schedule.blind || identity.principal.access.readable(schedule.channel))

export const scheduleView = (schedule: Schedule, actors: ActorsState): ScheduleView => {
  const author = actors.byId[schedule.as.actor.id] ?? schedule.as.actor
  const via = viaOfRecord({ id: schedule.as.actor.id, handle: author.handle, via: 'via' in author ? author.via : undefined })
  return {
    id: scheduleRef(schedule.id),
    channel: schedule.channel,
    re: schedule.re === null ? null : ref(schedule.re),
    text: schedule.text,
    labels: { ...schedule.labels },
    noSync: schedule.noSync,
    attachments: schedule.attachments,
    first: new Date(schedule.first).toISOString(),
    every: schedule.every,
    until: schedule.until === null ? null : new Date(schedule.until).toISOString(),
    times: schedule.times,
    sent: schedule.sent,
    next: schedule.next === null ? null : new Date(schedule.next).toISOString(),
    last: schedule.last === null ? null : ref(schedule.last),
    state: schedule.canceled ? 'canceled' : schedule.next === null ? 'done' : 'pending',
    canceled: schedule.canceled && { ...schedule.canceled, by: authorView(schedule.canceled.by) },
    by: authorView(schedule.as.author),
    author: { kind: author.kind, handle: author.handle, name: author.name, avatar: author.avatar, ...(via ? { via } : {}) },
    createdAt: schedule.createdAt,
  }
}

/** When a new schedule sends first, repeats, and stops, checked as upstream's `create` checks them. */
export function timing(body: Protocol['schedule']['input'], now: number) {
  const every = body.every === undefined ? null : duration(body.every)
  if (every !== null && every < MIN_EVERY_MS) throw badRequest('`every` is at least 1m')
  if (every !== null && every > MAX_AHEAD_MS) throw badRequest('`every` is at most a year')
  const first = body.at !== undefined ? Date.parse(body.at) : now + duration((body.in ?? body.every)!)
  if (first < now - 60_000) throw badRequest('`at` is in the past')
  const until = body.until !== undefined ? Date.parse(body.until) : body.for !== undefined ? first + duration(body.for) : null
  if (until !== null && until < first) throw badRequest('the schedule stops before its first send')
  if (first > now + MAX_AHEAD_MS || (until !== null && until > now + MAX_AHEAD_MS)) throw badRequest('a schedule reaches at most a year out: its first send and its stop')
  return { first, every, until, times: body.times ?? null }
}

/** What a stored creator keeps of their principal: no access, which each send works out again. */
export function storedPrincipal(principal: Identity['principal']): Stored {
  const { access: _access, expiresAt: _expiresAt, ...rest } = principal as Identity['principal'] & { access: unknown }
  return { ...rest, expiresAt: null } as Stored
}
