import { env, runDurableObjectAlarm } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { boardKey } from '../src/worker/backend.ts'
import { api, tokenFor } from './helpers.ts'

const board = () => env.BOARD.get(env.BOARD.idFromName(boardKey(null)))
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('schedules', () => {
  it("send as their creator when they're due, and then they're done", async () => {
    const token = await tokenFor(50, 'sam')
    const at = new Date(Date.now() + 1500).toISOString()
    const made = await api(token, 'POST', '/schedules', { channel: 'standup', text: 'standup in 5', at })
    expect(made.status).toBe(201)
    expect(made.body.schedule).toMatchObject({ channel: 'standup', state: 'pending', sent: 0 })
    expect((await api(token, 'GET', '/schedules')).body.schedules.map((s: { id: string }) => s.id)).toContain(made.body.schedule.id)

    // The alarm fires by itself once it's due; run it now in case it hasn't yet.
    let done: { state: string; last: string } | undefined
    for (const deadline = Date.now() + 5000; Date.now() < deadline && done?.state !== 'done'; ) {
      await later(300)
      await runDurableObjectAlarm(board())
      const { schedules } = (await api(token, 'GET', '/schedules?all=true')).body
      done = schedules.find((s: { id: string }) => s.id === made.body.schedule.id)
    }
    expect(done).toMatchObject({ state: 'done', sent: 1 })
    const { message } = (await api(token, 'GET', `/messages/${done!.last}`)).body
    expect(message).toMatchObject({ channel: 'standup', text: 'standup in 5', by: { principal: 'bordeaux:user:50' }, schedule: { id: made.body.schedule.id, n: 0 } })
  })

  it('is canceled by its creator, and then never sends', async () => {
    const token = await tokenFor(51, 'tia')
    const { schedule } = (await api(token, 'POST', '/schedules', { channel: 'standup', text: 'never', in: '1h' })).body
    const canceled = await api(token, 'POST', `/schedules/${schedule.id}/cancel`)
    expect(canceled.body).toMatchObject({ canceled: true, schedule: { state: 'canceled' } })
  })
})
