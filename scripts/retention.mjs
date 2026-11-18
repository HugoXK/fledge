#!/usr/bin/env node
// #281: report what the retention windows would delete — and nothing else.
//
// The windows live in `scripts/lib/retention.mjs`, the same table `Store.pruneOldData`
// runs, so this tool cannot count different rows than a deploy deletes. It opens
// the database read-only, holds no write lock, prints one count per class and
// never a row body, login, email or token value: a preview that leaks the data
// it is about to delete is worse than no preview.
//
// `--days` is required on purpose. A guessed default in a tool whose output is
// "how many rows will disappear" is how a window gets shortened by accident, so
// the operator states the number they are asking about.
//
//   node scripts/retention.mjs --dry-run --days 30
//   DB_PATH=/data/fledge.db node scripts/retention.mjs --dry-run --days 90
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { RETENTION_IDLE_TABLES, retentionCountsAt } from './lib/retention.mjs'

const USAGE = 'usage: node scripts/retention.mjs --dry-run --days <n> [--db <path>]'

function usageError(message) {
  console.error(`${USAGE}\n${message}`)
  process.exit(2)
}

let days
let dryRun = false
let dbPath = process.env.DB_PATH ?? join(process.env.DATA_DIR ?? './data', 'fledge.db')

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  if (arg === '--dry-run') {
    dryRun = true
  } else if (arg === '--days') {
    const raw = process.argv[index + 1]
    if (raw === undefined) usageError('--days needs a value: --days <n>')
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) usageError(`--days must be an integer >= 1, got "${raw}"`)
    days = n
    index += 1
  } else if (arg === '--db') {
    const raw = process.argv[index + 1]
    if (raw === undefined || raw === '') usageError('--db needs a value: --db <path>')
    dbPath = raw
    index += 1
  } else if (arg === '--help' || arg === '-h') {
    console.log(USAGE)
    process.exit(0)
  } else {
    usageError(`unknown argument: ${arg}`)
  }
}

if (days === undefined) usageError('--days is required: the window this preview counts at')

if (!dryRun) {
  // The tool is read-only either way; `--dry-run` is the explicit spelling the
  // runbook asks for. Saying so on stderr keeps stdout a plain count report.
  console.error('note: this tool never deletes rows; --dry-run is accepted for symmetry with other operator scripts.')
}

let db
try {
  db = new DatabaseSync(dbPath, { readOnly: true })
} catch (error) {
  console.error(`cannot open ${dbPath} read-only: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

try {
  const count = (sql, params) => Number(db.prepare(sql).get(...params)?.n ?? 0)
  for (const row of retentionCountsAt(count, days)) {
    console.log(`${row.key} count=${row.count} window=${days}d`)
  }
  // Two tables have no age window. Naming the reason is better than printing a
  // fabricated zero that reads as "nothing to delete".
  for (const table of RETENTION_IDLE_TABLES) {
    console.log(`${table.id} state=${table.state}`)
  }
} finally {
  db.close()
}
