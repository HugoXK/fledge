import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { metricsSnapshot } from '../src/lib/metrics.js'
import { testConfig, makeUser, MemoryMailer } from './helpers.js'

// #942: a repository the dispatcher refuses for quota must not be reported as
// idle with work. The alert and the refusal have to answer with one predicate,
// because two answers for one repository is the defect the predicate exists to
// prevent (#807 review, #938). The other refusal reasons keep their behaviour:
// cooldown and failure_backoff still let the alert speak, active_job still
// clears the reading, and nothing here changes a counter's shape.

const OLD = '2020-01-01T00:00:00.000Z'

function harness(name: string, quota: number): { store: Store; jobs: Jobs; userId: string; repoId: string } {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved', quota })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440,
  })
  store.createWorkItem({ id: `work_${name}`, repoId: repo.id, userId: user.id, title: 'Ready work', priority: 1 })
  store.run(`UPDATE work_items SET created_at = '${OLD}' WHERE id = 'work_${name}'`)
  return { store, jobs, userId: user.id, repoId: repo.id }
}

function counters() {
  const blocked = (reason: string): number =>
    metricsSnapshot().counters
      .filter((entry) => entry.name === 'fledge_automation_blocked_total' && entry.labels.reason === reason)
      .reduce((sum, entry) => sum + entry.value, 0)
  return { blocked }
}

// -- the predicate ---------------------------------------------------------

test('the scheduler predicate names quota, and only when the platform actually pays', () => {
  const quota0 = harness('predicate-quota', 0)
  try {
    const repo = quota0.store.getRepo(quota0.repoId)!
    assert.equal(quota0.store.automationDispatchBlocker(repo, false, { usdCny: 1 }), 'quota', 'an exhausted platform quota is the reason the dispatcher refuses')

    // No options means no quota answer, so the two-argument callers keep the
    // answer they had: a predicate that guessed would refuse work it cannot see.
    assert.equal(quota0.store.automationDispatchBlocker(repo, false), null)

    // A user with their own model never spends platform quota, so quota cannot
    // be the reason even when the platform balance is zero (#732).
    const own = harness('predicate-own-model', 0)
    try {
      own.store.setUserOwnModel(own.userId, 'https://own.example/v1', 'enc', 'own-model')
      assert.equal(own.store.automationDispatchBlocker(own.store.getRepo(own.repoId)!, false, { usdCny: 1 }), null, 'an own model means the platform pays nothing')
    } finally { own.store.close() }

    // A repository that selected a provider model is funded the same way.
    const selected = harness('predicate-repo-model', 0)
    try {
      const provider = selected.store.createModelProvider({ id: 'prv_quota', userId: selected.userId, label: 'P', baseUrl: 'https://p.example/v1', keyEnc: 'enc', allowPrivate: false })
      const model = selected.store.createProviderModel({ id: 'pvm_quota', providerId: provider.id, model: 'm', label: 'M' })
      selected.store.setRepoModelSelection(selected.repoId, [model.id], model.id)
      assert.equal(selected.store.automationDispatchBlocker(selected.store.getRepo(selected.repoId)!, false, { usdCny: 1 }), null, 'a repository model means the platform pays nothing')
    } finally { selected.store.close() }

    // An unlimited account is not exhausted however much it has spent.
    quota0.store.setUserQuotaUnlimited(quota0.userId, true)
    assert.equal(quota0.store.automationDispatchBlocker(quota0.store.getRepo(quota0.repoId)!, false, { usdCny: 1 }), null, 'unlimited quota is never a refusal')
  } finally { quota0.store.close() }
})

// -- the alert -------------------------------------------------------------

test('a quota-refused repository is not reported as idle with work, before or after the attempt', async () => {
  const h = harness('quota-idle', 0)
  try {
    const { blocked } = counters()
    const idleAlerts = (now?: string): number =>
      h.store.alerts({ usdCny: 1, automationIdleMinutes: 30, ...(now === undefined ? {} : { now }) })
        .filter((alert) => alert.kind === 'automation_idle_with_work').length

    // Before the dispatcher has tried anything the answer already belongs to the
    // predicate: the platform will not fund this run, so the repository is not
    // idle, it is refused.
    assert.equal(idleAlerts(), 0, 'a platform-funded repository with no quota is refused, not idle')

    const before = blocked('quota')
    await h.jobs.tick()
    assert.equal(blocked('quota'), before + 1, 'the dispatcher names the quota refusal')
    const created = h.store.listJobsForRepo(h.repoId)
    assert.equal(created.length, 1, 'the refusal still writes its quota_exhausted row (a non-goal of this card)')
    assert.equal(created[0]!.status, 'quota_exhausted')
    assert.equal(idleAlerts(), 0, 'the refusal is not reported as idle')

    // The refusal rewrites last_run_at; the alert must stay silent after that
    // wait elapses, because the repository has been blocked the whole time.
    const refusal = Date.parse(h.store.getRepo(h.repoId)!.last_run_at ?? new Date().toISOString())
    const later = new Date(refusal + 31 * 60_000).toISOString()
    assert.equal(idleAlerts(later), 0, 'thirty-one minutes into a refusal is still a refusal')

    // Control: with quota the same seed is idle again, so the silence above is
    // the refusal and not a broken alert.
    h.store.setUserQuota(h.userId, 100)
    assert.equal(idleAlerts(later), 1, 'a funded repository with the same old work is idle')
  } finally { h.store.close() }
})
