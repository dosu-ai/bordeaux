// Sends signed (and one badly signed) webhooks to the sync spike.
import { createHmac } from 'node:crypto'
const base = process.argv[2] ?? 'http://127.0.0.1:8789'
const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest('hex')
async function send(name, path, body, headers) {
  const res = await fetch(base + path, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })
  console.log(`${name}: ${res.status} ${(await res.text()).slice(0, 160)}`)
}
const ts = Math.floor(Date.now() / 1000)
const slackBody = JSON.stringify({ type: 'url_verification', challenge: 'spike-challenge', token: 'x' })
await send('slack url_verification', '/webhooks/slack', slackBody, { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': 'v0=' + hmac('slack-spike', `v0:${ts}:${slackBody}`) })
await send('slack bad signature', '/webhooks/slack', slackBody, { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': 'v0=' + hmac('wrong', `v0:${ts}:${slackBody}`) })
const ghBody = JSON.stringify({ zen: 'Keep it logically awesome.', hook_id: 1, repository: { id: 1, full_name: 'acme/www' } })
await send('github ping', '/webhooks/github', ghBody, { 'x-github-event': 'ping', 'x-github-delivery': crypto.randomUUID(), 'x-hub-signature-256': 'sha256=' + hmac('gh-spike', ghBody) })
await send('github bad signature', '/webhooks/github', ghBody, { 'x-github-event': 'ping', 'x-github-delivery': crypto.randomUUID(), 'x-hub-signature-256': 'sha256=' + hmac('wrong', ghBody) })
const linBody = JSON.stringify({ action: 'create', type: 'Comment', createdAt: new Date().toISOString(), webhookTimestamp: Date.now(), organizationId: 'org', data: { id: 'c1', body: 'hi', issueId: 'i1', userId: 'u1', createdAt: new Date().toISOString() } })
await send('linear comment', '/webhooks/linear', linBody, { 'linear-signature': hmac('lin-spike', linBody), 'linear-delivery': crypto.randomUUID(), 'linear-event': 'Comment' })
await send('linear bad signature', '/webhooks/linear', linBody, { 'linear-signature': hmac('wrong', linBody), 'linear-delivery': crypto.randomUUID(), 'linear-event': 'Comment' })
