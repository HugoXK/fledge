import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { MemoryMailer, flashOf, formBody, makeUser, sessionFor, testConfig } from './helpers.js'

// #1040: the record on the row is half the feature. The other half is the
// maintainer's decision: one control on the job page, one route behind it, and
// the answer stored on the row so the page can show what was decided and by
// whom. These cases drive the press through the real app and read the row back.

interface Fixture {
  built: BuiltApp
  store: Store
  user: ReturnType<typeof makeUser>
  repoId: string
  jobId: string
  close: () => Promise<void>
}

const RED_TEST = {
  command: 'node --test test/add.test.ts',
  baseSha: '0123456789abcdef0123456789abcdef01234567',
  exitCode: 1,
  verdict: 'red',
  signature: 'assertion',
  reason: 'the test failed an assertion at the base: the intended red',
  outputSha256: 'a'.repeat(64),
  flaky: false,
}

// Two different roles decide this press and they are not the same column:
// `repo_role` declares what access Fledge holds upstream and stays NULL on a
// connected repository (production shape), while the actor's role comes from
// `ownedRepo` (the owner, or `repo_members`). The fixture keeps them apart so a
// case cannot pass by setting the one the other is read as.
async function fixture(tag: string, withRecord: boolean, options: {
  /** What the repository declares about Fledge's upstream access. A repository
   * connected through Fledge carries NULL, which one case below covers by name. */
  repoRole?: 'maintainer' | 'developer' | null
  /** Who presses: the owner, or a member granted a role. */
  actor?: 'owner' | 'maintainer' | 'developer' | 'viewer'
} = {}): Promise<Fixture> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: { name: 'capture', async run() { return { status: 'running' as const } } },
    startScheduler: false,
  })
  const owner = makeUser(store, { login: `red-decision-owner-${tag}`, status: 'approved' })
  const actor = options.actor ?? 'owner'
  const user = actor === 'owner' ? owner : makeUser(store, { login: `red-decision-${tag}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_reddec_${tag}`, userId: owner.id, owner: 'o', name: `reddec-${tag}`, defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: options.repoRole === undefined ? 'maintainer' : options.repoRole, goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  if (actor !== 'owner') store.addRepoMember({ repoId: repo.id, userId: user.id, role: actor, grantedBy: owner.id })
  const jobId = `job_reddec_${tag}`
  store.createJob({
    id: jobId, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'fix the adder',
    callbackHash: `cbr-${tag}`, platformTokenHash: '', kind: 'implement', baseBranch: 'main',
  })
  store.updateJob(jobId, {
    status: 'succeeded',
    evidence_json: JSON.stringify({ testRed: 'the adder test fails', ...(withRecord ? { redTest: RED_TEST } : {}) }),
  })
  return { built, store, user, repoId: repo.id, jobId, close: async () => { await built.close() } }
}

async function press(f: Fixture, locale: 'zh' | 'en', payload: Record<string, string>): Promise<{ statusCode: number; location: string; flash: ReturnType<typeof flashOf> }> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({
    method: 'POST',
    url: `/repos/${f.repoId}/jobs/${f.jobId}/red-test`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${session.cookie}; fledge_lang=${locale}` },
    payload: formBody({ csrf: session.csrf, ...payload }),
  })
  return { statusCode: response.statusCode, location: decodeURIComponent(String(response.headers.location ?? '')), flash: flashOf(response) }
}

async function page(f: Fixture, locale: 'zh' | 'en' = 'en'): Promise<string> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}/jobs/${f.jobId}`, headers: { cookie: `${session.cookie}; fledge_lang=${locale}` } })
  assert.equal(response.statusCode, 200)
  return response.body
}

function storedDecision(f: Fixture): Record<string, unknown> | undefined {
  const job = f.store.getJob(f.jobId)
  assert.ok(job !== undefined)
  const evidence = job.evidence_json === null ? null : JSON.parse(job.evidence_json) as Record<string, unknown>
  const decision = evidence?.redTestDecision
  return decision === undefined ? undefined : (decision as Record<string, unknown>)
}

test('a maintainer confirms the red claim and the page shows the decision', async () => {
  const f = await fixture('confirm', true)
  try {
    const response = await press(f, 'en', { decision: 'confirm', note: 'checked the base run myself' })
    assert.equal(response.statusCode, 302, response.flash?.error?.text ?? 'redirect')
    assert.ok(response.flash?.notice, 'the press reports what it decided')
    const decision = storedDecision(f)
    assert.ok(decision !== undefined, 'the decision is written on the row')
    assert.equal(decision.decision, 'confirmed')
    assert.equal(decision.note, 'checked the base run myself')
    assert.equal(decision.by, f.user.login)
    assert.match(String(decision.at), /^\d{4}-\d{2}-\d{2}T/, 'the decision carries when it was made')

    const html = await page(f)
    assert.match(html, /data-red-test-decision="confirmed"/, 'the page shows the stored decision')
    assert.match(html, /checked the base run myself/, 'the note is read back')

    const zh = await page(f, 'zh')
    assert.match(zh, /data-red-test-decision="confirmed"/)
    assert.match(zh, /维护者已确认/, 'the Chinese page names the decision in Chinese')
  } finally {
    await f.close()
  }
})

test('a challenge without a reason is refused and writes nothing', async () => {
  const f = await fixture('challenge-empty', true)
  try {
    const response = await press(f, 'en', { decision: 'challenge', note: '   ' })
    assert.equal(response.statusCode, 302)
    assert.ok(response.flash?.error, 'the refusal is stated')
    assert.match(response.flash?.error?.text ?? '', /reason/, 'the refusal names what is missing')
    assert.equal(storedDecision(f), undefined, 'a refused press decides nothing')
  } finally {
    await f.close()
  }
})

test('a challenge with a reason is stored and shown as challenged', async () => {
  const f = await fixture('challenge', true)
  try {
    const response = await press(f, 'zh', { decision: 'challenge', note: '这条基线是在另一个分支上跑的，不是这次改动的基线' })
    assert.equal(response.statusCode, 302, response.flash?.error?.text ?? 'redirect')
    const decision = storedDecision(f)
    assert.ok(decision !== undefined)
    assert.equal(decision.decision, 'challenged')
    assert.match(String(decision.note), /另一个分支/)
    const zh = await page(f, 'zh')
    assert.match(zh, /data-red-test-decision="challenged"/)
    assert.match(zh, /维护者已质疑/)
  } finally {
    await f.close()
  }
})

test('a job with no red-test record refuses the press instead of recording a decision', async () => {
  const f = await fixture('no-record', false)
  try {
    const response = await press(f, 'en', { decision: 'confirm' })
    assert.equal(response.statusCode, 302)
    assert.ok(response.flash?.error)
    assert.match(response.flash?.error?.text ?? '', /no red-test record|record/i)
    assert.equal(storedDecision(f), undefined)
    const html = await page(f, 'en')
    assert.doesNotMatch(html, /data-red-test-verdict/, 'no record means no verdict on the page')
    assert.match(html, /the adder test fails/, 'the sentence is still shown')
    assert.doesNotMatch(html, /action="[^"]*\/red-test"/, 'and no control that could not work')
  } finally {
    await f.close()
  }
})

test('a developer member cannot decide the red claim, even when the repository declares itself a maintainer', async () => {
  const f = await fixture('dev', true, { repoRole: 'maintainer', actor: 'developer' })
  try {
    const response = await press(f, 'en', { decision: 'confirm' })
    assert.equal(response.statusCode, 302)
    assert.ok(response.flash?.error)
    assert.match(response.flash?.error?.text ?? '', /maintainer/)
    assert.equal(storedDecision(f), undefined, 'a member who may not decide writes nothing')
    const html = await page(f, 'en')
    assert.doesNotMatch(html, /action="[^"]*\/red-test"/, 'the page draws no control the route would refuse')
  } finally {
    await f.close()
  }
})

test('the owner decides the claim on a repository that declares no role', async () => {
  const f = await fixture('owner-null-role', true, { repoRole: null, actor: 'owner' })
  try {
    // A repository connected through Fledge carries `repo_role` NULL; the owner
    // is still the maintainer `ownedRepo` answers, so the control must be there.
    const html = await page(f, 'en')
    assert.match(html, /action="[^"]*\/red-test"/, 'the owner sees the control on a connected repository')
    const response = await press(f, 'en', { decision: 'confirm', note: 'ran the base run myself' })
    assert.equal(response.statusCode, 302, response.flash?.error?.text ?? 'redirect')
    assert.ok(response.flash?.notice, 'the press reports what it decided')
    assert.equal(storedDecision(f)?.decision, 'confirmed', 'the owner decides even with no declared role')
    assert.equal(storedDecision(f)?.by, f.user.login)
  } finally {
    await f.close()
  }
})
