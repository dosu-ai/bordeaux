// Reloading a Durable Object a newer Worker version calls (spec 08, "Deploys"). Δ (upstream runs
// on Vercel, where a deploy starts fresh functions): a DO keeps its code and env while it's in
// use, and a board, or its TailDO, that a client long-polls is always in use, so a deploy, or a
// new secret, never reached it.

/** Why a DO resets: what the requests queued at it when it does fail with. */
export const RELOADING = 'a newer Worker version is deployed'

/**
 * A stub whose every call is made once more, on a new stub, when the DO reset under it. The
 * calls that fail so were queued, never started: a reset waits until nothing runs there.
 */
export function retried<T extends object>(stub: () => T): T {
  return new Proxy({} as T, {
    get(_target, method) {
      // Not a thenable: an `await` of the stub itself must see a plain object.
      if (method === 'then') return undefined
      return async (...args: unknown[]) => {
        try {
          return await (stub() as Record<PropertyKey, (...args: unknown[]) => Promise<unknown>>)[method]!(...args)
        } catch (error) {
          if (!String((error as Error)?.message ?? '').includes(RELOADING)) throw error
          return (stub() as Record<PropertyKey, (...args: unknown[]) => Promise<unknown>>)[method]!(...args)
        }
      }
    },
  })
}

/** The Worker version a call comes from (`version_metadata`). */
export type CallerVersion = { id: string; timestamp: string }

/**
 * Counts a DO's busy spells, and resets it once it's idle after a newer version called. It resets
 * once per newer version, so a DO a gradual deployment keeps on the old version doesn't reset
 * over and over. `hurry` ends the DO's waits, so it goes idle.
 */
export class Reloader {
  /** Calls and alarms running now: a reload waits for none. */
  private busy = 0
  /** Set once a newer Worker version called: the DO resets when it's next idle. */
  private reloading = false

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly own: () => WorkerVersionMetadata | undefined,
    private readonly hurry: () => void,
  ) {
    ctx.storage.sql.exec('create table if not exists bx_state (key text primary key, data text not null)')
  }

  /** Notes who's calling: a newer version than this instance runs starts its reload. */
  newer(version: CallerVersion | undefined) {
    const own = this.own()
    if (!version || !own || this.reloading || version.id === own.id || !(version.timestamp > own.timestamp)) return
    const [row] = this.ctx.storage.sql.exec<{ data: string }>("select data from bx_state where key = 'reloaded-for'").toArray()
    if (row && JSON.parse(row.data) === version.id) return
    this.ctx.storage.sql.exec("insert into bx_state (key, data) values ('reloaded-for', ?) on conflict (key) do update set data = excluded.data", JSON.stringify(version.id))
    this.reloading = true
    // A long-poll keeps this instance busy for as long as it waits: they answer now instead.
    this.hurry()
  }

  /** Runs `work` as one of this instance's busy spells; a reload that's waiting happens after the last. */
  async spell<T>(work: () => Promise<T>): Promise<T> {
    this.busy++
    try {
      return await work()
    } finally {
      this.busy--
      if (this.reloading && this.busy === 0) void this.reloadWhenIdle()
    }
  }

  private resetting = false

  /**
   * Resets once nothing runs here and every answer has gone. A DO holds an answer back until what
   * its call wrote is durable, and an abort before then breaks it: the caller gets an error for a
   * write that may have landed. So it waits for storage first, then looks again.
   */
  private async reloadWhenIdle() {
    if (this.resetting) return
    this.resetting = true
    try {
      await this.ctx.storage.sync()
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (this.busy > 0) return
      console.log('[bordeaux] a newer Worker version called: reloading')
      this.ctx.abort(RELOADING)
    } finally {
      this.resetting = false
    }
  }
}
