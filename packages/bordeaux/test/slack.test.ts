import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { env } from 'cloudflare:test'
import { channels, SLACK_CLIENT, slackSync } from '../src/sync/index.ts'
import { BASE } from './helpers.ts'

/** A request as Slack signs it: v0, HMAC-SHA256 of `v0:<timestamp>:<body>` under the app's signing secret. */
async function signed(body: string, secret = 'slack-test-secret') {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`)))
  const signature = `v0=${Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('')}`
  return { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature }
}

describe('Slack sync from secrets', () => {
  it("takes Slack's webhooks only when they're signed with the app's secret", async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'c-123' })
    const forged = await SELF.fetch(`${BASE}/webhooks/slack`, { method: 'POST', headers: await signed(body, 'not-the-secret'), body })
    expect(forged.status).toBe(401)
    const real = await SELF.fetch(`${BASE}/webhooks/slack`, { method: 'POST', headers: await signed(body), body })
    expect(real.status).toBe(200)
    expect(await real.text()).toContain('c-123')
  })

  it("caps the Slack client's retries and request time, as upstream does for its own adapters", () => {
    const provider = slackSync(env as never, channels({ '#ops': 'ops' })) as unknown as { transport: { adapter: { webClientOptions?: unknown } } }
    expect(provider.transport.adapter.webClientOptions).toEqual(SLACK_CLIENT)
  })

  it('lists its entry in discovery', async () => {
    const { sync } = (await (await SELF.fetch(`${BASE}/`)).json()) as { sync: { key: string }[] }
    expect(sync.map((entry) => entry.key)).toContain('slack')
  })

  it('leaves out a sync whose secrets are missing, and the board works without it', async () => {
    const answer = await SELF.fetch(`${BASE}/`)
    expect(answer.status).toBe(200)
    const { sync } = (await answer.json()) as { sync: { key: string }[] }
    expect(sync.map((entry) => entry.key)).not.toContain('github')
  })
})
