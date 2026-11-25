// SHIM (bordeaux): the shape of upstream's board reads that the vendored feed uses.
import type { Message } from '../contract/folds.ts'
import type { Access } from './access.ts'
import type { Reader } from './feed.ts'

export type BoardReads = {
  messagesAt(ids: readonly number[], index: number, signal?: AbortSignal): Promise<Map<number, Message>>
  reader(access: Access, messages: Iterable<Message>): Promise<Reader>
}
