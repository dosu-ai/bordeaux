// Upstream's `Db` (src/upstream/store/sql.ts) on a Durable Object's SQLite. Every call runs
// synchronously; the promises are already settled when they're returned, so no other request
// runs in between (a Durable Object only takes the next one when this one waits on real I/O).
import { ddl, type Db, type Sql } from '../upstream/store/sql.ts'

/** `$1` → `?1`: SQLite's numbered parameters, bound in order. */
const numbered = (text: string) => text.replace(/\$(\d+)/g, '?$1')

/** SQLite has no booleans. */
const bind = (value: unknown) => (typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null))

export function doDb(storage: DurableObjectStorage): Db {
  const run = (query: Sql) => storage.sql.exec(numbered(query.text), ...query.values.map(bind)).toArray() as Record<string, unknown>[]
  return {
    all: async (query) => run(query),
    read: async (queries) => storage.transactionSync(() => queries.map(run)),
    commit: async (claim, writes) =>
      storage.transactionSync(() => {
        if (run(claim).length === 0) return false
        for (const write of writes) run(write)
        return true
      }),
    close: async () => {},
  }
}

/** Creates upstream's tables (`board_messages`, `board_versions`, `board_terms`, …). */
export function createTables(storage: DurableObjectStorage) {
  for (const statement of ddl()) storage.sql.exec(statement)
}
