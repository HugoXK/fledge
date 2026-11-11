import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { sweepExpiredTrials } from '../src/users/trial.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #265: a preview trial that is approved and never uses the platform must end
// by itself. The sweep is the only writer, it is idempotent through the
// `trial.expired` audit row the console already reads (#279), and "used" means a
// repository or the audit entry that recorded one — never a login.
const DAY = 86_400_000
const NOW = Date.parse('2026-11-11T12:00:00.000Z')

function backdate(store: Store, id: string, days: number): void {
  store.run('UPDATE users SET created_at = ? WHERE id = ?', new Date(NOW - days * DAY + 60_000).toISOString(), id)
}

function trialAudits(store: Store, userId: string): number {
  return store.listAudit(200).filter((row) => row.user_id === userId && row.action === 'trial.expired').length
}

test('an approved user past the seventh day without a repository is rejected, audited and mailed once', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const user = makeUser(store, { login: 'trial-lapsed', status: 'approved' })
    backdate(store, user.id, 8)

    const result = await sweepExpiredTrials(store, mailer, testConfig(), { now: new Date(NOW) })

    assert.deepEqual(
      result.eligible.map((row) => row.login),
      ['trial-lapsed'],
      'the sweep did not select the lapsed trial',
    )
    assert.deepEqual(result.rejected, ['trial-lapsed'], 'the sweep did not report the rejection')
    assert.equal(store.userById(user.id)?.status, 'rejected', 'the account is still approved')
    assert.equal(trialAudits(store, user.id), 1, 'the trial.expired audit row is missing')

    assert.equal(mailer.messages.length, 1, 'the notice was not sent exactly once')
    const mail = mailer.messages[0]!
    assert.equal(mail.to, user.email, 'the notice did not go to the account address')
    assert.match(mail.text, /7 天/, 'the Chinese side must name the 7-day rule')
    assert.match(mail.text, /7 days/, 'the English side must name the 7-day rule')
    assert.match(mail.text, /仓库/, 'the notice must name the repository exemption')
    // The clock is registration, not approval: the sweep cuts on `users.created_at`,
    // so a mail dated from approval tells an account a rule it was never judged by.
    assert.match(mail.text, /注册后 ?7 天/, 'the Chinese side must date the rule from registration')
    assert.match(mail.text, /7 days of registration/, 'the English side must date the rule from registration')
    assert.doesNotMatch(mail.text, /批准后 ?7 天/, 'the Chinese side dates the rule from approval')
    assert.doesNotMatch(mail.text, /7 days of approval/, 'the English side dates the rule from approval')
    // A rejected account cannot resubmit (`submitApplication` only moves
    // onboarding -> pending), so the only way back is the admin's re-approve.
    assert.match(mail.text, /管理员/, 'the notice must name the administrator as the way back')
    assert.match(mail.text, /administrator/, 'the notice must name the administrator as the way back')
    assert.doesNotMatch(mail.text, /重新申请/, 'the notice promises a resubmission the app does not offer')
    assert.doesNotMatch(mail.text, /apply again/, 'the notice promises a resubmission the app does not offer')
  } finally {
    store.close()
  }
})

test('the rejection and its audit row are one write, so a failed audit leaves the account untouched', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const user = makeUser(store, { login: 'trial-atomic', status: 'approved' })
    backdate(store, user.id, 8)

    // Two autocommitted statements would leave the account rejected with no
    // `trial.expired` row: the console would render it `inactive`, nothing could
    // say why, and the notice would never be sent.
    store.audit = () => {
      throw new Error('audit write failed')
    }

    await assert.rejects(
      () => sweepExpiredTrials(store, mailer, testConfig(), { now: new Date(NOW) }),
      /audit write failed/,
      'a failed audit row did not surface',
    )

    assert.equal(store.userById(user.id)?.status, 'approved', 'the rejection survived without its audit row')
    assert.equal(trialAudits(store, user.id), 0, 'the audit row was written anyway')
    assert.equal(mailer.messages.length, 0, 'the notice went out for a rejection that was rolled back')
  } finally {
    store.close()
  }
})

test('a rerun finds nobody and sends no second notice', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const user = makeUser(store, { login: 'trial-lapsed', status: 'approved' })
    backdate(store, user.id, 9)
    const config = testConfig()

    await sweepExpiredTrials(store, mailer, config, { now: new Date(NOW) })
    const second = await sweepExpiredTrials(store, mailer, config, { now: new Date(NOW + DAY) })

    assert.deepEqual(second.eligible, [], 'the sweep offered the same account twice')
    assert.deepEqual(second.rejected, [], 'the sweep rejected the same account twice')
    assert.equal(mailer.messages.length, 1, 'the account was mailed twice')
    assert.equal(trialAudits(store, user.id), 1, 'the audit trail has two trial.expired rows')
  } finally {
    store.close()
  }
})

test('a repository, a repo.added audit, a job, an admin and a super admin are all exempt', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const withRepo = makeUser(store, { login: 'has-repo', status: 'approved' })
    const withAudit = makeUser(store, { login: 'has-audit', status: 'approved' })
    const withJob = makeUser(store, { login: 'has-job', status: 'approved' })
    const admin = makeUser(store, { login: 'boss', admin: true, status: 'approved' })
    const superadmin = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const fresh = makeUser(store, { login: 'just-joined', status: 'approved' })
    const pending = makeUser(store, { login: 'still-pending', status: 'pending' })
    const other = makeUser(store, { login: 'other', status: 'approved' })

    const repo = store.createRepo({
      id: 'repo_trial_exempt',
      userId: withRepo.id,
      owner: 'o',
      name: 'trial-exempt',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    // A repository that was disconnected still counts as use, and a job outlives
    // the repository it ran in, so both rows are moved off the account without
    // deleting them.
    const jobRepo = store.createRepo({
      id: 'repo_trial_job',
      userId: withJob.id,
      owner: 'o',
      name: 'trial-job',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    store.createJob({
      id: 'job_trial_exempt',
      repoId: jobRepo.id,
      userId: withJob.id,
      trigger: 'schedule',
      goal: 'x',
      callbackHash: 'h',
      platformTokenHash: 't',
    })
    store.run('UPDATE repos SET user_id = ? WHERE id = ?', other.id, jobRepo.id)
    store.audit(withAudit.id, 'repo.added', 'owner/name')
    for (const user of [withRepo, withAudit, withJob, admin, superadmin]) backdate(store, user.id, 30)
    backdate(store, fresh.id, 2)
    backdate(store, pending.id, 30)
    assert.equal(repo.id, 'repo_trial_exempt')

    const result = await sweepExpiredTrials(store, mailer, testConfig(), { now: new Date(NOW) })

    assert.deepEqual(result.eligible, [], 'the sweep selected an exempt account')
    for (const user of [withRepo, withAudit, withJob, admin, superadmin, fresh, pending]) {
      assert.equal(store.userById(user.id)?.status, user.status, `${user.login} lost its status`)
      assert.equal(trialAudits(store, user.id), 0, `${user.login} was audited as expired`)
    }
    assert.equal(mailer.messages.length, 0, 'an exempt account was mailed')
  } finally {
    store.close()
  }
})

test('a dry run names the eligible accounts and changes nothing', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const user = makeUser(store, { login: 'trial-lapsed', status: 'approved' })
    backdate(store, user.id, 8)

    const result = await sweepExpiredTrials(store, mailer, testConfig(), { now: new Date(NOW), dryRun: true })

    assert.equal(result.dryRun, true, 'the result does not say it was a dry run')
    assert.deepEqual(result.eligible.map((row) => row.login), ['trial-lapsed'])
    assert.deepEqual(result.rejected, [], 'a dry run rejected the account')
    assert.equal(store.userById(user.id)?.status, 'approved', 'a dry run changed the account')
    assert.equal(trialAudits(store, user.id), 0, 'a dry run wrote the audit row')
    assert.equal(mailer.messages.length, 0, 'a dry run sent the notice')
  } finally {
    store.close()
  }
})

test('one login can be swept on its own', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const first = makeUser(store, { login: 'first-lapsed', status: 'approved' })
    const second = makeUser(store, { login: 'second-lapsed', status: 'approved' })
    backdate(store, first.id, 8)
    backdate(store, second.id, 8)

    const result = await sweepExpiredTrials(store, mailer, testConfig(), { now: new Date(NOW), login: 'second-lapsed' })

    assert.deepEqual(result.rejected, ['second-lapsed'], 'the sweep did not honour the login filter')
    assert.equal(store.userById(second.id)?.status, 'rejected')
    assert.equal(store.userById(first.id)?.status, 'approved', 'the filter swept another account')
    assert.equal(mailer.messages.length, 1)
  } finally {
    store.close()
  }
})

test('the scheduler service runs the same sweep', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const runner: Runner = {
    name: 'noop',
    async run() {
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, testConfig(), runner, mailer)
  try {
    jobs.start()
    jobs.stop()

    const user = makeUser(store, { login: 'service-lapsed', status: 'approved' })
    backdate(store, user.id, 8)
    const result = await jobs.runTrialSweep(new Date(NOW))

    assert.deepEqual(result.rejected, ['service-lapsed'], 'the service sweep did not end the trial')
    assert.equal(store.userById(user.id)?.status, 'rejected')
    assert.equal(mailer.messages.length, 1, 'the service sweep did not mail the notice')
  } finally {
    jobs.stop()
    store.close()
  }
})

test('the operator result carries no address', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const user = makeUser(store, { login: 'trial-lapsed', status: 'approved' })
    backdate(store, user.id, 8)

    const result = await sweepExpiredTrials(store, mailer, testConfig(), { now: new Date(NOW) })

    assert.doesNotMatch(JSON.stringify(result), /@example\.com|@/, 'the result prints an email address')
  } finally {
    store.close()
  }
})
