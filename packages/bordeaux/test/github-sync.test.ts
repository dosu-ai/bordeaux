import { describe, expect, it } from 'vitest'
import { githubSync, repos } from '../src/sync/index.ts'

// Test values: no key is ever used to sign here.
const secrets = { GITHUB_APP_ID: '1', GITHUB_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n', GITHUB_INSTALLATION_ID: '2', GITHUB_WEBHOOK_SECRET: 'test-only' }

/** What the adapter asks GitHub when it meets a new installation client, recorded. */
function recorder() {
  const asked: string[] = []
  const octokit = {
    graphql: async (query: string) => (asked.push(`graphql ${query}`), { viewer: { databaseId: 4242, login: 'acme-board[bot]' } }),
    users: {
      getAuthenticated: async () => (asked.push('GET /user'), Promise.reject(Object.assign(new Error('Resource not accessible by integration'), { status: 403 }))),
      getByUsername: async () => (asked.push('GET /users/{username}'), { data: { id: 4242 } }),
    },
    apps: { getAuthenticated: async () => (asked.push('GET /app'), { data: { slug: 'acme-board' } }) },
  }
  return { asked, octokit }
}

describe('github sync', () => {
  it("finds its bot's user ID from GraphQL's viewer, never REST's /user, which refuses an App", async () => {
    const provider = githubSync(secrets as never, repos({ 'acme/web': 'prs' }), { userName: 'acme-board[bot]' })!
    const adapter = (provider as unknown as { transport: { adapter: { detectBotUserId(octokit: unknown): Promise<void>; botUserId?: string } } }).transport.adapter
    const { asked, octokit } = recorder()
    await adapter.detectBotUserId(octokit)
    expect(asked).toEqual(['graphql query { viewer { databaseId login } }'])
    expect(adapter.botUserId).toBe('4242')
  })

  it('asks GitHub nothing when it is told its bot user ID', async () => {
    const provider = githubSync(secrets as never, repos({ 'acme/web': 'prs' }), { userName: 'acme-board[bot]', botUserId: 7 })!
    const adapter = (provider as unknown as { transport: { adapter: { detectBotUserId(octokit: unknown): Promise<void>; botUserId?: string } } }).transport.adapter
    const { asked, octokit } = recorder()
    await adapter.detectBotUserId(octokit)
    expect(asked).toEqual([])
    expect(adapter.botUserId).toBe('7')
  })
})
