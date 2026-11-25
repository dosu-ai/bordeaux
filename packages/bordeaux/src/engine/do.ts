// One board per Durable Object (`idFromName("<team>/<board>")`). The Worker calls `call()` for each
// protocol method; errors come back as data, since RPC doesn't carry an HttpError's status and code.
import { DurableObject } from 'cloudflare:workers'
import { HttpError } from '@vercel/board'
import { ZodError } from 'zod'
import { BoardEngine, isDuplicate, notKeptHere } from './engine.ts'
import { fromWire, type WireIdentity } from './identity.ts'
import type { BordeauxEnv } from '../worker/env.ts'

export type WireError = { status: number; code: string; message: string; hint?: string }
export type Envelope = { ok: true; value: unknown } | { ok: false; error: WireError }

/** The methods this board answers itself; the rest answer 501 until their milestone. */
const KEPT = ['channels', 'createChannel', 'actors', 'channelMessages', 'threads', 'message', 'posted', 'post', 'edit', 'delete', 'react', 'label', 'events'] as const
type Kept = (typeof KEPT)[number]
const isKept = (method: string): method is Kept => (KEPT as readonly string[]).includes(method)

export function toWireError(error: unknown): WireError {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message, ...(error.hint !== undefined ? { hint: error.hint } : {}) }
  if (isDuplicate(error)) return { status: 409, code: 'duplicate_id', message: 'that id was already used for a different write' }
  if (error instanceof ZodError) return { status: 400, code: 'invalid_request', message: error.issues[0]?.message ?? 'invalid request' }
  console.error('[bordeaux]', error)
  return { status: 500, code: 'internal', message: 'internal error' }
}

export class BoardDO extends DurableObject<BordeauxEnv> {
  private readonly engine: BoardEngine

  constructor(ctx: DurableObjectState, env: BordeauxEnv) {
    super(ctx, env)
    this.engine = new BoardEngine(ctx.storage)
    // Nothing runs until the tables have what the log has.
    void ctx.blockConcurrencyWhile(() => this.engine.ready)
  }

  /** The grants and the access session's head, for board()'s policy and the Worker's grant writes. */
  async accessState() {
    await this.engine.ready
    return this.engine.accessState()
  }

  async appendAccess(ifIndex: number, events: { type: string; payload: unknown }[]): Promise<Envelope> {
    try {
      return { ok: true, value: await this.engine.appendAccess(ifIndex, events) }
    } catch (error) {
      return { ok: false, error: toWireError(error) }
    }
  }

  async call(method: string, wire: WireIdentity, input: unknown): Promise<Envelope> {
    try {
      if (!isKept(method)) throw notKeptHere(method)
      const caller = fromWire(wire)
      const run = this.engine[method] as (caller: ReturnType<typeof fromWire>, input: unknown) => Promise<unknown>
      return { ok: true, value: await run.call(this.engine, caller, input) }
    } catch (error) {
      return { ok: false, error: toWireError(error) }
    }
  }
}
