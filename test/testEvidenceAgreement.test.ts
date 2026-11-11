import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { mergeReadiness } from '../src/lib/verification.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// #134: the panel and the merge gate read the same snapshot, so the agreement is
// asserted on one run: a job that claims a green test while its only test check
// was skipped must render 未核实 / Unverified and must not be ready to merge.
test('a skipped test check is not evidence and does not make the PR ready', async () => {
  const github = await startFakeServer((request, response) => {
    const path = request.url ?? ''
    if (path.includes('/pulls/8/files')) return json(response, 200, [{ filename: 'src/x.ts', status: 'modified', additions: 1, deletions: 0 }])
    if (path.includes('/pulls/8/reviews')) return json(response, 200, [])
    if (path.includes('/commits/sha8/check-runs')) {
      return json(response, 200, { check_runs: [{ name: 'test (22)', status: 'completed', conclusion: 'skipped' }, { name: 'lint', status: 'completed', conclusion: 'success' }] })
    }
    if (path.includes('/commits/sha8/status')) return json(response, 200, { state: 'success', statuses: [] })
    if (path.includes('/pulls/8')) return json(response, 200, { number: 8, html_url: 'https://github.com/o/evidence/pull/8', title: 'fix', state: 'open', head: { ref: 'fledge/x', sha: 'sha8' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'skipped-evidence-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_skipped_evidence', userId: user.id, owner: 'o', name: 'evidence', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', roleCheckedAt: new Date().toISOString(), upstreamHtmlUrl: 'https://github.com', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_skipped_evidence', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/x', pr_url: 'https://github.com/o/evidence/pull/8', evidence_json: JSON.stringify({ testGreen: 'tests pass' }) })

    const result = await jobs.recheck(job.id)
    assert.equal(result.ok, false, 'a claimed green test with no test result must not verify')

    const verification = JSON.parse(store.getJob(job.id)?.verification_json ?? '{}') as { reasons?: string[]; testEvidence?: { state?: string; greenChecks?: string[]; failingChecks?: string[] } }
    assert.equal(verification.testEvidence?.state, 'unverified')
    assert.deepEqual(verification.testEvidence?.greenChecks, [])
    assert.deepEqual(verification.testEvidence?.failingChecks, [])
    assert.match((verification.reasons ?? []).join('; '), /test evidence/i)
    assert.equal(mergeReadiness(store.getJob(job.id)!).state, 'blocked')
  } finally {
    store.close()
    await github.close()
  }
})
