#!/usr/bin/env node
// Backup encryption: AES-256-GCM over a streamed online copy. A base64 32-byte
// key is used as-is; any other value is treated as a passphrase and stretched
// with scrypt and a random per-copy salt. The key id is a non-reversible
// fingerprint of the key the copy was encrypted with, never the key: for a
// passphrase that means the scrypt-stretched key, so the published id cannot be
// used as an offline verifier that skips the stretching cost.
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, createReadStream, createWriteStream, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export const BACKUP_ENVELOPE_FORMAT = 'fledge-backup'
export const BACKUP_ENVELOPE_VERSION = 1
export const BACKUP_KEY_VERSION = 1

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16
const HEADER_MAX_BYTES = 64 * 1024

export class BackupKeyError extends Error {}

function keyId(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

function stripTrailingNewlines(value) {
  return value.replace(/[\r\n]+$/, '')
}

function base64Key(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) return null
  const key = Buffer.from(value.padEnd(Math.ceil(value.length / 4) * 4, '='), 'base64')
  return key.length === KEY_BYTES ? key : null
}

export function loadBackupKey(env = process.env) {
  // Presence decides whether a source is configured, not non-emptiness: a
  // variable that exists but is empty is a broken expansion (a secret that
  // resolved to ""), and treating it as "unset" would silently write a
  // plaintext backup under a schedule that believes it is encrypting.
  const inline = env.BACKUP_ENCRYPTION_KEY
  const file = env.BACKUP_ENCRYPTION_KEY_FILE
  const hasInline = inline !== undefined
  const hasFile = file !== undefined
  if (hasInline && hasFile) {
    throw new BackupKeyError('set only one of BACKUP_ENCRYPTION_KEY and BACKUP_ENCRYPTION_KEY_FILE')
  }
  let secret
  let source
  if (hasFile) {
    try {
      secret = readFileSync(file, 'utf8')
    } catch (error) {
      throw new BackupKeyError(`cannot read BACKUP_ENCRYPTION_KEY_FILE ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    source = 'BACKUP_ENCRYPTION_KEY_FILE'
  } else if (hasInline) {
    secret = inline
    source = 'BACKUP_ENCRYPTION_KEY'
  } else {
    return null
  }
  secret = stripTrailingNewlines(secret)
  if (secret === '') throw new BackupKeyError(`the backup encryption key from ${source} is empty`)
  const raw = base64Key(secret)
  if (raw !== null) return { kind: 'raw', key: raw, id: keyId(raw), source }
  // No id yet: the fingerprint is over the stretched key, and the salt that
  // stretches it is random per copy, so it is computed where the copy is written.
  return { kind: 'passphrase', secret, source }
}

function encryptionMetadata(header) {
  return {
    format: header.format,
    version: header.version,
    algorithm: header.algorithm,
    keyId: header.keyId,
    keyVersion: header.keyVersion,
  }
}

export async function encryptBackupFile(plaintextPath, targetPath, keyInfo) {
  if (keyInfo === null) throw new BackupKeyError('no backup encryption key configured')
  const salt = keyInfo.kind === 'raw' ? undefined : randomBytes(SALT_BYTES)
  const key = keyInfo.kind === 'raw' ? keyInfo.key : scryptSync(keyInfo.secret, salt, KEY_BYTES)
  // The id names the key this copy is encrypted with, so it is computed from the
  // key and not from the key's input: for a passphrase the salt makes it per
  // copy, and guessing a passphrase from it costs a full scrypt per guess.
  const id = keyId(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  // The tag is only known after the ciphertext stream ends, so compose the
  // final file after streaming the body once: header line, then raw ciphertext.
  const bodyPath = `${targetPath}.body.tmp`
  try {
    await pipeline(createReadStream(plaintextPath), cipher, createWriteStream(bodyPath, { mode: 0o600 }))
    const header = {
      format: BACKUP_ENVELOPE_FORMAT,
      version: BACKUP_ENVELOPE_VERSION,
      algorithm: ALGORITHM,
      kdf: keyInfo.kind === 'raw' ? 'raw' : 'scrypt',
      keyId: id,
      keyVersion: BACKUP_KEY_VERSION,
      ...(salt === undefined ? {} : { salt: salt.toString('base64') }),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
    writeFileSync(targetPath, `${JSON.stringify(header)}\n`, { mode: 0o600 })
    await pipeline(createReadStream(bodyPath), createWriteStream(targetPath, { flags: 'a', mode: 0o600 }))
    chmodSync(targetPath, 0o600)
    return encryptionMetadata(header)
  } catch (error) {
    rmSync(targetPath, { force: true })
    throw error
  } finally {
    rmSync(bodyPath, { force: true })
  }
}

function validateEnvelope(header) {
  if (typeof header !== 'object' || header === null) throw new Error('not an encrypted backup: the envelope header is empty')
  if (header.format !== BACKUP_ENVELOPE_FORMAT || header.version !== BACKUP_ENVELOPE_VERSION) {
    throw new Error(`unsupported encrypted backup format ${String(header.format)} version ${String(header.version)}`)
  }
  if (header.algorithm !== ALGORITHM) throw new Error(`unsupported encrypted backup algorithm ${String(header.algorithm)}`)
  if (header.kdf !== 'raw' && header.kdf !== 'scrypt') throw new Error('not an encrypted backup: the envelope names no key derivation')
  if (header.kdf === 'scrypt' && typeof header.salt !== 'string') throw new Error('not an encrypted backup: the scrypt salt is missing')
  if (typeof header.keyId !== 'string' || typeof header.keyVersion !== 'number') throw new Error('not an encrypted backup: the key id or version is missing')
  if (typeof header.iv !== 'string' || typeof header.tag !== 'string') throw new Error('not an encrypted backup: the IV or authentication tag is missing')
  if (Buffer.from(header.iv, 'base64').length !== IV_BYTES) throw new Error('not an encrypted backup: the IV has the wrong length')
  if (Buffer.from(header.tag, 'base64').length !== TAG_BYTES) throw new Error('not an encrypted backup: the authentication tag has the wrong length')
}

export function readBackupEnvelope(path) {
  const fd = openSync(path, 'r')
  const buffer = Buffer.alloc(HEADER_MAX_BYTES)
  let bytesRead
  try {
    bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
  } finally {
    closeSync(fd)
  }
  const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
  if (newline < 0) throw new Error('not an encrypted backup: the envelope has no header line')
  let header
  try {
    header = JSON.parse(buffer.subarray(0, newline).toString('utf8'))
  } catch {
    throw new Error('not an encrypted backup: the envelope header is not valid JSON')
  }
  validateEnvelope(header)
  return { header, bodyOffset: newline + 1 }
}

function sameKeyId(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function decryptionKey(header, keyInfo) {
  if (header.kdf === 'raw') {
    if (keyInfo.kind !== 'raw') throw new BackupKeyError('the backup needs the base64 32-byte key it was written with, not a passphrase')
    return keyInfo.key
  }
  if (keyInfo.kind !== 'passphrase') throw new BackupKeyError('the backup needs the passphrase it was written with, not a raw key')
  return scryptSync(keyInfo.secret, Buffer.from(header.salt, 'base64'), KEY_BYTES)
}

export async function decryptBackupFile(path, targetPath, keyInfo) {
  if (keyInfo === null) throw new BackupKeyError('no backup encryption key configured')
  const { header, bodyOffset } = readBackupEnvelope(path)
  const key = decryptionKey(header, keyInfo)
  // The id is derived from the key, so the envelope salt is part of the cost of
  // checking it: a wrong passphrase pays the same scrypt the ciphertext does.
  const id = keyId(key)
  if (!sameKeyId(String(header.keyId), id)) {
    throw new BackupKeyError(`key id ${String(header.keyId)} does not match the configured key ${id}: wrong key or lost key`)
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(header.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(header.tag, 'base64'))
  try {
    await pipeline(createReadStream(path, { start: bodyOffset }), decipher, createWriteStream(targetPath, { mode: 0o600 }))
    chmodSync(targetPath, 0o600)
    return encryptionMetadata(header)
  } catch (error) {
    rmSync(targetPath, { force: true })
    throw new BackupKeyError(`decryption failed (authentication tag mismatch): wrong key or corrupt ciphertext; the backup cannot be restored: ${error instanceof Error ? error.message : String(error)}`)
  }
}
