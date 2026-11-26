// Direct uploads' bytes (spec 08, "Files", Δ): `PUT <board>/__bordeaux/uploads/<id>?t=<secret>`
// streams the body into R2 through the Worker's binding. The board's DO says where it goes and how
// many bytes it takes; the upload's finish then checks R2 has exactly that many.
import { retried } from '../engine/reload.ts'
import { boardKey } from './backend.ts'
import type { Envelope } from '../engine/do.ts'
import type { BordeauxEnv } from './env.ts'
import type { Team } from './team.ts'

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })

/** The path a board's direct uploads are PUT to, under the board's own URL. */
export const UPLOADS = '/__bordeaux/uploads/'

export async function putUpload(request: Request, env: BordeauxEnv, team: Team, board: string | null, id: string): Promise<Response> {
  if (request.method !== 'PUT') return refuse(405, 'invalid_request', 'PUT the file')
  if (!env.FILES) return refuse(501, 'no_files', 'this board keeps no files: bind an R2 bucket as FILES')
  const secret = new URL(request.url).searchParams.get('t') ?? ''
  const stub = retried(() => env.BOARD.get(env.BOARD.idFromName(boardKey(team.id, board))))
  const answer = (await stub.uploadTarget(id, secret)) as Envelope
  if (!answer.ok) return refuse(answer.error.status, answer.error.code, answer.error.message)
  const { key, size, type } = answer.value as { key: string; size: number; type: string }
  const length = Number(request.headers.get('content-length') ?? NaN)
  if (length !== size) return refuse(400, 'size_mismatch', `this upload is ${size} bytes: send a Content-Length of ${size}`)
  if (!request.body) return refuse(400, 'invalid_request', 'the file is empty')
  // Written once: a key that has bytes already keeps them.
  if (await env.FILES.head(key)) return refuse(409, 'already_uploaded', `${id} has its bytes already: finish the upload`)
  await env.FILES.put(key, request.body, { httpMetadata: { contentType: type } })
  return new Response(null, { status: 200 })
}
