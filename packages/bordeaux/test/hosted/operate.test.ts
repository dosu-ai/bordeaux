import { createExecutionContext, createMessageBatch, createScheduledController, env, getQueueResult, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import worker from '../../src/worker/index.ts'
import { directory, personId } from '../../src/worker/auth.ts'
import { boardKey } from '../../src/worker/backend.ts'
import { registry, type TeamRecord } from '../../src/worker/registry.ts'
import { KEEP_UNINSTALLED_MS } from '../../src/worker/operate.ts'

const HUB = 'https://board.test'
const HUB_TEAM = { id: 'hub', url: HUB, org: 'dosu-ai', installation: undefined, owners: [] }

/** A token from the hub's own sign-in, for an owner of the operator org or not. */
async function operator(id: number, owner: boolean): Promise<string> {
  const response = await SELF.fetch(`${HUB}/__dev/token`, { method: 'POST', body: JSON.stringify({ id, login: `op${id}` }) })
  await directory(env, HUB_TEAM).setOwner(personId(id), owner, Date.now() + 3_600_000)
  return ((await response.json()) as { access_token: string }).access_token
}

async function team(login: string): Promise<{ record: TeamRecord; url: string }> {
  const made = (await (await SELF.fetch(`${HUB}/__dev/team`, { method: 'POST', body: JSON.stringify({ login }) })).json()) as { team: string; url: string }
  return { record: (await registry(env).byId(made.team))!, url: made.url }
}

const ask = (token: string | null, method: string, path: string, body?: unknown) =>
  SELF.fetch(`${HUB}${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

/** Runs the Queue's consumer on one message per team, as the daily cron's fan-out sends them. */
async function tendTeams(...ids: string[]) {
  const batch = createMessageBatch('bordeaux-teams', ids.map((team, n) => ({ id: `m${n}`, timestamp: new Date(), attempts: 1, body: { team } })))
  const ctx = createExecutionContext()
  await worker.queue(batch as MessageBatch<{ team: string }>, env)
  return getQueueResult(batch, ctx)
}

describe('operator routes', () => {
  it('take only a hub token for an owner of the operator org', async () => {
    expect((await ask(null, 'GET', '/__bordeaux/teams')).status).toBe(401)
    expect((await ask(await operator(41, false), 'GET', '/__bordeaux/teams')).status).toBe(403)
    const { url } = await team('op-token')
    const token = await (await SELF.fetch(`${url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: 41, login: 'op41' }) })).json() as { access_token: string }
    // A team's token isn't the hub's.
    expect((await ask(token.access_token, 'GET', '/__bordeaux/teams')).status).toBe(401)
  })

  it('list teams with their usage, never their boards', async () => {
    const { record } = await team('op-list')
    const listed = (await (await ask(await operator(42, true), 'GET', '/__bordeaux/teams')).json()) as { teams: { id: string }[] }
    const found = listed.teams.find((one) => one.id === record.id)
    expect(found).toMatchObject({ url: 'https://op-list.board.test', state: 'active', usage: null })
    expect(Object.keys(found!).sort()).toEqual(['created_at', 'github', 'held_at', 'id', 'limits', 'state', 'state_at', 'url', 'usage'])
  })

  it("suspend and restore a team, and set its limits", async () => {
    const { record, url } = await team('op-suspend')
    const token = await operator(43, true)
    expect((await ask(token, 'POST', `/__bordeaux/teams/${record.id}/suspend`)).status).toBe(200)
    expect(await (await SELF.fetch(`${url}/channels`)).json()).toMatchObject({ error: { code: 'team_suspended' } })
    expect((await ask(token, 'POST', `/__bordeaux/teams/${record.id}/restore`)).status).toBe(200)
    expect((await SELF.fetch(`${url}/channels`)).status).toBe(401)
    expect(await (await ask(token, 'PATCH', `/__bordeaux/teams/${record.id}/limits`, { boards: 40 })).json()).toMatchObject({ team: { limits: { boards: 40 } } })
  })

  it("keep a team suspended through GitHub's unsuspend and a reinstall: only restore lifts it", async () => {
    const { record, url } = await team('op-held')
    const token = await operator(44, true)
    await ask(token, 'POST', `/__bordeaux/teams/${record.id}/suspend`)
    await registry(env).setState(record.github.installation, 'suspended')
    await registry(env).setState(record.github.installation, 'active')
    await registry(env).register({ ...record.github, installation: record.github.installation + 1 }, 'board.test')
    expect(await (await SELF.fetch(`${url}/channels`)).json()).toMatchObject({ error: { code: 'team_suspended' } })
    await ask(token, 'POST', `/__bordeaux/teams/${record.id}/restore`)
    expect((await SELF.fetch(`${url}/channels`)).status).toBe(401)
  })
})

describe("the daily cron, hosted", () => {
  it('puts each team on the Queue', async () => {
    const { record } = await team('cron-fan')
    const sent: string[] = []
    const queue = { sendBatch: async (messages: { body: { team: string } }[]) => void sent.push(...messages.map((m) => m.body.team)) }
    await worker.scheduled(createScheduledController({ cron: '0 4 * * *' }), { ...env, TEAMS_QUEUE: queue as never })
    expect(sent).toContain(record.id)
  })

  it("records each team's usage", async () => {
    const { record, url } = await team('cron-usage')
    const token = ((await (await SELF.fetch(`${url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: 1, login: 'ada' }) })).json()) as { access_token: string }).access_token
    await SELF.fetch(`${url}/admin/boards`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'ops' }) })
    expect((await tendTeams(record.id)).explicitAcks).toEqual(['m0'])
    expect((await registry(env).byId(record.id))!.usage).toMatchObject({ boards: 2 })
  })

  it('deletes a team 30 days after it was uninstalled: its boards, deleted ones too, files, directory, and record', async () => {
    const kept = await team('cron-kept')
    const gone = await team('cron-gone')
    const token = ((await (await SELF.fetch(`${gone.url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: 1, login: 'ada' }) })).json()) as { access_token: string }).access_token
    const send = (path: string, method: string, body?: unknown, bearer = token) => SELF.fetch(`${gone.url}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    await send('/messages', 'POST', { channel: 'general', text: 'soon gone' })
    // A named board, written to and then deleted: its DO keeps what it had until the team goes.
    await directory(env, { ...HUB_TEAM, id: gone.record.id, url: gone.url }).setOwner(personId(1), true, Date.now() + 3_600_000)
    await send('/admin/boards', 'POST', { name: 'ops' })
    const forOps = ((await (await SELF.fetch(`${gone.url}/__dev/token`, { method: 'POST', body: JSON.stringify({ id: 1, login: 'ada', audience: `${gone.url}/b/ops` }) })).json()) as { access_token: string }).access_token
    expect((await send('/b/ops/messages', 'POST', { channel: 'general', text: 'on a deleted board' }, forOps)).status).toBe(201)
    expect((await send('/admin/boards/ops', 'DELETE')).status).toBe(200)
    const ops = env.BOARD.get(env.BOARD.idFromName(boardKey(gone.record.id, 'ops')))
    const board = env.BOARD.get(env.BOARD.idFromName(boardKey(gone.record.id, null)))
    const file = `boards/${board.id.toString()}/attachments/a1`
    await env.FILES!.put(file, 'bytes')

    for (const [found, ago] of [[kept, KEEP_UNINSTALLED_MS - 60_000], [gone, KEEP_UNINSTALLED_MS + 60_000]] as const) {
      await registry(env).setState(found.record.github.installation, 'uninstalled')
      await runInDurableObject(registry(env), async (_, state) => {
        const row = state.storage.sql.exec<{ data: string }>('select data from bx_teams where id = ?', found.record.id).one()
        state.storage.sql.exec('update bx_teams set data = ? where id = ?', JSON.stringify({ ...JSON.parse(row.data), state_at: Date.now() - ago }), found.record.id)
      })
    }
    expect((await tendTeams(kept.record.id, gone.record.id)).explicitAcks).toEqual(['m0', 'm1'])

    expect(await registry(env).byId(kept.record.id)).not.toBeNull()
    expect(await registry(env).byId(gone.record.id)).toBeNull()
    expect(await env.FILES!.head(file)).toBeNull()
    // Each object reset as it was destroyed: what answers now starts from nothing.
    const count = (stub: DurableObjectStub, table: string) => runInDurableObject(stub, async (_, state) => state.storage.sql.exec<{ n: number }>(`select count(*) as n from ${table}`).one().n)
    expect(await count(board, 'bx_log')).toBe(0)
    expect(await count(ops, 'bx_log')).toBe(0)
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName(gone.record.id))
    expect(await count(dir, 'bx_boards')).toBe(0)
  })

  it("doesn't restore a team it's deleting when the App is installed again meanwhile", async () => {
    const { record } = await team('cron-race')
    await registry(env).setState(record.github.installation, 'uninstalled')
    expect(await registry(env).claimDeletion(record.id, Infinity)).toMatchObject({ state: 'deleting' })
    const again = await registry(env).register({ ...record.github, installation: record.github.installation + 1 }, 'board.test')
    expect(again).toMatchObject({ created: false, team: { state: 'deleting' } })
  })
})
