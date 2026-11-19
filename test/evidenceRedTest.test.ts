import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs, type CallbackPayload } from '../src/jobs/service.js'
import { jobPage } from '../src/views/pages.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #1040: the merged classifier had no producer, so a job page could only repeat
// the agent's sentence about the red test. These cases pin the producer: a
// callback that carries the base run stores the verdict, the reason and the
// digest beside the prose, and a job that carries none keeps the sentence with
// no invented verdict.

const RUNNER = { name: 'capture', async run() { return { status: 'running' as const } } }
const BASE = '0123456789abcdef0123456789abcdef01234567'
const ASSERTION = "AssertionError [ERR_ASSERTION]: expected 3 to equal 4\n    at test/add.test.ts:4:10\n  code: 'ERR_ASSERTION'"
const COMPILE = "src/add.ts(3,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."

interface Fixture {
  store: Store
  jobs: Jobs
  repo: ReturnType<Store['createRepo']>
  jobId: string
  secret: string
  close: () => void
}

function fixture(tag: string): Fixture {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), RUNNER, new MemoryMailer())
  const user = makeUser(store, { login: `redtest-${tag}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_red_${tag}`, userId: user.id, owner: 'o', name: `red-${tag}`, defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  const secret = `red-secret-${tag}`
  const jobId = `job_red_${tag}`
  store.createJob({
    id: jobId, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'fix the adder',
    callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'implement', baseBranch: 'main',
  })
  store.updateJob(jobId, { status: 'running', branch: 'fledge/red', started_at: new Date().toISOString(), base_sha: BASE })
  return { store, jobs, repo, jobId, secret, close: () => store.close() }
}

function storedEvidence(f: Fixture): Record<string, unknown> {
  const job = f.store.getJob(f.jobId)
  assert.ok(job !== undefined)
  assert.ok(job.evidence_json !== null, 'the callback stores evidence on the row')
  return JSON.parse(job.evidence_json) as Record<string, unknown>
}

function record(f: Fixture): Record<string, unknown> {
  const stored = storedEvidence(f)
  const red = stored.redTest
  assert.ok(red !== null && typeof red === 'object', 'the row carries a red-test record')
  return red as Record<string, unknown>
}

test('a compile failure at the base is stored as unverified with its signature, not as red', async () => {
  const f = fixture('compile')
  try {
    const result = await f.jobs.handleCallback(f.jobId, f.secret, {
      status: 'running',
      evidence: { testRed: 'the adder test fails', baseRun: { command: 'node --test test/add.test.ts', baseSha: BASE, exitCode: 2, output: COMPILE } },
    } as CallbackPayload)
    assert.equal(result.ok, true, result.error ?? 'no error')
    const red = record(f)
    assert.equal(red.verdict, 'unverified', 'a compile error is not the intended red')
    assert.equal(red.signature, 'compile')
    assert.match(String(red.reason), /compile|no test executed/)
    assert.equal(red.outputSha256, sha256Hex(COMPILE), 'the digest covers the run output that was classified')
    assert.equal(red.flaky, false)
    assert.equal(red.baseSha, BASE)
    assert.equal(red.exitCode, 2)
  } finally {
    f.close()
  }
})

test('an assertion failure at the base is stored as red', async () => {
  const f = fixture('assertion')
  try {
    const result = await f.jobs.handleCallback(f.jobId, f.secret, {
      status: 'running',
      evidence: { testRed: 'the adder test fails', baseRun: { command: 'node --test test/add.test.ts', baseSha: BASE, exitCode: 1, output: ASSERTION } },
    } as CallbackPayload)
    assert.equal(result.ok, true, result.error ?? 'no error')
    const red = record(f)
    assert.equal(red.verdict, 'red')
    assert.equal(red.signature, 'assertion')
    assert.equal(red.flaky, false)
  } finally {
    f.close()
  }
})

test('two runs that disagree are stored as flaky and unverified', async () => {
  const f = fixture('flaky')
  try {
    const result = await f.jobs.handleCallback(f.jobId, f.secret, {
      status: 'running',
      evidence: {
        testRed: 'the adder test fails',
        baseRun: { command: 'node --test test/add.test.ts', baseSha: BASE, exitCode: 1, output: ASSERTION },
        repeat: { command: 'node --test test/add.test.ts', baseSha: BASE, exitCode: 0, output: '# pass 1\n# fail 0' },
      },
    } as CallbackPayload)
    assert.equal(result.ok, true, result.error ?? 'no error')
    const red = record(f)
    assert.equal(red.verdict, 'unverified', 'a red that does not reproduce is not evidence')
    assert.equal(red.signature, 'flaky')
    assert.equal(red.flaky, true)
  } finally {
    f.close()
  }
})

test('a base run taken on another tree is stored as unverified for the mismatch', async () => {
  const f = fixture('mismatch')
  try {
    const other = 'fedcba9876543210fedcba9876543210fedcba98'
    const result = await f.jobs.handleCallback(f.jobId, f.secret, {
      status: 'running',
      evidence: { testRed: 'the adder test fails', baseRun: { command: 'node --test test/add.test.ts', baseSha: other, exitCode: 1, output: ASSERTION } },
    } as CallbackPayload)
    assert.equal(result.ok, true, result.error ?? 'no error')
    const red = record(f)
    assert.equal(red.verdict, 'unverified', 'a run from another tree proves nothing about this base')
    assert.equal(red.signature, 'base-mismatch')
    assert.equal(red.baseSha, other, 'the record keeps the sha the run was taken at')
  } finally {
    f.close()
  }
})

test('a job with no base run keeps the sentence and invents no verdict', async () => {
  const f = fixture('none')
  try {
    const result = await f.jobs.handleCallback(f.jobId, f.secret, {
      status: 'running',
      evidence: { testRed: 'the adder test fails because add() drops the carry' },
    } as CallbackPayload)
    assert.equal(result.ok, true, result.error ?? 'no error')
    const stored = storedEvidence(f)
    assert.equal(stored.redTest, undefined, 'no base run, no record')
    const job = f.store.getJob(f.jobId)
    assert.ok(job !== undefined)
    const html = jobPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: f.store.userById(f.repo.user_id)!, csrfToken: 'csrf' },
      repo: f.repo,
      job,
    })
    assert.match(html, /the adder test fails because add\(\) drops the carry/, 'the sentence is still shown')
    assert.doesNotMatch(html, /data-red-test-verdict/, 'no verdict is invented for a missing run')
  } finally {
    f.close()
  }
})

test('the job page renders the verdict, the signature, the reason and the digest in zh and en', async () => {
  const f = fixture('render')
  try {
    const result = await f.jobs.handleCallback(f.jobId, f.secret, {
      status: 'running',
      evidence: { testRed: 'the adder test fails', baseRun: { command: 'node --test test/add.test.ts', baseSha: BASE, exitCode: 2, output: COMPILE } },
    } as CallbackPayload)
    assert.equal(result.ok, true, result.error ?? 'no error')
    const job = f.store.getJob(f.jobId)
    assert.ok(job !== undefined)
    const viewer = { user: f.store.userById(f.repo.user_id)!, csrfToken: 'csrf' }
    const en = jobPage({ config: testConfig(), locale: 'en', viewer, repo: f.repo, job })
    assert.match(en, /data-red-test-verdict="unverified"/)
    assert.match(en, /data-red-test-signature="compile"/)
    assert.match(en, /data-red-test-flaky="false"/)
    assert.match(en, /no test executed/, 'the reason is printed beside the sentence')
    assert.match(en, new RegExp(sha256Hex(COMPILE).slice(0, 12)), 'the digest is printed behind the verdict')
    const zh = jobPage({ config: testConfig(), locale: 'zh', viewer, repo: f.repo, job })
    assert.match(zh, /data-red-test-verdict="unverified"/)
    assert.match(zh, /未验证/, 'the Chinese page names the verdict in Chinese')
  } finally {
    f.close()
  }
})
