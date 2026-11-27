import { describe, expect, it } from 'vitest'
import { legal } from '../src/legal.ts'

const HUB = 'https://board.dosu.ai'

describe("the hub's terms and privacy policy", () => {
  it('serves each at the hub, as a page that adds to Dosu’s own', async () => {
    for (const [path, title, dosu] of [['/terms', 'Terms of Service', 'https://dosu.dev/legal/terms'], ['/privacy', 'Privacy Policy', 'https://dosu.dev/legal/privacy']]) {
      const response = legal(new Request(`${HUB}${path}`), HUB)!
      expect(response.status, path).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const page = await response.text()
      expect(page).toContain(`<title>${title} · bordeaux</title>`)
      expect(page).toContain(`href="${dosu}"`)
    }
  })

  it('covers what sync copies from GitHub, Linear, and Slack, and the tokens it keeps', async () => {
    const terms = await legal(new Request(`${HUB}/terms`), HUB)!.text()
    expect(terms).toContain('<h2>4. Syncing GitHub, Linear, and Slack</h2>')
    const privacy = await legal(new Request(`${HUB}/privacy`), HUB)!.text()
    expect(privacy).toContain('<strong>From GitHub, Linear, and Slack, when an owner turns on sync:</strong>')
    expect(privacy).toContain('the tokens it grants, stored encrypted')
    expect(privacy).toContain("A Linear or Slack workspace's tokens, until it's unlinked")
  })

  it('leaves a team’s host, other paths, and writes to the board', () => {
    expect(legal(new Request('https://acme.board.dosu.ai/terms'), HUB)).toBeNull()
    expect(legal(new Request(`${HUB}/setup`), HUB)).toBeNull()
    expect(legal(new Request(`${HUB}/terms`, { method: 'POST' }), HUB)).toBeNull()
    expect(legal(new Request(`${HUB}/terms`), undefined)).toBeNull()
  })
})
