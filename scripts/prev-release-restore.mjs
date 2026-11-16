#!/usr/bin/env node
// #652: restore the previous release's fixture with this build.
//
//   npm run db:prev-release:restore
//   node scripts/prev-release-restore.mjs --dir test/fixtures/prev-release
//
// The check itself lives in `src/lib/prevRelease.ts` and the suite runs the same
// function, so this wrapper only turns a failure into an exit code and a
// sentence an operator can act on. Nothing here touches a live database: the
// fixture is decompressed into a temp directory and restored there.
import { PREV_RELEASE_FIXTURE_DIR, PrevReleaseError, restorePreviousRelease } from '../dist/lib/prevRelease.js'

function arg(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const dir = arg('--dir') ?? PREV_RELEASE_FIXTURE_DIR
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write('usage: node scripts/prev-release-restore.mjs [--dir <fixture-dir>] [--key <base64>]\n')
  process.exit(0)
}

try {
  const result = restorePreviousRelease({ dir, keyBase64: arg('--key') })
  process.stdout.write(
    `previous-release restore: ok ${result.tag} schema ${String(result.fromVersion)} -> ${String(result.toVersion)}, ${String(result.tables)} tables, ${String(result.rows)} rows\n`,
  )
} catch (error) {
  if (error instanceof PrevReleaseError) {
    process.stderr.write(`previous-release restore: FAIL (${error.code}) — ${error.message}\n`)
    process.exit(1)
  }
  throw error
}
