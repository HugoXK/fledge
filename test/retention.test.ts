import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { adminPage } from '../src/views/pages.js'
import { SETTINGS_RETENTION, type RetentionWindows } from '../scripts/lib/retention.mjs'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #281: `pruneOldData` enforced ten age windows as literals inside one function,
// so nothing outside the code could read or preview one. This suite pins the
// first slice: the windows come from config with today's literal as the default,
// and `scripts/retention.mjs` reports — read-only — how many rows each window
// would delete at `--days N`.
const TOOL = fileURLToPath(new URL('../scripts/retention.mjs', import.meta.url))

// Spelled out rather than imported from the module under test: a regression in
// the id list or a default must show up here as a failure, not follow along.
const DEFAULT_WINDOWS = {
  oauthStates: 7,
  approvalTokens: 30,
  notificationsRead: 30,
  notificationsUnread: 90,
  events: 90,
  jobEvents: 365,
  webhookDeliveries: 30,
  outboxSent: 30,
  outboxDead: 90,
  outboxUnknown: 365,
  jobs: 365,
  // #371: the post-merge ledger shares the jobs window, so one run removes a
  // delivery and the job that produced it.
  deliveryOutcomes: 365,
  // #635: the loop funnel is a history, not a receipt: two years so a
  // year-over-year comparison still has the year before its window.
  productEvents: 730,
  auditLog: 365,
  quotaLedger: 730,
}

const DAY = 86_400_000

function runTool(dbPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DB_PATH: dbPath },
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function count(store: Store, table: string): number {
  return store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
}

/** One old row and one recent row per class, so a count that includes the recent row is visible. */
function seed(dbPath: string): void {
  const store = new Store(dbPath)
  try {
    const user = makeUser(store, { login: 'retention-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_retention', userId: user.id, owner: 'o', name: 'retention', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const old = new Date(Date.now() - 40 * DAY).toISOString()
    const recent = new Date(Date.now() - 1 * DAY).toISOString()
    for (const [id, finishedAt] of [['job_old', old], ['job_new', recent]] as const) {
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb_${id}`, platformTokenHash: '' })
      store.updateJob(id, { status: 'succeeded', finished_at: finishedAt })
    }
    const uid = user.id
    const sql = `
      INSERT INTO job_events (at, job_id, kind) VALUES ('${old}', 'job_old', 'note'), ('${recent}', 'job_new', 'note');
      INSERT INTO oauth_states (state_hash, created_at, expires_at) VALUES ('h_old', '${old}', '${old}'), ('h_new', '${recent}', '${recent}');
      INSERT INTO approval_tokens (token_hash, user_id, action, created_at, expires_at, used_at) VALUES ('t_old', '${uid}', 'approve', '${old}', '${old}', NULL), ('t_new', '${uid}', 'approve', '${recent}', '${recent}', NULL);
      INSERT INTO notifications (id, user_id, kind, message, created_at, read_at) VALUES
        ('n_old_read', '${uid}', 'test', 'old read', '${old}', '${old}'),
        ('n_new_read', '${uid}', 'test', 'new read', '${recent}', '${recent}'),
        ('n_old_unread', '${uid}', 'test', 'old unread', '${old}', NULL),
        ('n_new_unread', '${uid}', 'test', 'new unread', '${recent}', NULL);
      INSERT INTO events (at, name) VALUES ('${old}', 'test.old'), ('${recent}', 'test.new');
      INSERT INTO webhook_deliveries (delivery_id, event, received_at) VALUES ('d_old', 'push', '${old}'), ('d_new', 'push', '${recent}');
      INSERT INTO quota_ledger (at, user_id, cost_usd) VALUES ('${old}', '${uid}', 0.1), ('${recent}', '${uid}', 0.1);
      INSERT INTO audit_log (at, action, detail) VALUES
        ('${old}', 'test.old', 'login=leaky-user email=leaky@example.com token=leaky-token-value body=leaky-row-body'),
        ('${recent}', 'test.new', 'nothing to see');
      INSERT INTO notification_outbox (id, transport, destination, payload_json, idempotency_key, state, created_at, updated_at) VALUES
        ('o_sent_old', 'mail', 'a@example.com', '{}', 'k_sent_old', 'sent', '${old}', '${old}'),
        ('o_sent_new', 'mail', 'a@example.com', '{}', 'k_sent_new', 'sent', '${recent}', '${recent}'),
        ('o_dead_old', 'mail', 'a@example.com', '{}', 'k_dead_old', 'dead', '${old}', '${old}'),
        ('o_unknown_old', 'mail', 'a@example.com', '{}', 'k_unknown_old', 'unknown', '${old}', '${old}'),
        ('o_unknown_new', 'mail', 'a@example.com', '{}', 'k_unknown_new', 'unknown', '${recent}', '${recent}');
    `
    store.exec(sql)
  } finally {
    store.close()
  }
}

test('the dry run reports the count each window would delete and changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-retention-'))
  const dbPath = join(dir, 'fledge.db')
  try {
    seed(dbPath)
    const before = (() => {
      const store = new Store(dbPath)
      try {
        return ['jobs', 'job_events', 'audit_log', 'webhook_deliveries', 'quota_ledger', 'oauth_states', 'approval_tokens', 'notifications', 'events', 'notification_outbox'].map((table) => count(store, table))
      } finally {
        store.close()
      }
    })()

    const first = runTool(dbPath, ['--dry-run', '--days', '30'])
    assert.equal(first.status, 0, first.stderr)
    const expected: Record<string, number> = {
      oauth_states: 1,
      approval_tokens: 1,
      notifications_read: 1,
      notifications_unread: 1,
      events: 1,
      job_events: 1,
      webhook_deliveries: 1,
      outbox_sent: 1,
      outbox_dead: 1,
      outbox_unknown: 1,
      jobs: 1,
      audit_log: 1,
      quota_ledger: 1,
    }
    for (const [id, n] of Object.entries(expected)) {
      const match = new RegExp(`^${id} count=(\\d+) window=30d$`, 'm').exec(first.stdout)
      assert.ok(match, `no line for ${id} in:\n${first.stdout}`)
      assert.equal(Number(match[1]), n, `${id} counted the recent row as well or missed the old one`)
    }

    const second = runTool(dbPath, ['--dry-run', '--days', '30'])
    assert.equal(second.status, 0, second.stderr)
    assert.equal(second.stdout, first.stdout, 'two consecutive dry runs differ')

    const after = (() => {
      const store = new Store(dbPath)
      try {
        return ['jobs', 'job_events', 'audit_log', 'webhook_deliveries', 'quota_ledger', 'oauth_states', 'approval_tokens', 'notifications', 'events', 'notification_outbox'].map((table) => count(store, table))
      } finally {
        store.close()
      }
    })()
    assert.deepEqual(after, before, 'the dry run deleted rows')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--days is required rather than defaulted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-retention-'))
  const dbPath = join(dir, 'fledge.db')
  try {
    seed(dbPath)
    const result = runTool(dbPath, ['--dry-run'])
    assert.notEqual(result.status, 0, 'a dry run without --days exited 0')
    assert.match(`${result.stdout}${result.stderr}`, /--days/, 'the usage error does not name --days')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unset window reports today\'s literal as the effective default', () => {
  const config = loadConfig({})
  assert.deepEqual(config.retention.windows, DEFAULT_WINDOWS)
  for (const [id, configured] of Object.entries(config.retention.configured)) {
    assert.equal(configured, false, `${id} is marked configured with no env var set`)
  }
})

test('pruneOldData deletes by the configured window, not the built-in one', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'retention-window-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_retention_window', userId: user.id, owner: 'o', name: 'w', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    for (const [id, ageDays] of [['job_configured_old', 40], ['job_configured_new', 20]] as const) {
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb_${id}`, platformTokenHash: '' })
      store.updateJob(id, { status: 'succeeded', finished_at: new Date(Date.now() - ageDays * DAY).toISOString() })
    }
    store.pruneOldData({ ...DEFAULT_WINDOWS, jobs: 30 })
    assert.equal(store.getJob('job_configured_old'), undefined, 'a 40-day job survived a configured 30-day window')
    assert.notEqual(store.getJob('job_configured_new'), undefined, 'a 20-day job was deleted by a configured 30-day window')
  } finally {
    store.close()
  }
})

test('the tool names the two tables it has no age window for', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-retention-'))
  const dbPath = join(dir, 'fledge.db')
  try {
    seed(dbPath)
    const result = runTool(dbPath, ['--days', '30'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^sessions state=expiry-based$/m, 'sessions is not reported as expiry-based')
    assert.match(result.stdout, /^api_tokens state=no-age-window$/m, 'api_tokens is not reported as having no age window')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the dry run prints counts only, never a row body, login, email or token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-retention-'))
  const dbPath = join(dir, 'fledge.db')
  try {
    seed(dbPath)
    const result = runTool(dbPath, ['--dry-run', '--days', '30'])
    assert.equal(result.status, 0, result.stderr)
    for (const secret of ['leaky-user', 'leaky@example.com', 'leaky-token-value', 'leaky-row-body']) {
      assert.equal(result.stdout.includes(secret), false, `the dry run printed ${secret}`)
    }
    assert.equal(/^\S+ count=\d+ window=30d$/m.test(result.stdout), true, 'the per-class lines are not counts')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the admin page shows the effective window, marks a default and names the count', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'retention-admin', status: 'approved', superadmin: true })
    const html = adminPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      users: [],
      jobs: [],
      jobsPage: 1,
      jobsTotal: 0,
      audit: [],
      auditPage: 1,
      auditTotal: 0,
      perPage: 10,
      retention: [
        { id: 'jobs', days: 365, configured: false, count: 2 },
        { id: 'quotaLedger', days: 60, configured: true, count: 4 },
      ],
    })
    const card = /<section[^>]*id="retention"[\s\S]*?<\/section>/.exec(html)
    assert.ok(card !== null, 'the admin page has no retention card')
    assert.match(card[0], /365/)
    assert.match(card[0], /default/, 'the built-in window is not marked default')
    assert.match(card[0], /60/, 'the configured window is not shown')
    assert.match(card[0], />2</, 'the jobs count is not shown')
    assert.match(card[0], />4</, 'the quota ledger count is not shown')
  } finally {
    store.close()
  }
})

// #281 rework: two mutations survived this suite, so nothing proved the env var
// reached the scheduler. `retentionWindow(process.env[cls.env], …)` replaced by
// `retentionWindow(undefined, …)` and `pruneOldData(this.config.retention.windows)`
// replaced by `pruneOldData()` both left every case green. These two pin the
// wiring itself: one reads a real env var through `loadConfig`, the other
// watches what the tick hands the store.
test('a RETENTION_*_DAYS env var becomes the window and is marked configured', () => {
  const previous = process.env.RETENTION_JOBS_DAYS
  process.env.RETENTION_JOBS_DAYS = '30'
  try {
    const config = loadConfig({})
    assert.equal(config.retention.windows.jobs, 30, 'the env var did not reach the jobs window')
    assert.equal(config.retention.configured.jobs, true, 'a window read from the env var is not marked configured')
    // The other classes stay on their literal: one env var cannot move another.
    assert.equal(config.retention.windows.events, DEFAULT_WINDOWS.events)
    assert.equal(config.retention.configured.events, false)
  } finally {
    if (previous === undefined) delete process.env.RETENTION_JOBS_DAYS
    else process.env.RETENTION_JOBS_DAYS = previous
  }
})

test('the scheduler tick prunes by config.retention.windows, not by the built-in literals', async () => {
  const windows: RetentionWindows = { ...DEFAULT_WINDOWS, jobs: 30, events: 45 }
  const config = testConfig()
  config.retention = { windows, configured: config.retention.configured }
  const store = new Store(':memory:')
  const calls: RetentionWindows[] = []
  const original = store.pruneOldData.bind(store)
  // The tick must hand over the configured windows. A call with no argument
  // would take the store's built-in defaults, so that is a failure here rather
  // than a call to record.
  store.pruneOldData = (passed?: RetentionWindows) => {
    if (passed === undefined) throw new Error('the tick pruned without passing the configured windows')
    calls.push(passed)
    original(passed)
  }
  const silentRunner: Runner = { name: 'silent', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, silentRunner, new MemoryMailer())
  try {
    await jobs.tick()
    assert.equal(calls.length, 1, 'the first tick did not prune')
    const passed = calls[0]
    assert.ok(passed !== undefined, 'the tick recorded no prune call')
    assert.equal(passed.jobs, 30, 'the tick pruned jobs with a window config did not carry')
    assert.equal(passed.events, 45, 'the tick pruned events with a window config did not carry')
    assert.deepEqual(passed, config.retention.windows)
  } finally {
    store.close()
  }
})

test('pruneOldData refuses a zero-day window instead of deleting every row in it', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'retention-zero-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_retention_zero', userId: user.id, owner: 'o', name: 'zero', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_zero_old', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb_zero', platformTokenHash: '' })
    store.updateJob('job_zero_old', { status: 'succeeded', finished_at: new Date(Date.now() - 400 * DAY).toISOString() })
    assert.throws(() => store.pruneOldData({ ...DEFAULT_WINDOWS, jobs: 0 }), /retention window jobs must be a whole number of days >= 1, got 0/)
    assert.notEqual(store.getJob('job_zero_old'), undefined, 'a refused window still deleted the job')
    assert.throws(() => store.pruneOldData({ ...DEFAULT_WINDOWS, jobs: 1.5 }), /retention window jobs/)
  } finally {
    store.close()
  }
})

// Keep the compiler honest about the helper this file relies on; execFileSync is
// imported for parity with the other tool tests and used here so lint does not
// read it as dead weight.
void execFileSync

// #1008: the second retention table. `pruneOldData` also removes ten marker
// families from `settings`, and the preview counted none of them, so an operator
// read "nothing to delete" while a pass removed user-visible markers. The
// families are read from the table the delete uses, never from a copy: a copy
// would pass this test while the two lists drifted apart.
test('the preview counts every settings marker the prune deletes', () => {
  const store = new Store(':memory:')
  try {
    const now = Date.now()
    for (const family of SETTINGS_RETENTION) {
      store.setSetting(`${family.prefix}preview`, new Date(now - (family.days + 1) * DAY).toISOString())
    }
    // The store writes its own settings rows at migration time, so the fixture
    // counts only the families this table owns.
    const markers = (): number => SETTINGS_RETENTION.reduce((total, family) => total
      + (store.get<{ n: number }>('SELECT COUNT(*) AS n FROM settings WHERE key LIKE ?', `${family.prefix}%`)?.n ?? 0), 0)
    const before = markers()
    assert.equal(before, SETTINGS_RETENTION.length, 'one stale marker per family is seeded')

    const row = store.retentionCounts().find((entry) => entry.id === 'settingsMarkers')
    assert.ok(row, 'the preview names the settings class instead of omitting it')
    assert.equal(row.count, SETTINGS_RETENTION.length, 'every stale marker is counted, not only the job tables')

    store.pruneOldData()
    const after = markers()
    assert.equal(before - after, row.count, 'the preview count equals the rows the pass removes')
  } finally { store.close() }
})

test('a settings marker still inside its window is neither counted nor deleted', () => {
  const store = new Store(':memory:')
  try {
    const now = Date.now()
    const fresh = 'digest_sent:recent'
    store.setSetting(fresh, new Date(now - 1 * DAY).toISOString())
    const row = store.retentionCounts().find((entry) => entry.id === 'settingsMarkers')
    assert.equal(row?.count ?? 0, 0, 'a 14-day marker written yesterday is not deletable')
    store.pruneOldData()
    assert.notEqual(store.getSetting(fresh), undefined, 'and the pass leaves it in place')
  } finally { store.close() }
})
