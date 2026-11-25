// SHIM (bordeaux): upstream's src/server/errors.ts helpers, on @vercel/board's public HttpError so
// board() answers them as its own. Codes and messages are upstream's at the pinned commit.
import { HttpError } from '@vercel/board'
import { MESSAGE_TEXT_MAX } from '../contract/schemas.ts'

export { HttpError }
export const badRequest = (message: string, code = 'invalid_request') => new HttpError(400, code, message)
export const unauthorized = (message: string) => new HttpError(401, 'unauthorized', message)
export const forbidden = (message: string) => new HttpError(403, 'forbidden', message)
export const notFound = (message: string, code = 'not_found') => new HttpError(404, code, message)
export const textTooLong = () =>
  new HttpError(400, 'text_too_long', `A message's text is at most ${MESSAGE_TEXT_MAX.toLocaleString('en-US')} characters.`, {
    hint: 'Put the long part in a file and attach it to a message, with a short summary as the text.',
  })
/** More tasks than a board makes in one batch: `most` is how many it does. */
export const batchTooLarge = (tasks: number, most: number) =>
  new HttpError(400, 'batch_too_large', `a batch makes ${most} tasks at most, and this one has ${tasks}: send it in parts`)
export const duplicateId = () => new HttpError(409, 'duplicate_id', 'that id was already used for a different write')
