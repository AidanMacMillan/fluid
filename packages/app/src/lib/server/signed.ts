/**
 * Small signed values the Worker hands out and later takes back: HMAC-SHA256
 * over a JSON payload, as `payload.signature`, both base64url.
 *
 * Signed, not encrypted. What goes in them is either public already (a port,
 * the extension's own state) or a hash (the PKCE challenge, a code's digest),
 * and nothing secret — no token, no client secret — ever does. Signing is what
 * lets the Worker keep no storage: it can tell a value it made from one it did
 * not, and that is all it needs.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Imported keys, by secret, so a warm isolate does not import on every request. */
const keys = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    )
    keys.set(secret, key)
  }
  return key
}

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
    return Uint8Array.from(binary, (char) => char.charCodeAt(0))
  } catch {
    return null
  }
}

/** The unpadded base64url SHA-256 of `text`: a PKCE challenge, given a verifier. */
export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))))
}

/**
 * Compares two strings without stopping at the first difference, for the
 * digests a request is checked against.
 */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

export async function sign(payload: object, secret: string): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body))
  return `${body}.${base64url(new Uint8Array(signature))}`
}

/**
 * The payload of a value `sign` made with this secret, or null for anything
 * else. The comparison is `crypto.subtle.verify`'s, which does not leak how
 * much of a forged signature was right.
 */
export async function verify(value: string, secret: string): Promise<unknown> {
  const [body, signature, ...rest] = value.split('.')
  if (!body || !signature || rest.length > 0) return null

  const signatureBytes = fromBase64url(signature)
  if (!signatureBytes) return null
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signatureBytes,
    encoder.encode(body)
  )
  if (!valid) return null

  const bodyBytes = fromBase64url(body)
  if (!bodyBytes) return null
  try {
    return JSON.parse(decoder.decode(bodyBytes))
  } catch {
    return null
  }
}
