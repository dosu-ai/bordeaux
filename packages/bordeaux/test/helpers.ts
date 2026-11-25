import { SELF } from 'cloudflare:test'

export const BASE = 'http://board.test'

/** A person's token from the dev route, as `bx` gets one from the broker. */
export async function tokenFor(id: number, login: string): Promise<string> {
  const response = await SELF.fetch(`${BASE}/__dev/token`, { method: 'POST', body: JSON.stringify({ id, login }) })
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
