import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { UserRow } from '../src/db.js'
import { purgeExpiredTrialAccounts, sweepExpiredTrials } from '../src/users/trial.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #690: a rejected preview account is erased once its `trial.expired` row is past
// the grace window. The delete set is proven, not asserted: the completeness test
// walks every table that carries a `user_id` or `repo_id` column, so a function
// narrowed to the tables only one slice remembered fails here.
const HOUR = 3_600_000
const NOW = new Date('2026-11-15T12:00:00.000Z')
const STAMP = NOW.toISOString()

function rejectedSince(store: Store, login: string, hoursOld: number): UserRow {
  const user = makeUser(store, { login, status: 'rejected' })
  store.audit(user.id, 'trial.expired', 'no repository within 7 days of registration')
  store.run(
    'UPDATE audit_log SET at = ? WHERE user_id = ? AND action = ?',
    new Date(NOW.getTime() - hoursOld * HOUR).toISOString(),
    user.id,
    'trial.expired',
  )
  return store.userById(user.id)!
}

function retentionRows(store: Store) {
  return store.listAudit(200).filter((row) => row.action === 'trial.purged')
}

function skipRows(store: Store) {
  return store.listAudit(200).filter((row) => row.action === 'trial.purge_skipped')
}

function rowsLeft(store: Store, userId: string, repoIds: string[]): Array<{ table: string; column: string; count: number }> {
  const tables = store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  const marks = repoIds.map(() => '?').join(', ')
  const left: Array<{ table: string; column: string; count: number }> = []
  for (const { name } of tables) {
    const columns = store.all<{ name: string }>(`PRAGMA table_info(${name})`).map((column) => column.name)
    if (columns.includes('user_id')) {
      const count = Number(store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name} WHERE user_id = ?`, userId)?.n ?? 0)
      if (count > 0) left.push({ table: name, column: 'user_id', count })
    }
    if (columns.includes('repo_id') && repoIds.length > 0) {
      const count = Number(store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name} WHERE repo_id IN (${marks})`, ...repoIds)?.n ?? 0)
      if (count > 0) left.push({ table: name, column: 'repo_id', count })
    }
  }
  return left
}

test('an account inside the grace window is kept; one past it is erased', () => {
  const store = new Store(':memory:')
  try {
    const young = rejectedSince(store, 'trial-71h', 71)
    const old = rejectedSince(store, 'trial-73h', 73)
    const config = testConfig({ trialPurgeGraceHours: 72 })

    const preview = purgeExpiredTrialAccounts(store, config, { now: NOW, dryRun: true })
    assert.deepEqual(
      preview.candidates.map((row) => row.login),
      ['trial-73h'],
      'the candidate list did not respect the grace window',
    )
    assert.deepEqual(preview.purged, [], 'a dry run purged something')
    assert.ok(store.userById(young.id), 'the dry run erased an account')
    assert.ok(store.userById(old.id), 'the dry run erased an account')

    const run = purgeExpiredTrialAccounts(store, config, { now: NOW })
    assert.deepEqual(run.purged, ['trial-73h'], 'the account past the window was not purged')
    assert.equal(store.userById(old.id), undefined, 'the purged account still exists')
    assert.ok(store.userById(young.id), 'the account inside the window was purged early')

    const retention = retentionRows(store)
    assert.equal(retention.length, 1, 'the purge wrote no retention row')
    assert.equal(retention[0]!.user_id, null, 'the retention row carries the account id')
  } finally {
    store.close()
  }
})

test('an account that used the platform is kept and the skip names the blocking resource', () => {
  const store = new Store(':memory:')
  try {
    const user = rejectedSince(store, 'trial-used', 73)
    store.createRepo({
      id: 'repo_used',
      userId: user.id,
      owner: 'octo',
      name: 'used',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })

    const candidates = store.trialPurgeCandidates(STAMP, 72)
    assert.equal(candidates.length, 1, 'the used account is not offered to the phase')
    assert.equal(candidates[0]!.repos, 1, 'the candidate row did not count the repository')

    const run = purgeExpiredTrialAccounts(store, testConfig({ trialPurgeGraceHours: 72 }), { now: NOW })
    assert.deepEqual(run.purged, [], 'a used account was purged')
    assert.equal(run.skipped.length, 1, 'the skip was not reported')
    assert.equal(run.skipped[0]!.repos, 1)
    assert.match(run.skipped[0]!.reason, /1 repo/, 'the skip reason does not name the repository')
    assert.ok(store.userById(user.id), 'the used account was erased')
    assert.equal(retentionRows(store).length, 0, 'a skip wrote a purge record')

    const skip = skipRows(store)
    assert.equal(skip.length, 1, 'the skip was not audited')
    assert.equal(skip[0]!.user_id, user.id, 'the skip row does not name the account it kept')
    assert.match(skip[0]!.detail ?? '', /1 repo/, 'the skip detail does not carry the counts')
    assert.doesNotMatch(skip[0]!.detail ?? '', /trial-used|@example\.com/, 'the skip detail carries an identity')
  } finally {
    store.close()
  }
})

test('a second run converges: nothing is purged twice and the retention row is written once', () => {
  const store = new Store(':memory:')
  try {
    const user = rejectedSince(store, 'trial-once', 73)
    const config = testConfig({ trialPurgeGraceHours: 72 })

    const first = purgeExpiredTrialAccounts(store, config, { now: NOW })
    assert.deepEqual(first.purged, ['trial-once'])

    // The id is gone, so a hand-run of the same step is a no-op rather than an
    // error; every step of the purge is idempotent by user id.
    const direct = store.purgeUserRows(user.id, { reason: 'trial.expired', operator: 'trial.sweep' })
    assert.equal(direct.removed, false, 'purging an erased id removed something')
    const second = purgeExpiredTrialAccounts(store, config, { now: NOW })
    assert.deepEqual(second.purged, [], 'the second run purged again')
    assert.deepEqual(second.candidates, [], 'the second run still offers the erased account')
    assert.equal(retentionRows(store).length, 1, 'the purge wrote a second retention row')
  } finally {
    store.close()
  }
})

test('the retention row keeps the spend per currency, the unpriced count and no identity', () => {
  const store = new Store(':memory:')
  try {
    const user = rejectedSince(store, 'trial-spender', 73)
    // A pre-#636 row: priced, NULL currency, which is USD.
    store.recordUsage(user.id, null, 0.5)
    // A real non-USD amount; folding it into USD would invent a rate.
    store.recordUsage(user.id, null, 7, null, null, { currency: 'CNY' })
    // The one truly unpriced row: `cost_known = 0`, not a NULL currency.
    store.recordUsage(user.id, null, 0, null, null, { currency: null, known: false })

    const run = purgeExpiredTrialAccounts(store, testConfig({ trialPurgeGraceHours: 72 }), { now: NOW })
    assert.deepEqual(run.purged, ['trial-spender'])

    const retention = retentionRows(store)[0]!
    const detail = JSON.parse(retention.detail ?? '{}') as {
      reason?: string
      operator?: string
      rows?: Record<string, number>
      spend?: { buckets?: Array<{ currency: string; amount: number; requests: number }>; unknownRequests?: number }
    }
    assert.equal(detail.reason, 'trial.expired')
    assert.equal(detail.operator, 'trial.sweep')
    assert.deepEqual(
      detail.spend?.buckets,
      [
        { currency: 'CNY', amount: 7, requests: 1 },
        { currency: 'USD', amount: 0.5, requests: 1 },
      ],
      'the spend was not kept as one bucket per currency',
    )
    assert.equal(detail.spend?.unknownRequests, 1, 'the unpriced row was not counted')
    assert.equal(detail.rows?.quota_ledger, 3, 'the row counts do not name the ledger rows')
    assert.equal(
      Number(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM quota_ledger WHERE user_id = ?', user.id)?.n ?? 0),
      0,
      'the ledger rows survived the purge',
    )

    // The retention row is the record, so it may not carry the account.
    assert.ok(!(retention.detail ?? '').includes('trial-spender'), 'the retention row carries the login')
    assert.ok(!(retention.detail ?? '').includes(user.id), 'the retention row carries the account id')
    assert.ok(!(retention.detail ?? '').includes('@example.com'), 'the retention row carries the address')
  } finally {
    store.close()
  }
})

test('the purge leaves no row naming the account or its repositories in any table', () => {
  const store = new Store(':memory:')
  try {
    const user = rejectedSince(store, 'trial-owner', 73)
    const repo = store.createRepo({
      id: 'repo_owner',
      userId: user.id,
      owner: 'octo',
      name: 'owned',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    store.createApiToken({ id: 'tok_owner', userId: user.id, kind: 'job', name: 'job:j1', tokenHash: 'h1', prefix: 'flg_own', expiresAt: null })
    store.createJob({ id: 'job_owner', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: 'h1' })
    store.recordUsage(user.id, 'job_owner', 0.25, null, repo.id)
    store.run(
      `INSERT INTO repo_instances (repo_id, user_id, container, network, data_dir, bridge_script, dsh_port, bridge_port, model_port, model_bind, image, status, created_at, updated_at)
       VALUES (?, ?, 'c', 'n', '/tmp/d', 'b', 1, 2, 3, '127.0.0.1', 'img', 'running', ?, ?)`,
      repo.id,
      user.id,
      STAMP,
      STAMP,
    )
    // The one repo-scoped table with a plain `repo_id`: the artifact rows would
    // survive the repository if the purge did not delete them by hand.
    store.run(
      `INSERT INTO artifact_versions (id, artifact, version, hash, content, status, created_at, repo_id)
       VALUES ('art_owner', 'plan', 1, 'hash', 'body', 'candidate', ?, ?)`,
      STAMP,
      repo.id,
    )
    store.run("INSERT INTO artifact_pointers (artifact, channel, version_id, updated_at) VALUES ('plan', 'dev', 'art_owner', ?)", STAMP)
    store.run('INSERT INTO events (at, user_id, name, repo_id, job_id) VALUES (?, ?, ?, ?, ?)', STAMP, user.id, 'job.finished', repo.id, 'job_owner')
    // The six settings shapes the table carries outside any foreign key.
    store.setSetting(`quota_notified:${user.id}`, '1')
    store.setSetting(`digest_sent:${user.id}:2026-11-01`, STAMP)
    store.setSetting(`email_test:${user.id}`, STAMP)
    store.setSetting('email_reply:tok1', `${user.id}:${repo.id}:1`)
    store.setSetting('github_app_state:state1', `${user.id}:1`)
    store.setSetting('installation_sender:42', 'trial-owner:1')
    // Controls: another account's rows and an unrelated setting must survive.
    store.setSetting('quota_notified:other-user', '1')
    store.setSetting('installation_sender:43', 'someone-else:1')

    // The swept candidate path cannot reach this account — it has a repository by
    // construction — so the completeness proof drives the function directly, the
    // same entry #691 calls with the eligibility check bypassed (choice (a)).
    const result = store.purgeUserRows(user.id, { reason: 'trial.expired', operator: 'trial.sweep' })
    assert.equal(result.removed, true, 'the purge removed nothing')
    assert.ok((result.rows.repos ?? 0) >= 1, 'the row counts did not name the repository')

    const left = rowsLeft(store, user.id, [repo.id])
    assert.deepEqual(left, [], `rows still name the account or its repository: ${JSON.stringify(left)}`)
    assert.equal(
      Number(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact_versions WHERE repo_id = ?', repo.id)?.n ?? 0),
      0,
      'the artifact version survived the purge',
    )
    assert.equal(
      Number(store.get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact_pointers WHERE version_id = ?', 'art_owner')?.n ?? 0),
      0,
      'the artifact pointer survived the purge',
    )
    const keys = store.listSettings('').map((row) => row.key)
    for (const gone of [
      `quota_notified:${user.id}`,
      `digest_sent:${user.id}:2026-11-01`,
      `email_test:${user.id}`,
      'email_reply:tok1',
      'github_app_state:state1',
      'installation_sender:42',
    ]) {
      assert.ok(!keys.includes(gone), `the purge left the settings row ${gone}`)
    }
    assert.ok(keys.includes('quota_notified:other-user'), 'the purge removed another account\'s settings row')
    assert.ok(keys.includes('installation_sender:43'), 'the purge removed another account\'s sender row')
  } finally {
    store.close()
  }
})

test('the sweep runs the purge phase on the same pass and a dry run writes nothing', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const expired = rejectedSince(store, 'trial-swept', 73)
    const fresh = makeUser(store, { login: 'trial-fresh', status: 'approved' })
    store.run('UPDATE users SET created_at = ? WHERE id = ?', new Date(NOW.getTime() - 8 * 86_400_000).toISOString(), fresh.id)

    const preview = await sweepExpiredTrials(store, mailer, testConfig({ trialPurgeGraceHours: 72 }), { now: NOW, dryRun: true })
    assert.equal(preview.purge.candidates.length, 1, 'the dry run did not report the purge candidate')
    assert.ok(store.userById(expired.id), 'the dry run erased the account')
    assert.equal(store.userById(fresh.id)?.status, 'approved', 'the dry run rejected an account')
    assert.equal(mailer.messages.length, 0, 'the dry run sent mail')
    assert.equal(retentionRows(store).length, 0, 'the dry run wrote a retention row')

    const run = await sweepExpiredTrials(store, mailer, testConfig({ trialPurgeGraceHours: 72 }), { now: NOW })
    assert.deepEqual(run.rejected, ['trial-fresh'], 'the rejection phase changed behaviour')
    assert.deepEqual(run.purge.purged, ['trial-swept'], 'the purge phase did not run in the same sweep')
    assert.equal(store.userById(expired.id), undefined)
  } finally {
    store.close()
  }
})
