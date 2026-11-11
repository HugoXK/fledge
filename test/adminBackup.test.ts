import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { DEFAULT_EXPECTED_HOURS, readBackupStatus, SHA256_MAX_BYTES, type BackupStatus } from '../src/lib/backupStatus.js'
import { adminPage } from '../src/views/pages.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// 34 hours after the newest fixture copy, so the default 26-hour interval is
// the difference between "running" and "stopped a day ago".
const NOW = Date.parse('2026-11-10T12:00:00.000Z')

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function isoFromStamp(stamp: string): string {
  // `fledge-2026-11-09T02-00-00-000Z.db` carries the writer's ISO stamp with
  // the colons and the dot replaced, because a file name cannot hold them.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp)
  assert.ok(match !== null, `unexpected stamp ${stamp}`)
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
}

type ManifestRecord = { size?: number; sha256?: string } | 'none'

function writeCopy(dir: string, stamp: string, content: string, manifest: ManifestRecord): void {
  const name = `fledge-${stamp}.db`
  const path = join(dir, name)
  writeFileSync(path, content)
  if (manifest === 'none') return
  const record = {
    copy: name,
    createdAt: isoFromStamp(stamp),
    size: manifest.size ?? Buffer.byteLength(content),
    sha256: manifest.sha256 ?? digest(content),
    schemaVersion: 3,
    tables: { jobs: 1 },
  }
  writeFileSync(`${path}.json`, `${JSON.stringify(record, null, 2)}\n`)
}

function makeBackupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-admin-backup-'))
  // The newest copy is in step with its manifest.
  writeCopy(dir, '2026-11-09T02-00-00-000Z', 'newest backup bytes\n', {})
  // Same size as its manifest records, different digest: only hashing the copy
  // can tell that it is not the file the backup wrote.
  writeCopy(dir, '2026-11-08T02-00-00-000Z', 'older backup bytes!\n', { sha256: 'f'.repeat(64) })
  // Written before manifests existed: the drill reports that as a warning, so
  // the console must name it rather than call it a match.
  writeCopy(dir, '2026-11-07T02-00-00-000Z', 'no manifest here\n', 'none')
  return dir
}

function renderAdmin(locale: 'en' | 'zh', backup: BackupStatus): string {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: `backup-${locale}`, status: 'approved', superadmin: true })
    return adminPage({
      config: testConfig(),
      locale,
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      users: [],
      jobs: [],
      jobsPage: 1,
      jobsTotal: 0,
      audit: [],
      auditPage: 1,
      auditTotal: 0,
      perPage: 10,
      backup,
    })
  } finally {
    store.close()
  }
}

function card(html: string): string {
  const match = /<section[^>]*id="backups"[\s\S]*?<\/section>/.exec(html)
  assert.ok(match !== null, 'the admin page has no backup card')
  return match[0]
}

test('the backup surface names the newest copy, its age and the manifest that no longer matches', () => {
  const dir = makeBackupDir()
  try {
    const status = readBackupStatus({ dir, now: NOW })
    assert.equal(status.expectedHours, DEFAULT_EXPECTED_HOURS)
    assert.equal(status.present, true)
    assert.equal(status.copies.length, 3)
    const newest = status.newest
    assert.ok(newest !== null)
    assert.equal(newest.name, 'fledge-2026-11-09T02-00-00-000Z.db')
    assert.equal(newest.manifest, 'matches')
    assert.equal(newest.ageHours, 34)
    assert.equal(status.stale, true)
    const mismatched = status.copies.find((copy) => copy.manifest === 'differs')
    assert.ok(mismatched !== undefined)
    assert.equal(mismatched.name, 'fledge-2026-11-08T02-00-00-000Z.db')
    assert.equal(mismatched.manifestDetail, 'sha256')
    const bare = status.copies.find((copy) => copy.manifest === 'missing')
    assert.ok(bare !== undefined)
    assert.equal(bare.name, 'fledge-2026-11-07T02-00-00-000Z.db')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a copy newer than the expected interval is not called stale', () => {
  const dir = makeBackupDir()
  try {
    // 18 hours after the newest fixture copy.
    const status = readBackupStatus({ dir, now: Date.parse('2026-11-09T20:00:00.000Z') })
    assert.equal(status.newest?.ageHours, 18)
    assert.equal(status.stale, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a copy above the hashing cap is reported as not checked, never as a match', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-admin-backup-cap-'))
  try {
    const name = 'fledge-2026-11-09T02-00-00-000Z.db'
    const path = join(dir, name)
    // Sparse: the size is what the cap reads, so no bytes are written.
    writeFileSync(path, '')
    truncateSync(path, SHA256_MAX_BYTES + 1)
    const record = {
      copy: name,
      createdAt: '2026-11-09T02:00:00.000Z',
      size: SHA256_MAX_BYTES + 1,
      sha256: 'a'.repeat(64),
      schemaVersion: 3,
      tables: {},
    }
    writeFileSync(`${path}.json`, `${JSON.stringify(record, null, 2)}\n`)
    const status = readBackupStatus({ dir, now: NOW })
    assert.equal(status.newest?.manifest, 'not-checked')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a directory with no copy is refused by name, not shown as healthy', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-admin-backup-empty-'))
  try {
    const status = readBackupStatus({ dir: join(root, 'backups'), now: NOW })
    assert.equal(status.present, false)
    assert.equal(status.newest, null)
    assert.equal(status.copies.length, 0)
    assert.equal(status.stale, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the admin card shows the newest copy, the staleness, the mismatch and no restore or delete control', () => {
  const dir = makeBackupDir()
  try {
    const status = readBackupStatus({ dir, now: NOW })
    const en = renderAdmin('en', status)
    assert.match(en, /id="backups"/)
    assert.match(en, /fledge-2026-11-09T02-00-00-000Z\.db/)
    assert.match(en, /34 hours/)
    assert.match(en, /older than the expected 26 hours/)
    assert.match(en, /differs \(sha256\)/)
    assert.match(en, /Restore drill/)
    assert.match(en, /none recorded/)
    assert.doesNotMatch(card(en), /<form|<button/)

    const zh = renderAdmin('zh', status)
    assert.match(zh, /id="backups"/)
    assert.match(zh, /fledge-2026-11-09T02-00-00-000Z\.db/)
    assert.match(zh, /34 小时/)
    assert.match(zh, /预期的 26 小时/)
    assert.match(zh, /恢复演练/)
    assert.match(zh, /没有记录/)
    assert.doesNotMatch(card(zh), /<form|<button/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an instance that never wrote a backup says so, and names the command that writes one', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-admin-backup-none-'))
  try {
    const status = readBackupStatus({ dir: join(root, 'backups'), now: NOW })
    const en = renderAdmin('en', status)
    assert.match(en, /No backup copy recorded yet/)
    assert.match(en, /npm run db:backup/)
    assert.doesNotMatch(card(en), /<form|<button/)
    assert.doesNotMatch(card(en), /matches its manifest/)

    const zh = renderAdmin('zh', status)
    assert.match(zh, /还没有记录备份副本/)
    assert.match(zh, /npm run db:backup/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the admin route reads the backup directory the writer uses, from config', async () => {
  const dir = makeBackupDir()
  const store = new Store(':memory:')
  const config = testConfig({ backup: { dir, expectedIntervalHours: 26 } })
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'backup-admin', admin: true })
    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /id="backups"/)
    assert.match(page.body, /fledge-2026-11-09T02-00-00-000Z\.db/)
  } finally {
    await built.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BACKUP_DIR and BACKUP_EXPECTED_HOURS resolve where the writer resolves the directory', () => {
  const saved = { BACKUP_DIR: process.env.BACKUP_DIR, DATA_DIR: process.env.DATA_DIR, BACKUP_EXPECTED_HOURS: process.env.BACKUP_EXPECTED_HOURS }
  try {
    process.env.DATA_DIR = '/srv/fledge-data'
    delete process.env.BACKUP_DIR
    delete process.env.BACKUP_EXPECTED_HOURS
    const defaults = loadConfig({ env: 'test' })
    assert.equal(defaults.backup.dir, '/srv/fledge-data/backups')
    assert.equal(defaults.backup.expectedIntervalHours, 26)

    process.env.BACKUP_DIR = '/srv/fledge-backups'
    process.env.BACKUP_EXPECTED_HOURS = '6'
    const overridden = loadConfig({ env: 'test' })
    assert.equal(overridden.backup.dir, '/srv/fledge-backups')
    assert.equal(overridden.backup.expectedIntervalHours, 6)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
