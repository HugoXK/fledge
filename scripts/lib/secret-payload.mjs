#!/usr/bin/env node
// Column secrets: the AES-256-GCM payload `encryptSecret` writes in
// `src/lib/secrets.ts`, read here without importing the app. A payload is
// `v1:<iv>:<tag>:<ciphertext>` sealed with the default key, or
// `v2:<id>:<iv>:<tag>:<ciphertext>` sealed with a key the keyring names. A
// script cannot import the app's TypeScript, and a second copy of these rules
// would drift, so `test/columnCheck.test.ts` runs this reader and
// `decryptSecret` over the same vectors.
import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const DEFAULT_VERSION = 'v1'
export const KEYED_VERSION = 'v2'

const KEY_BYTES = 32
const NO_KEYS = Object.freeze({ key: null, keyring: Object.freeze({}) })

export class SecretKeyFileError extends Error {}

function decodeKey(base64, name) {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length !== KEY_BYTES) throw new SecretKeyFileError(`${name} must decode to exactly 32 bytes`)
  return bytes
}

function open(payload, key, offset) {
  const parts = payload.split(':')
  if (parts.length !== offset + 3) throw new Error('Malformed secret')
  const iv = parts[offset]
  const tag = parts[offset + 1]
  const data = parts[offset + 2]
  if (iv === undefined || tag === undefined || data === undefined) throw new Error('Malformed secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}

/**
 * Decrypt one column payload with the keys the caller was given. `key` is the
 * default key a `v1` payload needs; `keyring` maps the id a `v2` payload names.
 * An unknown id fails closed, exactly as the app does: the id is the writer's
 * claim about which key sealed it, never a reason to try the default one.
 */
export function decryptColumnPayload(payload, keys = NO_KEYS) {
  const parts = String(payload).split(':')
  if (parts[0] === DEFAULT_VERSION) {
    if (parts.length !== 4) throw new Error('Unsupported secret format')
    if (keys.key === null || keys.key === undefined) throw new SecretKeyFileError('the payload was written under the default key and the key file carries none')
    return open(payload, decodeKey(keys.key, 'the default key'), 1)
  }
  if (parts[0] === KEYED_VERSION) {
    const keyId = parts[1]
    if (parts.length !== 5 || keyId === undefined || keyId === '') throw new Error('Unsupported secret format')
    const named = keys.keyring?.[keyId]
    if (named === undefined) throw new Error(`unknown key id ${keyId}`)
    return open(payload, decodeKey(named, `key id ${keyId}`), 2)
  }
  throw new Error('Unsupported secret format')
}

/**
 * Read the key file the caller passed: one base64 32-byte key, or the keyring
 * JSON `{"<id>": "<base64 32 bytes>"}` the app's keyed configuration carries.
 * The file is the only source: this module never reads the process environment
 * and never opens an env file.
 */
export function readSecretKeyFile(path) {
  let text
  try {
    text = readFileSync(path, 'utf8').trim()
  } catch (error) {
    throw new SecretKeyFileError(`cannot read the secret key file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (text === '') throw new SecretKeyFileError(`the secret key file ${path} is empty`)
  if (!text.startsWith('{')) {
    decodeKey(text, 'the key')
    return { key: text, keyring: {} }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SecretKeyFileError(`the secret key file ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SecretKeyFileError(`the secret key file ${path} must be one base64 key or a JSON object of key ids`)
  }
  const keyring = {}
  for (const [id, value] of Object.entries(parsed)) {
    if (id === '' || id.includes(':')) throw new SecretKeyFileError(`secret key id ${id} is not usable: it must be non-empty and contain no colon`)
    if (typeof value !== 'string') throw new SecretKeyFileError(`secret key id ${id} must be a base64 string`)
    decodeKey(value, `key id ${id}`)
    keyring[id] = value
  }
  if (Object.keys(keyring).length === 0) throw new SecretKeyFileError(`the secret key file ${path} names no key`)
  return { key: null, keyring }
}
