// SHIM (bordeaux): `hasCriteria` from upstream's src/server/watch-spec.ts at the pinned commit (Apache-2.0).
// The rest of that file parses watcher tails, which the vendored feed doesn't need.
import type { ParsedFilters } from '../api/routes.ts'

/** Whether filters narrow anything: a view a message can enter. */
export const hasCriteria = (filters: ParsedFilters) =>
  filters.channel !== undefined ||
  filters.re !== undefined ||
  filters.by !== undefined ||
  filters.mentions !== undefined ||
  filters.from !== undefined ||
  filters.text !== undefined ||
  (filters.label?.length ?? 0) > 0
