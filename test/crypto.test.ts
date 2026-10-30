import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { decryptSecret, encryptSecret, redact, signPayload, verifyPayload } from '../src/lib/secrets.js'

const key = randomBytes(32).toString('base64')

test('AES-256-GCM round-trips and rejects tampering', () => {
  const encrypted = encryptSecret('github_pat_secret_value', key)
  assert.match(encrypted, /^v1:/)
  assert.equal(decryptSecret(encrypted, key), 'github_pat_secret_value')
  const parts = encrypted.split(':')
  parts[3] = Buffer.from('tampered').toString('base64')
  assert.throws(() => decryptSecret(parts.join(':'), key))
})

test('a different key cannot decrypt', () => {
  const encrypted = encryptSecret('sk-test', key)
  const other = randomBytes(32).toString('base64')
  assert.throws(() => decryptSecret(encrypted, other))
})

test('signed payloads are tamper-evident and expire', () => {
  const token = signPayload({ user: 'octo' }, 'secret', 60)
  assert.equal(verifyPayload(token, 'secret')?.user, 'octo')
  assert.equal(verifyPayload(token, 'wrong'), null)
  const expired = signPayload({ user: 'octo' }, 'secret', -1)
  assert.equal(verifyPayload(expired, 'secret'), null)
})

test('redact strips keys and bearer tokens', () => {
  const text = 'sk-test-1234567890abcdef github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ Bearer abcdefghijklmnop api_key: 1234567890abcdef1234'
  const safe = redact(text)
  assert.doesNotMatch(safe, /sk-4knu/)
  assert.doesNotMatch(safe, /github_pat_11/)
  assert.doesNotMatch(safe, /abcdefghijklmnop/)
  assert.match(safe, /redacted/)
})
