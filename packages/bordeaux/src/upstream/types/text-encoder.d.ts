// SHIM (bordeaux): upstream is typed against TypeScript's DOM lib, where `TextEncoder.encode()` is a
// Uint8Array over a plain ArrayBuffer, as it is at runtime. Workers' types leave the buffer open, which
// the vendored http() backend can't send as a body, so this says what the runtime does. It comes after
// Workers' types (the reference below) so that its overload is the one TypeScript tries first.
/// <reference types="@cloudflare/workers-types" />
interface TextEncoder {
  encode(input?: string): Uint8Array<ArrayBuffer>
}
