import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256File } from '../scripts/lib/backup-manifest.mjs'

// `readFileSync` refuses any file above 2 GiB - 1 (ERR_FS_FILE_TOO_LARGE), so
// hashing by reading the whole file into memory made every backup and drill on
// an instance that large fail. The test file is sparse, so its size costs no
// disk, but the hash still reads every byte.
const READFILE_LIMIT = 2 * 1024 * 1024 * 1024
const SMALL_CONTENT = 'fledge backup manifest fixture\n'
// Recorded with `sha256sum` before the fix. The digest must not change: the
// manifest stores it, and a copy written by the old tool has to keep matching.
const SMALL_SHA256 = 'ede5685b6b3c1a4cd443ce86cf0f77578660923002c83841f99665312ec032e2'

async function streamedSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

test('sha256File hashes a file above the 2 GiB readFileSync limit', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-hash-'))
  try {
    const big = join(root, 'big.db')
    writeFileSync(big, '')
    truncateSync(big, READFILE_LIMIT + 1)
    const digest = await sha256File(big)
    assert.match(digest, /^[0-9a-f]{64}$/)
    assert.equal(digest, await streamedSha256(big))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sha256File keeps the recorded digest for a small file', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-hash-'))
  try {
    const small = join(root, 'small.db')
    writeFileSync(small, SMALL_CONTENT)
    assert.equal(await sha256File(small), SMALL_SHA256)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
