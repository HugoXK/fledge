// #1233: verify the audit hash chain on a read-only copy.
//
//   npm run audit:verify -- --db /path/to/copy.db
//   npm run audit:verify -- --db /path/to/copy.db --json
//
// The app migrates an old database on the next start; this command never writes.
// Rows written before the chain existed are reported as unverified, not forged.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { verifyAuditChain, type AuditChainRow } from '../src/lib/auditChain.js'

const usage = 'usage: npm run audit:verify -- --db <path> [--json]'
const argv = process.argv.slice(2)
function valueOf(flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}
const dbArg = valueOf('--db') ?? process.env.DB_PATH
if (dbArg === undefined || dbArg === '') {
  console.error(usage)
  process.exit(2)
}
const path = resolve(dbArg)
if (!existsSync(path)) {
  console.error(`audit: ${path} does not exist`)
  process.exit(2)
}
const db = new DatabaseSync(path, { readOnly: true })
try {
  const columns = db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'hash') || !columns.some((column) => column.name === 'prev_hash')) {
    console.error('audit: the audit_log has no chain columns; start the current build once on a copy and verify that copy')
    process.exit(2)
  }
  const rows = db.prepare('SELECT id, at, user_id, action, detail, prev_hash, hash FROM audit_log ORDER BY id ASC').all() as unknown as AuditChainRow[]
  const startSetting = db.prepare("SELECT value FROM settings WHERE key = 'audit_chain_start_id'").get() as { value?: string } | undefined
  const startId = startSetting?.value !== undefined && /^\d+$/.test(startSetting.value) ? Number(startSetting.value) : null
  const result = verifyAuditChain(rows, startId)
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (result.ok) {
    console.log(`audit: ok — ${String(result.checked)} hashed row(s), ${String(result.unverifiedBeforeStart)} unverified before start #${String(result.startId ?? 'none')}`)
  } else {
    for (const error of result.errors) console.error(`audit: FAIL at #${String(error.id)}: ${error.reason}`)
    console.error(`audit: ${String(result.errors.length)} problem(s) in ${String(result.total)} row(s)`)
  }
  if (!result.ok) process.exitCode = 1
} finally {
  db.close()
}
