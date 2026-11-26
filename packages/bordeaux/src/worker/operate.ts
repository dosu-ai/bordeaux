// Running hosted teams (spec 09, "Leaving, suspending, and deleting" and "Operating it"): the
// daily cron's work per team, which the `bordeaux-teams` Queue hands out one team at a time, and
// deleting a team for good.
import { retried } from '../engine/reload.ts'
import { directory } from './auth.ts'
import { boardKey } from './backend.ts'
import type { BordeauxEnv } from './env.ts'
import { collectAll } from './health.ts'
import { registry, type TeamRecord } from './registry.ts'
import { hostedTeam } from './team.ts'

/** How long an uninstalled team's boards are kept for it to come back to. */
export const KEEP_UNINSTALLED_MS = 30 * 24 * 3600 * 1000

/** The daily cron, hosted: one message per team on the Queue. */
export async function fanOut(env: BordeauxEnv) {
  if (!env.TEAMS_QUEUE) throw new Error('a hosted deployment needs the TEAMS_QUEUE binding for its daily cron')
  const teams = await registry(env).list()
  for (let at = 0; at < teams.length; at += 100) await env.TEAMS_QUEUE.sendBatch(teams.slice(at, at + 100).map((team) => ({ body: { team: team.id } })))
}

/**
 * One team's daily work: deleted 30 days after it was uninstalled; otherwise retention on each of
 * its boards, and what it uses recorded.
 */
export async function tend(env: BordeauxEnv, hub: URL, id: string): Promise<'gone' | 'deleted' | 'tended'> {
  const record = await registry(env).byId(id)
  if (!record) return 'gone'
  if (record.state === 'uninstalled' && Date.now() - (record.state_at ?? 0) > KEEP_UNINSTALLED_MS) {
    await deleteTeam(env, hub, record)
    return 'deleted'
  }
  const team = hostedTeam(env, hub, record)
  await collectAll(env, team)
  const dir = directory(env, team)
  const [boards, totals] = await Promise.all([dir.boards(), dir.totals()])
  await registry(env).recordUsage(id, { boards: boards.length + 1, ...totals, at: Date.now() })
  return 'tended'
}

/** Deletes a team for good: each board's DO and TailDO, its files in R2, its directory, and its record. */
export async function deleteTeam(env: BordeauxEnv, hub: URL, record: TeamRecord) {
  const team = hostedTeam(env, hub, record)
  const dir = directory(env, team)
  for (const name of [null, ...(await dir.boards()).map((board) => board.name)]) {
    await retried(() => env.BOARD.get(env.BOARD.idFromName(boardKey(team.id, name)))).destroy()
    if (env.TAIL) await env.TAIL.get(env.TAIL.idFromName(boardKey(team.id, name))).destroy()
  }
  await dir.destroy()
  await registry(env).remove(record.id)
  console.log(`[bordeaux] deleted team ${record.id} (${record.github.login})`)
}
