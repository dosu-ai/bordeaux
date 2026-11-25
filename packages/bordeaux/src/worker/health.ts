// Whether the default board's sync can reach each platform (spec 08, "Health"). Readying a
// provider signs in to its platform as upstream does on first use: Slack's `auth.test`, a
// Linear app's client-credentials token. Linear sends an app's webhooks only after its first
// token, so this check is also what turns a new deployment's Linear webhooks on.
import { configOf, type BordeauxConfig } from './config.ts'
import type { BordeauxEnv } from './env.ts'

/** How long one platform has to answer. */
const CHECK_MS = 10_000

export type SyncHealth = { key: string; platform: string; ok: boolean; error?: string }

type Readies = { platform?: string; ready?: () => Promise<unknown> }

/** Readies every sync given (the deployment's, by default), at once, and says how each went. */
export async function checkSync(env: BordeauxEnv, given: BordeauxConfig['sync'] = configOf(env).sync): Promise<SyncHealth[]> {
  const sync = Object.entries(given ?? {}).filter((entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== null)
  return Promise.all(
    sync.map(async ([key, provider]) => {
      const { platform = key, ready } = provider as unknown as Readies
      if (!ready) return { key, platform, ok: true }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([ready.call(provider), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${CHECK_MS / 1000} s`)), CHECK_MS)))])
        return { key, platform, ok: true }
      } catch (error) {
        return { key, platform, ok: false, error: (((error as Error)?.message || String(error)) || 'failed').slice(0, 300) }
      } finally {
        clearTimeout(timer)
      }
    }),
  )
}

/** The Worker's cron: checks sync and logs what failed, so a revoked credential shows in the logs. */
export async function scheduledCheck(env: BordeauxEnv) {
  for (const found of await checkSync(env)) if (!found.ok) console.error(`[bordeaux] ${found.key} sync can't reach ${found.platform}: ${found.error}`)
}
