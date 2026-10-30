#!/usr/bin/env node
// Online SQLite backup; safe to run while Fledge is serving.
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DatabaseSync, backup } = require('node:sqlite')

const dbPath = resolve(process.env.DB_PATH ?? join(process.env.DATA_DIR ?? './data', 'fledge.db'))
const outDir = resolve(process.env.BACKUP_DIR ?? './backups')
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const target = join(outDir, `fledge-${stamp}.db`)

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  await backup(db, target)
  console.log(`backup written to ${target}`)
} finally {
  db.close()
}
