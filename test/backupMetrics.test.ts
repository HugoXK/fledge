import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { MockRunner } from '../src/jobs/mock.js'
import { resetMetrics } from '../src/lib/metrics.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #693: backup age, copy counts and the restore drill's verdict are files and
// log lines. The admin card is the only stale-backup alarm, and a failed drill
// is not an alarm at all, so a night that stopped backing up goes unnoticed
// until someone opens the page. These tests pin the two exits that make the
// facts observable: the five gauges on the scrape, and one ops alert that rides
// the cooldown every other ops alert already uses.

const HOUR = 3_600_000

interface Fixture {
  root: string
  backupDir: string
  drillPath: string
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'fledge-backup-metrics-'))
  const backupDir = join(root, 'backups')
  mkdirSync(backupDir, { recursive: true })
  return { root, backupDir, drillPath: join(root, 'backup-drill.json') }
}

// The writer's file-name stamp: `fledge-2026-11-09T02-00-00-000Z.db`, with the
// colons and the dot replaced because a file name cannot hold them.
function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

function writeCopy(fx: Fixture, at: Date): void {
  writeFileSync(join(fx.backupDir, `fledge-${stamp(at)}.db`), 'backup bytes\n')
}

function writeDrill(fx: Fixture, record: { at: Date; ok: boolean; columnCheck?: string }): void {
  writeFileSync(fx.drillPath, JSON.stringify({ at: record.at.toISOString(), ok: record.ok, detail: null, ...(record.columnCheck === undefined ? {} : { columnCheck: record.columnCheck }) }))
}

function configFor(fx: Fixture) {
  return testConfig({ dataDir: fx.root, backup: { dir: fx.backupDir, expectedIntervalHours: 26 } })
}

function metricValue(body: string, name: string): number | null {
  const match = new RegExp(`^${name}(?:\\{[^}]*\\})? ([^\\s]+)$`, 'm').exec(body)
  return match === null ? null : Number(match[1])
}

async function scrape(fx: Fixture): Promise<string> {
  const store = new Store(':memory:')
  const built = await buildApp({ config: configFor(fx), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const response = await built.app.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' })
    assert.equal(response.statusCode, 200)
    return response.body
  } finally {
    // buildApp owns the store: closing both double-closes the SQLite handle.
    await built.close()
  }
}

function jobsFor(fx: Fixture, store: Store): Jobs {
  return new Jobs(store, configFor(fx), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
}

test('the scrape publishes the five backup and drill gauges and no path', async () => {
  const fx = fixture()
  try {
    writeCopy(fx, new Date(Date.now() - 2 * HOUR))
    writeDrill(fx, { at: new Date(Date.now() - HOUR), ok: true })
    resetMetrics()
    const body = await scrape(fx)
    const age = metricValue(body, 'fledge_backup_age_hours')
    assert.ok(age !== null && age > 1.5 && age < 26, `a two-hour-old copy must read under the 26-hour interval, got ${String(age)}`)
    assert.equal(metricValue(body, 'fledge_backup_copies'), 1)
    assert.equal(metricValue(body, 'fledge_backup_encrypted_copies'), 0)
    assert.equal(metricValue(body, 'fledge_restore_drill_ok'), 1, 'a fresh, successful drill must read 1')
    const drillAge = metricValue(body, 'fledge_restore_drill_age_hours')
    assert.ok(drillAge !== null && drillAge >= 0.9 && drillAge < 26, `the drill age must read about an hour, got ${String(drillAge)}`)
    // No label and no help line may carry a host path: /metrics is read by a
    // scraper that fans the text out further than the admin page ever did.
    assert.equal(body.includes(fx.backupDir), false, 'the backup directory must not reach the scrape')
    assert.equal(body.includes('backup-drill.json'), false, 'the drill file name must not reach the scrape')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
    resetMetrics()
  }
})

test('a stale copy flips the age series, and a fresh install publishes zero copies with no age', async () => {
  const fx = fixture()
  try {
    resetMetrics()
    const empty = await scrape(fx)
    assert.equal(metricValue(empty, 'fledge_backup_copies'), 0, 'a fresh install reports zero copies')
    assert.equal(metricValue(empty, 'fledge_restore_drill_ok'), 0, 'no drill record is not a passing drill')
    assert.equal(metricValue(empty, 'fledge_backup_age_hours'), null, 'no copy is unknown, not a zero age')

    writeCopy(fx, new Date(Date.now() - 34 * HOUR))
    const stale = await scrape(fx)
    const age = metricValue(stale, 'fledge_backup_age_hours')
    assert.ok(age !== null && age > 26, `a 34-hour-old copy must read over the interval, got ${String(age)}`)
    assert.equal(metricValue(stale, 'fledge_backup_copies'), 1)
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
    resetMetrics()
  }
})

test('a recorded failing or unreached column check zeroes the drill gauge, while skipped stays a pass', async () => {
  const fx = fixture()
  try {
    writeCopy(fx, new Date(Date.now() - 2 * HOUR))
    const at = new Date(Date.now() - HOUR)
    // A contradictory record (ok: true beside a failed check) is not a passing
    // drill: the card already refuses that reading, and the scrape must not keep
    // a green the page calls failed.
    writeDrill(fx, { at, ok: true, columnCheck: 'fail' })
    resetMetrics()
    assert.equal(metricValue(await scrape(fx), 'fledge_restore_drill_ok'), 0, 'a failed column check must not read as a passing drill')

    writeDrill(fx, { at, ok: true, columnCheck: 'not-reached' })
    resetMetrics()
    assert.equal(metricValue(await scrape(fx), 'fledge_restore_drill_ok'), 0, 'an unreached column check must not read as a passing drill')

    // A host with no column key configured is a legitimate configuration; its
    // drill did pass, and reading it as 0 would page that host on every scrape.
    writeDrill(fx, { at, ok: true, columnCheck: 'skipped' })
    resetMetrics()
    assert.equal(metricValue(await scrape(fx), 'fledge_restore_drill_ok'), 1, 'an unkeyed host is not a failing drill')

    writeDrill(fx, { at, ok: true, columnCheck: 'pass' })
    resetMetrics()
    assert.equal(metricValue(await scrape(fx), 'fledge_restore_drill_ok'), 1, 'a proven drill reads 1')

    // A record written before the field existed still reads its own verdict.
    writeDrill(fx, { at, ok: true })
    resetMetrics()
    assert.equal(metricValue(await scrape(fx), 'fledge_restore_drill_ok'), 1, 'a legacy record is not a failed check')
  } finally {
    rmSync(fx.root, { recursive: true, force: true })
    resetMetrics()
  }
})

test('a stale backup raises one ops alert, honours the cooldown and clears on a fresh copy', async () => {
  const fx = fixture()
  const store = new Store(':memory:')
  try {
    const admin = makeUser(store, { login: 'admin', admin: true, status: 'approved' })
    writeCopy(fx, new Date(Date.now() - 34 * HOUR))
    // The drill passed an hour ago: this test is about the copy going stale, and
    // an aged drill has its own alert.
    writeDrill(fx, { at: new Date(Date.now() - HOUR), ok: true })
    const jobs = jobsFor(fx, store)
    assert.equal(await jobs.notifyOpsAlerts(), 1, 'a copy older than the interval must alert')
    assert.equal(store.listNotifications(admin.id).length, 1)
    const message = store.listNotifications(admin.id)[0]?.message ?? ''
    assert.match(message, /newest copy is 3[34](\.\d+)? hours old/)
    assert.equal(message.includes(fx.backupDir), false, 'the alert must not carry the path')

    assert.equal(await jobs.notifyOpsAlerts(), 0, 'the existing cooldown holds the second pass')
    assert.equal(store.listNotifications(admin.id).length, 1)

    writeCopy(fx, new Date())
    assert.equal(await jobs.notifyOpsAlerts(), 0, 'a fresh copy resolves the alert')
    assert.equal(
      store.getSetting('ops_alert_notified:backup_stale:::'),
      undefined,
      'the cooldown marker clears with the alert, so the next stale night pages again',
    )
  } finally {
    store.close()
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('a failed or aged-out restore drill alerts while the copies are fresh', async () => {
  const fx = fixture()
  const store = new Store(':memory:')
  try {
    makeUser(store, { login: 'admin', admin: true, status: 'approved' })
    writeCopy(fx, new Date(Date.now() - HOUR))
    writeDrill(fx, { at: new Date(Date.now() - HOUR), ok: false })
    const jobs = jobsFor(fx, store)
    assert.equal(await jobs.notifyOpsAlerts(), 1, 'a failed drill must alert')

    writeDrill(fx, { at: new Date(Date.now() - 40 * HOUR), ok: true })
    resetCooldown(store)
    assert.equal(await jobs.notifyOpsAlerts(), 1, 'a drill older than the interval must alert')

    writeDrill(fx, { at: new Date(Date.now() - HOUR), ok: true })
    assert.equal(await jobs.notifyOpsAlerts(), 0, 'a fresh, successful drill resolves the alert')
    assert.equal(store.getSetting('ops_alert_notified:restore_drill:::'), undefined)
  } finally {
    store.close()
    rmSync(fx.root, { recursive: true, force: true })
  }
})

test('a fresh install with no copy and no drill raises no alert', async () => {
  const fx = fixture()
  const store = new Store(':memory:')
  try {
    makeUser(store, { login: 'admin', admin: true, status: 'approved' })
    assert.equal(await jobsFor(fx, store).notifyOpsAlerts(), 0, 'a platform that has never backed up must not page on install')
    assert.equal(store.getSetting('ops_alert_notified:backup_stale:::'), undefined)
    assert.equal(store.getSetting('ops_alert_notified:restore_drill:::'), undefined)
  } finally {
    store.close()
    rmSync(fx.root, { recursive: true, force: true })
  }
})

// The cooldown is the platform's, not the test's: dropping one marker is how a
// test asks "and the next night?" without waiting six hours.
function resetCooldown(store: Store): void {
  store.deleteSetting('ops_alert_notified:backup_stale:::')
  store.deleteSetting('ops_alert_notified:restore_drill:::')
}
