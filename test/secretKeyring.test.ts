import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { decryptSecret, encryptSecret } from '../src/lib/secrets.js'
import { loadConfig } from '../src/config.js'

// #388: an encrypted value has to name the key that encrypted it, so a second
// key can be introduced without breaking the values already stored. This is the
// keyring half only: `v1` stays the default-key format, `v2` names its key id,
// and an id the process does not know fails closed instead of retrying with the
// default key. No rotation action is exercised because none is shipped.

const DEFAULT_KEY = randomBytes(32).toString('base64')
const SECOND_KEY = randomBytes(32).toString('base64')

function keysFile(contents: unknown): { dir: string; path: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-keyring-'))
  const path = join(dir, 'keys.json')
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), { mode: 0o600 })
  return { dir, path, close: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a v1 payload still decrypts with the default key alone', () => {
  const payload = encryptSecret('github-token', DEFAULT_KEY)
  assert.match(payload, /^v1:/)
  assert.equal(decryptSecret(payload, DEFAULT_KEY), 'github-token')
})

test('a v2 payload resolves its key id from TOKEN_ENCRYPTION_KEYS_FILE', () => {
  const file = keysFile({ k2: SECOND_KEY })
  try {
    loadConfig({ env: 'test', tokenEncryptionKeysFile: file.path })
    const payload = encryptSecret('rotated-token', SECOND_KEY, 'k2')
    assert.match(payload, /^v2:k2:/)
    assert.equal(decryptSecret(payload, DEFAULT_KEY), 'rotated-token')
    // The second argument is the v1/default key; a v2 payload resolves its key
    // from the id, so even a different default key leaves the plaintext intact.
    assert.equal(decryptSecret(payload, SECOND_KEY), 'rotated-token')
  } finally {
    file.close()
  }
})

test('an unknown key id fails closed and never retries with the default key', () => {
  const file = keysFile({})
  try {
    loadConfig({ env: 'test', tokenEncryptionKeysFile: file.path })
    const payload = encryptSecret('secret', SECOND_KEY, 'gone')
    assert.throws(() => decryptSecret(payload, DEFAULT_KEY), /unknown key id gone/)
  } finally {
    file.close()
  }
})

test('a key file with a short entry refuses to boot, naming the file and the id', () => {
  const file = keysFile({ k2: randomBytes(31).toString('base64') })
  try {
    assert.throws(
      () => loadConfig({ env: 'test', tokenEncryptionKeysFile: file.path }),
      (error: unknown) => {
        const message = String(error)
        assert.match(message, /TOKEN_ENCRYPTION_KEYS_FILE/)
        assert.ok(message.includes(file.path), 'the refusal names the file')
        assert.match(message, /key id k2/)
        return true
      },
    )
  } finally {
    file.close()
  }
})

test('an unreadable key file refuses to boot, naming the path', () => {
  const file = keysFile({})
  const missing = join(file.dir, 'absent.json')
  try {
    assert.throws(
      () => loadConfig({ env: 'test', tokenEncryptionKeysFile: missing }),
      (error: unknown) => {
        const message = String(error)
        assert.match(message, /TOKEN_ENCRYPTION_KEYS_FILE/)
        assert.ok(message.includes(missing), 'the refusal names the path')
        return true
      },
    )
  } finally {
    file.close()
  }
})

test('encryptSecret without an id still emits v1, so the existing call sites do not drift', () => {
  assert.match(encryptSecret('x', DEFAULT_KEY), /^v1:/)
  assert.match(encryptSecret('x', DEFAULT_KEY, undefined), /^v1:/)
})
