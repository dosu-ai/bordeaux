// A hosted team's platform tokens, sealed (spec 09, "Sync, later"): AES-GCM under the Worker's
// `BORDEAUX_SYNC_KEY`, 32 random bytes in base64, with what the token is for as associated data,
// so a sealed token can't be read as another team's or another platform's.

const keys = new Map<string, Promise<CryptoKey>>()

function keyOf(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    const bytes = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0))
    if (bytes.length !== 32) throw new Error('BORDEAUX_SYNC_KEY: 32 random bytes, in base64 (openssl rand -base64 32)')
    key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
    keys.set(secret, key)
  }
  return key
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/** `text`, sealed for `context`: a fresh IV and the ciphertext, in base64. */
export async function seal(secret: string, text: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, await keyOf(secret), new TextEncoder().encode(text)))
  const out = new Uint8Array(iv.length + sealed.length)
  out.set(iv)
  out.set(sealed, iv.length)
  return base64(out)
}

/** What `seal` sealed for the same `context`; it throws for any other. */
export async function unseal(secret: string, sealed: string, context: string): Promise<string> {
  const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0))
  const text = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(context) }, await keyOf(secret), bytes.slice(12))
  return new TextDecoder().decode(text)
}
