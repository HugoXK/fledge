#!/usr/bin/env node
// CI wrapper: create a disposable database with the current schema, take an
// online backup, restore it and verify the copy. Never touches a real database.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Store } from '../dist/db.js'

const dbDir = mkdtempSync(join(tmpdir(), 'fledge-drill-db-'))
const backupDir = mkdtempSync(join(tmpdir(), 'fledge-drill-backup-'))
const workDir = mkdtempSync(join(tmpdir(), 'fledge-drill-work-'))
try {
  const dbPath = join(dbDir, 'fledge.db')
  const store = new Store(dbPath)
  store.close()
  const result = spawnSync(process.execPath, ['scripts/restore-drill.mjs', '--db', dbPath, '--backup-dir', backupDir, '--work-dir', workDir, '--fresh'], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
} finally {
  rmSync(dbDir, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
}
