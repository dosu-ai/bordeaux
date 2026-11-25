// Redaction (spec 02, Δ decided Q9): scrubbing a message that leaked a secret out of the log, its
// copies, and the queues. Upstream's log is immutable; this is bordeaux's one admin path around
// that. The engine runs it (`BoardEngine.redact`); what's here is what it rewrites, and how.
import { z } from 'zod'
import { externalMessageKey } from '../upstream/contract/external.ts'
import { Author, MessageId } from '../upstream/contract/schemas.ts'
import { ref } from '../upstream/server/feed.ts'

/** The session redactions are recorded in: never on `/events`, listed by `GET /admin/redactions`. */
export const ADMIN_SESSION = 'admin'

/** The most a redaction's reason says. */
export const REASON_MAX = 500

export const adminEvents = {
  'message.redacted': z.object({ id: MessageId, by: Author, reason: z.string().trim().min(1).max(REASON_MAX), at: z.iso.datetime() }),
}

/**
 * What a redacted text reads. Upstream's schema refuses an edit with empty text, and its clients
 * parse what the feed sends, so a redacted edit says this rather than nothing; a post does too,
 * to read the same.
 */
export const REDACTED_TEXT = '[redacted]'

/** The events about a message whose payloads say what it said. */
export const CONTENT_EVENTS = ['message.posted', 'message.edited', 'message.linked', 'labels.changed'] as const

/**
 * An event's payload with what the message said taken out: text, links, attachments, label
 * values, and its platform context. IDs, `by`, the thread, and its place in the log stay.
 */
export function scrubbed(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload, redacted: true }
  if (type === 'message.posted' || type === 'message.edited') out.text = REDACTED_TEXT
  if ('links' in payload) out.links = []
  if ('attachments' in payload) out.attachments = []
  for (const key of ['labels', 'set'] as const)
    if (payload[key] && typeof payload[key] === 'object') out[key] = Object.fromEntries(Object.keys(payload[key] as object).map((label) => [label, '']))
  if (payload.origin && typeof payload.origin === 'object') out.origin = { ...(payload.origin as object), context: null }
  return out
}

type QueuedView = { type?: string; cursor?: string; payload?: { id?: unknown }; message?: { id?: unknown } }
type QueuedInbox = { event?: { kind?: string; thread?: string; subthread?: string | null; message?: string } }

/**
 * Whether a queued item (a watcher's or a sync's match, or a platform event an inbox holds)
 * says something of message `id`. A deletion says nothing, and a sync still needs it to delete
 * the board's copies on each platform, so it stays. `externalKeys` are the message's platform
 * keys (`board_external_messages`).
 */
export function about(item: unknown, id: number, externalKeys: ReadonlySet<string>): boolean {
  const inbox = (item as QueuedInbox).event
  if (inbox && typeof inbox === 'object' && 'kind' in inbox) {
    if (inbox.kind === 'deleted' || inbox.message === undefined || inbox.thread === undefined) return false
    return externalKeys.has(externalMessageKey(inbox.subthread ?? inbox.thread, inbox.message)) || externalKeys.has(externalMessageKey(inbox.thread, inbox.message))
  }
  const view = item as QueuedView
  if (view.type === 'message.deleted') return false
  return view.cursor === ref(id) || view.message?.id === ref(id) || view.payload?.id === id || view.payload?.id === ref(id)
}

/** What one redaction did (`bx redact`). */
export type Redacted = {
  id: number
  /** Log events rewritten: the post and its edits, links, and label changes. */
  events: number
  /** Copies of it as it was after each change (`board_versions`). */
  copies: number
  /** Queued items and dead letters that held what it said. */
  queued: number
  /** Files whose bytes went. */
  files: number
  /** Where it came from, when a platform wrote it: what `--everywhere` deletes there. */
  origin: { thread: string; subthread: string | null; message: string } | null
  /** Set when a sync elsewhere imported it: that deployment's to delete, not this one's. */
  importedBy: string | null
}

/** A redaction as `GET /admin/redactions` lists it. */
export type Redaction = { id: string; by: z.infer<typeof Author>; reason: string; at: string }
