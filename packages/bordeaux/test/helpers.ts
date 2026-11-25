import { SELF } from 'cloudflare:test'

export const BASE = 'https://board.test'

export async function tokenFor(id: number, login: string, audience?: string): Promise<string> {
  const response = await SELF.fetch(`${BASE}/__dev/token`, { method: 'POST', body: JSON.stringify({ id, login, ...(audience ? { audience } : {}) }) })
  return ((await response.json()) as { access_token: string }).access_token
}

/** A protocol request, as a client sends it. */
export async function api(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await SELF.fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: (await response.json()) as any }
}
