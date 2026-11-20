import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// #388: the envelope names its key id in `v2`, so a second key can be
// introduced without breaking what is already stored. `v1` keeps the unnamed
// default-key format: every existing value and every existing call site stays
// valid, and a caller that passes no id still writes `v1`.
const VERSION = 'v1'
const KEYED_VERSION = 'v2'

/** The keys a `v2` payload may name, registered once at startup from config. */
export type SecretKeyring = Readonly<Record<string, string>>

let keyring: SecretKeyring = Object.freeze({})

// Registration is the only way in: no caller can name a key the deployment did
// not configure. Each entry is decoded here as well as in config, so a keyring
// built in a test cannot smuggle a short key past the same rule.
export function registerSecretKeyring(keys: SecretKeyring): void {
  const next: Record<string, string> = {}
  for (const [id, key] of Object.entries(keys)) {
    if (id === '' || id.includes(':')) throw new Error(`secret key id ${id} is not usable: it must be non-empty and contain no colon`)
    decodeKeyBytes(key, `key id ${id}`)
    next[id] = key
  }
  keyring = Object.freeze(next)
}

// The recogniser lives in one module so a job log, a callback and a URL cannot
// drift onto different rules. This re-export keeps the existing import path.
// `maskEmail` / `maskIp` (#694) are shapes an account is rendered by, not
// secrets, so they live beside `redact()` and are re-exported here too: the log
// sink and the pages import from one place.
export { maskEmail, maskIp, redact, registerRedactionSecrets } from './redact.js'

function decodeKeyBytes(keyBase64: string, name: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`)
  return key
}

export function decodeKey(keyBase64: string): Buffer {
  return decodeKeyBytes(keyBase64, 'TOKEN_ENCRYPTION_KEY')
}

function seal(plain: string, key: Buffer, prefix: string[]): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [...prefix, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
}

function open(payload: string, key: Buffer, offset: number): string {
  const parts = payload.split(':')
  if (parts.length !== offset + 3) throw new Error('Malformed secret')
  const ivB64 = parts[offset]
  const tagB64 = parts[offset + 1]
  const dataB64 = parts[offset + 2]
  if (ivB64 === undefined || tagB64 === undefined || dataB64 === undefined) throw new Error('Malformed secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
}

export function encryptSecret(plain: string, keyBase64: string, keyId?: string): string {
  const key = decodeKey(keyBase64)
  if (keyId === undefined) return seal(plain, key, [VERSION])
  if (keyId === '' || keyId.includes(':')) throw new Error('a secret key id must be non-empty and contain no colon')
  return seal(plain, key, [KEYED_VERSION, keyId])
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const parts = payload.split(':')
  if (parts[0] === VERSION) {
    if (parts.length !== 4) throw new Error('Unsupported secret format')
    return open(payload, decodeKey(keyBase64), 1)
  }
  if (parts[0] === KEYED_VERSION) {
    const keyId = parts[1]
    if (parts.length !== 5 || keyId === undefined || keyId === '') throw new Error('Unsupported secret format')
    const named = keyring[keyId]
    // Fail closed: an id this process does not know is an error, never a reason
    // to try the default key (a v2 write is the caller's claim about the key).
    if (named === undefined) throw new Error(`unknown key id ${keyId}`)
    return open(payload, decodeKeyBytes(named, `key id ${keyId}`), 2)
  }
  throw new Error('Unsupported secret format')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(12)}`
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export interface SignedPayload {
  [key: string]: unknown
  exp: number
}

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

export function signPayload(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }))
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

export function verifyPayload(token: string, secret: string): SignedPayload | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  if (!safeEqual(signature, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SignedPayload
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '••••'
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}
