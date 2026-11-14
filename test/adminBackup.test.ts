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
import { DEFAULT_EXPECTED_HOURS, readBackupStatus, readRestoreDrill, SHA256_MAX_BYTES, type BackupStatus, type RestoreDrillStatus } from '../src/lib/backupStatus.js'
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
  // Same size as its manifest records, different digest. Only the newest copy is
  // hashed on a render, so this one must read "size matches, sha256 not checked"
  // rather than borrowing a comparison that never happened.
  writeCopy(dir, '2026-11-08T02-00-00-000Z', 'older backup bytes!\n', { sha256: 'f'.repeat(64) })
  // Written before manifests existed: the drill reports that as a warning, so
  // the console must name it rather than call it a match.
  writeCopy(dir, '2026-11-07T02-00-00-000Z', 'no manifest here\n', 'none')
  return dir
}

function renderAdmin(locale: 'en' | 'zh', backup: BackupStatus, drill: RestoreDrillStatus | null = null): string {
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
      drill,
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

test('the backup surface names the newest copy, its age and what its manifest said', () => {
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
    assert.equal(status.matching, 1)
    assert.equal(status.differing, 0)
    // The older copy records another digest, but its bytes are not read: only the
    // newest copy is hashed, so this row says what was checked and no more.
    const older = status.copies.find((copy) => copy.name === 'fledge-2026-11-08T02-00-00-000Z.db')
    assert.ok(older !== undefined)
    assert.equal(older.manifest, 'size-only')
    assert.equal(older.manifestDetail, null)
    const bare = status.copies.find((copy) => copy.manifest === 'missing')
    assert.ok(bare !== undefined)
    assert.equal(bare.name, 'fledge-2026-11-07T02-00-00-000Z.db')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a newest copy whose bytes disagree with its manifest is reported as differing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-admin-backup-sha-'))
  try {
    // Size agrees with the manifest, the digest does not: only reading the bytes
    // of the newest copy can find this, and that copy is the one that is read.
    writeCopy(dir, '2026-11-09T02-00-00-000Z', 'newest backup bytes\n', { sha256: '0'.repeat(64) })
    const status = readBackupStatus({ dir, now: NOW })
    assert.equal(status.newest?.manifest, 'differs')
    assert.equal(status.newest?.manifestDetail, 'sha256')
    assert.equal(status.matching, 0)
    assert.equal(status.differing, 1)
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

test('the copies summary counts contradictions and legacy manifests without listing every benign copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-admin-backup-summary-'))
  try {
    // Newest above the cap: its size agrees, its sha256 is never read.
    const name = 'fledge-2026-11-09T02-00-00-000Z.db'
    const path = join(dir, name)
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
    // An older copy from before manifests existed: nothing to compare it with.
    writeCopy(dir, '2026-11-08T02-00-00-000Z', 'no manifest here\n', 'none')
    const status = readBackupStatus({ dir, now: NOW })
    assert.equal(status.copies.length, 2)
    assert.equal(status.matching, 0)
    // Neither copy contradicts a manifest, and neither is summed as if it had.
    assert.equal(status.differing, 0)

    const en = card(renderAdmin('en', status))
    assert.match(en, /2 copies · no copy differs from its manifest · 1 without a manifest/)
    assert.doesNotMatch(en, /not matching the manifest/)
    assert.doesNotMatch(en, /all match their manifest/)
    assert.doesNotMatch(en, /with sha256 not checked/)
    // The newest copy's own row still says its sha256 was never read.
    assert.match(en, /not checked \(copy above 4 MiB\)/)
    // The legacy copy is summarised, not repeated as a row.
    assert.doesNotMatch(en, /fledge-2026-11-08T02-00-00-000Z\.db/)

    const zh = card(renderAdmin('zh', status))
    assert.match(zh, /2 个副本 · 没有副本与清单不符 · 1 个没有清单/)
    assert.doesNotMatch(zh, /都与清单相符/)
    assert.doesNotMatch(zh, /未核对 sha256/)
    assert.doesNotMatch(zh, /fledge-2026-11-08T02-00-00-000Z\.db/)
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

test('the admin card shows the newest copy, the staleness, a summary and no restore or delete control', () => {
  const dir = makeBackupDir()
  try {
    const status = readBackupStatus({ dir, now: NOW })
    const en = renderAdmin('en', status)
    assert.match(en, /id="backups"/)
    assert.match(en, /fledge-2026-11-09T02-00-00-000Z\.db/)
    assert.match(en, /34 hours/)
    assert.match(en, /older than the expected 26 hours/)
    assert.match(en, /matches \(size and sha256\)/)
    // Older copies are summarised, not listed one by one.
    assert.match(en, /3 copies · no copy differs from its manifest · 1 without a manifest/)
    assert.doesNotMatch(en, /size matches, sha256 not checked/)
    assert.doesNotMatch(card(en), /fledge-2026-11-08T02-00-00-000Z\.db/)
    assert.match(en, /Only copies that differ or cannot be read are listed/)
    assert.match(en, /Restore drill/)
    assert.match(en, /none recorded/)
    assert.doesNotMatch(card(en), /<form|<button/)

    const zh = renderAdmin('zh', status)
    assert.match(zh, /id="backups"/)
    assert.match(zh, /fledge-2026-11-09T02-00-00-000Z\.db/)
    assert.match(zh, /34 小时/)
    assert.match(zh, /预期的 26 小时/)
    assert.match(zh, /相符（大小与 sha256 一致）/)
    assert.match(zh, /3 个副本 · 没有副本与清单不符 · 1 个没有清单/)
    assert.doesNotMatch(zh, /大小相符，未核对 sha256/)
    assert.match(zh, /只列出真正不符或无法读取的副本/)
    assert.match(zh, /恢复演练/)
    assert.match(zh, /没有记录/)
    assert.doesNotMatch(card(zh), /<form|<button/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the restore drill row shows the last real run, not a fixed "none recorded"', () => {
  const dir = makeBackupDir()
  try {
    const status = readBackupStatus({ dir, now: NOW })
    const drill: RestoreDrillStatus = { at: '2026-11-12T03:41:19.000Z', ok: true, detail: 'RTO=0.029s RPO=30677.572s' }
    const en = card(renderAdmin('en', status, drill))
    assert.match(en, /Restore drill/)
    assert.match(en, /ok/)
    assert.match(en, /RTO=0\.029s/)
    assert.doesNotMatch(en, /none recorded/)

    const failed = card(renderAdmin('en', status, { at: '2026-11-12T03:41:19.000Z', ok: false, detail: null }))
    assert.match(failed, /failed/)

    const zh = card(renderAdmin('zh', status, drill))
    assert.match(zh, /恢复演练/)
    assert.match(zh, /成功/)
    assert.match(zh, /RTO=0\.029s/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readRestoreDrill treats a missing or malformed record as no record', () => {
  const root = mkdtempSync(join(tmpdir(), 'fledge-admin-drill-'))
  try {
    assert.equal(readRestoreDrill(join(root, 'backup-drill.json')), null)
    writeFileSync(join(root, 'backup-drill.json'), '{"at":')
    assert.equal(readRestoreDrill(join(root, 'backup-drill.json')), null)
    writeFileSync(join(root, 'backup-drill.json'), '{"at":"2026-11-12T03:41:19.000Z","ok":true}')
    assert.deepEqual(readRestoreDrill(join(root, 'backup-drill.json')), {
      at: '2026-11-12T03:41:19.000Z',
      ok: true,
      detail: null,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a card with a newest copy that disagrees says so and counts exactly one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-admin-backup-differs-'))
  try {
    writeCopy(dir, '2026-11-09T02-00-00-000Z', 'newest backup bytes\n', { sha256: '0'.repeat(64) })
    const status = readBackupStatus({ dir, now: NOW })
    const en = renderAdmin('en', status)
    assert.match(en, /differs \(sha256\)/)
    assert.match(en, /1 differs from its manifest/)
    assert.doesNotMatch(en, /no copy differs from its manifest/)
    const zh = renderAdmin('zh', status)
    assert.match(zh, /不符（sha256）/)
    assert.match(zh, /1 个与清单不符/)
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
    // Zero copies is "nothing to check", never "all match their manifest".
    assert.match(en, /0 copies · nothing to check/)
    assert.doesNotMatch(card(en), /matches its manifest/)
    assert.doesNotMatch(card(en), /all match their manifest/)

    const zh = renderAdmin('zh', status)
    assert.match(zh, /还没有记录备份副本/)
    assert.match(zh, /npm run db:backup/)
    assert.match(zh, /0 个副本 · 没有副本可核对/)
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
