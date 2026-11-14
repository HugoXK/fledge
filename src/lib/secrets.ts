import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const VERSION = 'v1'

// The recogniser lives in one module so a job log, a callback and a URL cannot
// drift onto different rules. This re-export keeps the existing import path.
export { redact, registerRedactionSecrets } from './redact.js'

export function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes')
  return key
}

export function encryptSecret(plain: string, keyBase64: string): string {
  const key = decodeKey(keyBase64)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':')
}

export function decryptSecret(payload: string, keyBase64: string): string {
  const parts = payload.split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unsupported secret format')
  const [, ivB64, tagB64, dataB64] = parts
  if (ivB64 === undefined || tagB64 === undefined || dataB64 === undefined) throw new Error('Malformed secret')
  const key = decodeKey(keyBase64)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
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
