import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { JobRow } from '../src/db.js'
import { InstanceManager } from '../src/flybot/instances.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { dashboardPage, jobPage } from '../src/views/pages.js'
import type { Viewer } from '../src/views/layout.js'
import { checkStage } from '../src/lib/stages.js'
import { mergeReadiness, parseVerification } from '../src/lib/verification.js'
import type { Attribution } from '../src/lib/attribution.js'
import type { Evidence } from '../src/lib/evidence.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #368: the job row holds one attribution column, and `captureTeamStats` wrote
// the server observation over the claim. So the page printed a claimed seat as a
// fact, and a claim with nothing behind it was indistinguishable from a seat the
// instance actually saw work. This slice keeps the claim, records the observation
// beside it (`attribution_ground_json`) and marks the difference on the page.
// Nothing here may block a merge.
//
// The carrier is the DSH per-role call counts (`teamState`), which prove presence
// and never authorship. The review object and the commit author are not carriers
// here: `requiredPass` fixes the review account and `reviewerAuthoredCommit`
// refuses a reviewer-authored tip, and every commit on this repository resolves to
// the one account or to none.

const ROLE_LABELS: Record<string, string> = { lead: 'Lead', product: 'Product', dev1: 'Dev-1', dev2: 'Dev-2', test: 'Test', reviewer: 'Reviewer', security: 'Security' }

interface FakeCall {
  role: string
  calls: number
}

// `captureTeamStats` is private and its only caller is fire-and-forget
// (`void this.captureTeamStats(...)`), so the honest alternative to this narrow
// cast is polling a background task. The cast keeps the test on the real write
// path, with no HTTP and no timer.
interface TeamCapture {
  captureTeamStats(jobId: string, claimed: Attribution | null): Promise<Attribution | null>
}

function fakeInstances(calls: FakeCall[]): InstanceManager {
  const bots = calls.map((entry) => ({
    role: entry.role,
    label: ROLE_LABELS[entry.role] ?? entry.role,
    calls: entry.calls,
    activity: entry.calls === 0 ? 'idle' : 'working',
    tool: '',
    step: entry.calls === 0 ? '' : 'iterate',
    lastActivityAt: 1_700_000_000_000,
  }))
  return { teamState: async () => ({ bots }) } as unknown as InstanceManager
}

const EVIDENCE: Evidence = {
  scope: 'the page must not print a claim as a fact',
  acceptance: 'an unobserved claim is marked',
  testPlan: 'red test first',
  testRed: 'the page printed the claim unmarked',
  testGreen: 'the page marks it',
  tests: 'test/attributionGrounding.test.ts',
  checks: 'ci-ok',
  files: 3,
}

interface Seeded {
  store: Store
  job: JobRow
  repoId: string
  viewer: Viewer
  config: ReturnType<typeof testConfig>
}

// Mirrors the callback: the job's own attribution block lands in
// `attribution_json` on the terminal transition, and the team capture runs once
// the result is in.
async function seed(claimed: Attribution | null, calls: FakeCall[] | null): Promise<Seeded> {
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: calls === null ? '' : 'image' } })
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `ground-${claimed === null ? 'none' : 'claim'}-${calls === null ? 'blind' : calls.length}`, status: 'approved' })
  const viewer: Viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
  const repo = store.createRepo({
    id: `repo_ground_${claimed === null ? 'none' : 'claim'}_${calls === null ? 'blind' : calls.length}`,
    userId: user.id, owner: 'o', name: 'ground', defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  const job = store.createJob({ id: `job_ground_${claimed === null ? 'none' : 'claim'}_${calls === null ? 'blind' : calls.length}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
  store.updateJob(job.id, {
    status: 'succeeded',
    finished_at: '2026-11-20T12:00:00.000Z',
    pr_url: 'https://github.com/o/ground/pull/12',
    path_guard_json: JSON.stringify({ ok: true, allow: [], deny: [], violations: [], checkedFiles: 3, reportedFiles: 3 }),
    verification_json: JSON.stringify({ ok: true, reasons: [], checkedAt: '2026-11-20T12:00:00.000Z', sha: 'a'.repeat(40), checks: { green: 3, total: 3, failing: [], pending: [] }, testEvidence: { state: 'verified', greenChecks: ['ci-ok'], failingChecks: [], quarantinedChecks: [] }, reviews: { approvals: 1, changesRequested: false }, prState: 'open', mergeableState: 'clean', combinedStatus: 'success' }),
    ...(claimed === null ? {} : { attribution_json: JSON.stringify(claimed) }),
  })
  const runner: Runner = { name: 'noop', async run() { return { status: 'running' } } }
  const jobs = calls === null
    ? new Jobs(store, config, runner, new MemoryMailer())
    : new Jobs(store, config, runner, new MemoryMailer(), fakeInstances(calls))
  const capture = (jobs as unknown as TeamCapture).captureTeamStats.bind(jobs) as TeamCapture['captureTeamStats']
  await capture(job.id, claimed)
  return { store, job: store.getJob(job.id)!, repoId: repo.id, viewer, config }
}

function pageText(seeded: Seeded, locale: 'en' | 'zh'): string {
  const repo = seeded.store.getRepo(seeded.repoId)!
  return jobPage({ config: seeded.config, locale, viewer: seeded.viewer, repo, job: seeded.job, events: [] })
}

function rowText(seeded: Seeded, locale: 'en' | 'zh'): string {
  const repo = seeded.store.getRepo(seeded.repoId)!
  const page = dashboardPage({ config: seeded.config, locale, viewer: seeded.viewer, repos: [repo], jobs: [seeded.job], notifications: [] })
  const start = page.indexOf('data-job-attribution')
  assert.notEqual(start, -1, `${locale}: the dashboard row carries an attribution line`)
  return page.slice(start, page.indexOf('</small>', start))
}

interface GroundStep {
  key: string
  claimed: string | null
  observed: string | null
  state: string
}

function groundOf(job: JobRow): GroundStep[] {
  assert.notEqual(job.attribution_ground_json, null, 'the job records what was observed beside what it claimed')
  const parsed = JSON.parse(job.attribution_ground_json as string) as { steps?: GroundStep[] }
  return parsed.steps ?? []
}

test('a claimed seat the instance never saw is marked claimed, not observed', async () => {
  // Row 1: the callback claims Test; the instance saw that role make no calls.
  const claimed: Attribution = { writtenBy: 'Product', implementedBy: 'Dev-1', testedBy: 'Test' }
  const seeded = await seed(claimed, [{ role: 'lead', calls: 3 }, { role: 'dev1', calls: 4 }, { role: 'test', calls: 0 }])
  try {
    const en = pageText(seeded, 'en')
    assert.match(en, /Test Tested · claimed, not observed/, 'the job page marks the unobserved claim in English')
    assert.match(pageText(seeded, 'zh'), /Test 测试 · 声称，未观察/, 'the job page marks the unobserved claim in Chinese')
    assert.match(rowText(seeded, 'en'), /claimed, not observed/, 'the dashboard row carries the same marker')
    assert.doesNotMatch(en, /Test Tested · claimed, not verified/, 'a run that looked never says the claim was unverified')
    assert.deepEqual(groundOf(seeded.job).find((step) => step.key === 'testedBy'), { key: 'testedBy', claimed: 'Test', observed: null, state: 'unobserved' }, 'the record keeps the claim and says it was not observed')
  } finally {
    seeded.store.close()
  }
})

test('a claim on a host with no instance is marked claimed, not verified', async () => {
  // Row 2: nothing observed the job at all, so the claim is unverified rather
  // than false — and today the page prints it as fact.
  const claimed: Attribution = { writtenBy: 'Product', testedBy: 'Test' }
  const seeded = await seed(claimed, null)
  try {
    const en = pageText(seeded, 'en')
    assert.match(en, /Test Tested · claimed, not verified/, 'the English page says nothing observed the claim')
    assert.match(pageText(seeded, 'zh'), /Test 测试 · 声称，未核实/, 'the Chinese page says nothing observed the claim')
    assert.match(rowText(seeded, 'en'), /claimed, not verified/, 'the dashboard row says the same')
    assert.doesNotMatch(en, /claimed, not observed/, 'a host with no observation cannot say it looked and found nothing')
    const steps = groundOf(seeded.job)
    assert.ok(steps.length > 0, 'a job with no observation still records what it claimed')
    assert.ok(steps.every((step) => step.state === 'no-observation'), 'every claimed step is recorded as unverified')
  } finally {
    seeded.store.close()
  }
})

test('a claim the instance observed is grounded and carries no marker', async () => {
  // Row 3: the instance saw the Test seat work, so there is nothing to qualify.
  // This row is green on the unbroken tip and must stay green: the fix may not
  // add a marker to a seat the server watched.
  const claimed: Attribution = { writtenBy: 'Product', implementedBy: 'Dev-1', testedBy: 'Test' }
  const seeded = await seed(claimed, [{ role: 'lead', calls: 1 }, { role: 'product', calls: 1 }, { role: 'dev1', calls: 4 }, { role: 'test', calls: 2 }])
  try {
    const en = pageText(seeded, 'en')
    assert.match(en, /Test Tested/, 'the grounded seat is still named')
    assert.doesNotMatch(en, /claimed, not observed|claimed, not verified/, 'a grounded seat carries no marker')
    assert.doesNotMatch(rowText(seeded, 'en'), /claimed, not/, 'the dashboard row carries no marker either')
  } finally {
    seeded.store.close()
  }
})

test('a seat only the instance saw is shown from the observation, unmarked', async () => {
  // Row 4: no claim names Test, but the instance saw the seat make calls.
  const claimed: Attribution = { writtenBy: 'Product', implementedBy: 'Dev-1' }
  const seeded = await seed(claimed, [{ role: 'product', calls: 1 }, { role: 'dev1', calls: 2 }, { role: 'test', calls: 2 }])
  try {
    const en = pageText(seeded, 'en')
    assert.match(en, /Test Tested/, 'the observed seat is named even though nobody claimed it')
    assert.doesNotMatch(en, /claimed, not observed|claimed, not verified/, 'an observed seat is never marked')
  } finally {
    seeded.store.close()
  }
})

test('the claim survives the observation instead of being overwritten by it', async () => {
  // Row 5: today `captureTeamStats` writes the observation over `attribution_json`
  // so the claim is gone. Both halves must survive.
  const claimed: Attribution = { writtenBy: 'Product', testedBy: 'Test' }
  const seeded = await seed(claimed, [{ role: 'dev1', calls: 6 }, { role: 'test', calls: 0 }])
  try {
    assert.deepEqual(JSON.parse(seeded.job.attribution_json as string), claimed, 'attribution_json still holds what the job claimed')
    const steps = groundOf(seeded.job)
    assert.deepEqual(steps.find((step) => step.key === 'testedBy'), { key: 'testedBy', claimed: 'Test', observed: null, state: 'unobserved' }, 'the claim and the absence are both recorded')
    assert.deepEqual(steps.find((step) => step.key === 'implementedBy'), { key: 'implementedBy', claimed: null, observed: 'Dev-1', state: 'grounded' }, 'the observation keeps a role the claim never named')

    // The two states rows 3 and 4 own at the page: a claim the instance watched
    // is grounded, and a seat only the instance saw is grounded without a claim.
    const grounded = await seed({ writtenBy: 'Product', implementedBy: 'Dev-1', testedBy: 'Test' }, [{ role: 'dev1', calls: 4 }, { role: 'test', calls: 2 }])
    try {
      assert.deepEqual(groundOf(grounded.job).find((step) => step.key === 'testedBy'), { key: 'testedBy', claimed: 'Test', observed: 'Test', state: 'grounded' }, 'an observed claim is recorded as grounded')
      assert.deepEqual(groundOf(grounded.job).find((step) => step.key === 'writtenBy'), { key: 'writtenBy', claimed: 'Product', observed: null, state: 'unobserved' }, 'a role nobody called is not grounded by another role working')
      const onlyObserved = await seed({ writtenBy: 'Product', implementedBy: 'Dev-1' }, [{ role: 'dev1', calls: 2 }, { role: 'test', calls: 2 }])
      try {
        assert.deepEqual(groundOf(onlyObserved.job).find((step) => step.key === 'testedBy'), { key: 'testedBy', claimed: null, observed: 'Test', state: 'grounded' }, 'the observation is recorded without a claim')
      } finally {
        onlyObserved.store.close()
      }
    } finally {
      grounded.store.close()
    }
    const en = pageText(seeded, 'en')
    assert.match(en, /Dev-1 Implemented/, 'the observed implementer is shown')
    assert.match(en, /Test Tested · claimed, not observed/, 'the claimed tester is marked')
  } finally {
    seeded.store.close()
  }
})

test('grounding changes what the page says, never what may merge', async () => {
  // Row 6: `verification.ok`, `mergeReadiness` and the stage gate read the claim
  // and the evidence, exactly as they do today. The instance exists only where one
  // is configured, so a marker that blocked a merge would refuse every job on a
  // host without one.
  const claimed: Attribution = { writtenBy: 'Product', implementedBy: 'Dev-1', testedBy: 'Test' }
  const cases: Array<{ name: string; calls: FakeCall[] | null }> = [
    { name: 'nothing observed', calls: null },
    { name: 'the claim was not observed', calls: [{ role: 'dev1', calls: 2 }, { role: 'test', calls: 0 }] },
    { name: 'the claim was grounded', calls: [{ role: 'dev1', calls: 2 }, { role: 'test', calls: 1 }] },
  ]
  for (const entry of cases) {
    const seeded = await seed(claimed, entry.calls)
    try {
      const job = seeded.job
      assert.equal(job.verification_json?.includes('"ok":true'), true, `${entry.name}: the capture never rewrites the verification verdict`)
      assert.equal(parseVerification(job.verification_json)?.ok, true, `${entry.name}: the verdict still reads as recorded`)
      assert.deepEqual(mergeReadiness(job), { state: 'ready', reasons: [] }, `${entry.name}: an ungrounded claim blocks no merge`)
      assert.deepEqual(checkStage('enforced', 'iterate', EVIDENCE, claimed, undefined), { ok: true, errors: [] }, `${entry.name}: the stage gate still reads the claim`)
      assert.deepEqual(checkStage('enforced', 'verify', EVIDENCE, claimed, undefined), { ok: true, errors: [] }, `${entry.name}: the verify gate is unchanged too`)
    } finally {
      seeded.store.close()
    }
  }
})

test('a row written before the ground column is read the way it is today', async () => {
  // A row from before this column exists has no record to separate the halves.
  // `captureTeamStats` used to write the observation over `attribution_json`, so
  // a row carrying team stats holds the observed half there and reads unmarked
  // exactly as it does today, while a row without team stats holds a claim
  // nothing checked and now says so.
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: '' } })
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'ground-legacy', status: 'approved' })
    const viewer: Viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const repo = store.createRepo({
      id: 'repo_ground_legacy', userId: user.id, owner: 'o', name: 'legacy', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const observedRow = store.createJob({ id: 'job_ground_legacy_observed', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(observedRow.id, {
      status: 'succeeded', finished_at: '2026-11-19T12:00:00.000Z', pr_url: 'https://github.com/o/legacy/pull/3',
      attribution_json: JSON.stringify({ claimedBy: 'Lead', implementedBy: 'Dev-1' }),
      team_stats_json: JSON.stringify([{ role: 'dev1', label: 'Dev-1', calls: 4, activity: 'working', tool: '', step: 'iterate', lastActivityAt: 1 }]),
    })
    const claimRow = store.createJob({ id: 'job_ground_legacy_claim', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(claimRow.id, {
      status: 'succeeded', finished_at: '2026-11-19T12:00:00.000Z', pr_url: 'https://github.com/o/legacy/pull/4',
      attribution_json: JSON.stringify({ implementedBy: 'Dev-1', testedBy: 'Test' }),
    })

    const observed = jobPage({ config, locale: 'en', viewer, repo, job: store.getJob(observedRow.id)!, events: [] })
    assert.match(observed, /Lead Claimed · Dev-1 Implemented/, 'a row that carries the observation still shows it')
    assert.doesNotMatch(observed, /claimed, not observed|claimed, not verified/, 'a row the old capture observed gains no marker')

    const claim = jobPage({ config, locale: 'en', viewer, repo, job: store.getJob(claimRow.id)!, events: [] })
    assert.match(claim, /Test Tested · claimed, not verified/, 'a legacy row with no observation says its claim was never verified')
    assert.match(jobPage({ config, locale: 'zh', viewer, repo, job: store.getJob(claimRow.id)!, events: [] }), /Test 测试 · 声称，未核实/, 'and says it in Chinese too')
  } finally {
    store.close()
  }
})
