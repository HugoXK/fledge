import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { JobRow, RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { decideNextJob } from '../src/jobs/continuity.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import {
  WORK_TYPE_IDS,
  WORK_TYPES,
  autoMergeDecision,
  buildTriageProposal,
  parseTriageProposal,
  resolveWorkType,
  type TriageInput,
} from '../src/lib/workTypes.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'
import { jobPage } from '../src/views/pages.js'

function setup(slug: string): { store: Store; jobs: Jobs; repo: RepoRow; user: ReturnType<typeof makeUser> } {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const user = makeUser(store, { login: `${slug}-user`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${slug}`,
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, jobs, repo, user }
}

function startTriageJob(store: Store, repo: RepoRow, id: string, secret: string, workType = 'triage'): JobRow {
  store.createJob({
    id,
    repoId: repo.id,
    userId: repo.user_id,
    trigger: 'manual',
    goal: 'triage',
    callbackHash: sha256Hex(secret),
    platformTokenHash: '',
    kind: 'triage',
    workType,
    baseBranch: 'main',
  })
  store.updateJob(id, { status: 'running', started_at: new Date().toISOString() })
  return store.getJob(id)!
}

const TRIAGE: TriageInput = {
  issues: [
    {
      url: 'https://github.com/o/r/issues/1',
      number: 1,
      title: 'Crash when saving an empty form',
      body: 'Steps to reproduce',
      labels: ['priority:high'],
    },
    {
      url: 'https://github.com/o/r/issues/2',
      number: 2,
      title: 'Crash when saving an empty form',
      body: 'Duplicate of #1',
      labels: ['priority:low'],
    },
    {
      url: 'https://github.com/o/r/issues/3',
      number: 3,
      title: 'Document the retry policy',
      body: 'The retry policy is undocumented',
      labels: ['priority:medium', 'documentation'],
    },
  ],
  pulls: [
    {
      url: 'https://github.com/o/r/pull/9',
      number: 9,
      title: 'Retry policy docs',
      body: 'Fixes #3',
      head: 'docs/retry-policy',
      base: 'main',
    },
  ],
}

test('the work-type registry is data with the eight declared contracts', () => {
  assert.deepEqual([...WORK_TYPE_IDS].sort(), [
    'accessibility',
    'dependency',
    'docs',
    'iterate',
    'migration',
    'performance',
    'security',
    'triage',
  ])
  assert.equal(resolveWorkType('triage')?.id, 'triage')
  assert.equal(resolveWorkType('not-a-work-type'), null)
  assert.ok(WORK_TYPES.triage.allowedStages.includes('triage'))
  assert.equal(WORK_TYPES.triage.riskTier, 'T0')
  assert.equal(WORK_TYPES.triage.producesPullRequest, false)
  assert.deepEqual(WORK_TYPES.triage.requiredEvidence, ['triage'])
})

test('a duplicate issue is linked to its canonical issue, and an open PR keeps an item out of next', () => {
  const proposal = buildTriageProposal(TRIAGE, 'o/r')
  assert.equal(proposal.duplicates.length, 1)
  assert.deepEqual(proposal.duplicates[0], {
    duplicateUrl: 'https://github.com/o/r/issues/2',
    canonicalUrl: 'https://github.com/o/r/issues/1',
  })
  assert.deepEqual(proposal.ranked.map((item) => item.issueUrl), [
    'https://github.com/o/r/issues/1',
    'https://github.com/o/r/issues/3',
  ])
  assert.equal(proposal.ranked[0]?.priority, 30)
  const docs = proposal.ranked.find((item) => item.issueUrl.endsWith('/issues/3'))
  assert.equal(docs?.inFlight, true)
  assert.equal(proposal.next?.issueUrl, 'https://github.com/o/r/issues/1')
  assert.deepEqual(proposal.source, { issues: 3, pulls: 1 })
})

test('an unknown work type is refused before a job row exists', async () => {
  const { store, jobs, repo } = setup('unknown-type')
  try {
    const result = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workType: 'bogus' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'UNKNOWN_WORK_TYPE')
    assert.equal(store.listJobsForRepo(repo.id).length, 0)
    const wrongStage = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workType: 'triage' })
    assert.equal(wrongStage.ok, false)
    assert.equal(wrongStage.code, 'WORK_TYPE_STAGE_FORBIDDEN')
    assert.equal(store.listJobsForRepo(repo.id).length, 0)
  } finally {
    store.close()
  }
})

test('the triage work type can be enqueued as a first-class job', async () => {
  const { store, jobs, repo } = setup('triage-enqueue')
  try {
    const result = await jobs.enqueue(repo, 'manual', undefined, 'triage', { workType: 'triage' })
    assert.equal(result.ok, true)
    assert.equal(result.job?.kind, 'triage')
    assert.equal(result.job?.work_type, 'triage')
  } finally {
    store.close()
  }
})

test('a triage job opens no branch or PR and stores a ranked proposal with duplicate links', async () => {
  const { store, jobs, repo, user } = setup('triage-proposal')
  const secret = 'triage-secret'
  try {
    startTriageJob(store, repo, 'job_triage', secret)
    const result = await jobs.handleCallback('job_triage', secret, { status: 'succeeded', triage: TRIAGE })
    assert.equal(result.ok, true)
    const job = store.getJob('job_triage')
    assert.equal(job?.status, 'succeeded')
    assert.equal(job?.branch, null)
    assert.equal(job?.pr_url, null)
    const proposal = parseTriageProposal(job?.triage_json ?? null)
    assert.ok(proposal !== null)
    assert.equal(proposal.ranked.length, 2)
    assert.equal(proposal.duplicates.length, 1)
    const links = store.listTriageLinksForJob('job_triage')
    assert.deepEqual(links.map((link) => [link.duplicate_url, link.canonical_url]), [
      ['https://github.com/o/r/issues/2', 'https://github.com/o/r/issues/1'],
    ])
    assert.equal(store.findWorkItemByIssueUrl(repo.id, 'https://github.com/o/r/issues/2'), undefined, 'the duplicate is not a second work item')
    assert.ok(store.findWorkItemByIssueUrl(repo.id, 'https://github.com/o/r/issues/1') !== undefined)
    const page = jobPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      job: store.getJob('job_triage')!,
      events: [],
    })
    assert.match(page, /data-work-type="triage"/)
    assert.match(page, /Work type contract/)
    assert.match(page, /Triage output/)
    assert.match(page, /data-triage-next/)
    assert.ok(page.includes('https://github.com/o/r/issues/2'))
  } finally {
    store.close()
  }
})

test('a triage job with no triage evidence fails closed as unverified', async () => {
  const { store, jobs, repo } = setup('triage-missing')
  const secret = 'triage-missing-secret'
  try {
    startTriageJob(store, repo, 'job_triage_missing', secret)
    const result = await jobs.handleCallback('job_triage_missing', secret, { status: 'succeeded', summary: 'looked around' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 422)
    assert.match(result.error ?? '', /unverified/i)
    const job = store.getJob('job_triage_missing')
    assert.equal(job?.status, 'failed')
    assert.equal(job?.error_code, 'WORK_TYPE_EVIDENCE_MISSING')
    assert.equal(job?.triage_json, null)
  } finally {
    store.close()
  }
})

test('the next scheduled job consumes the proposed item', async () => {
  const { store, jobs, repo } = setup('triage-next')
  const secret = 'triage-next-secret'
  try {
    store.createWorkItem({
      id: 'work_triage_closed',
      repoId: repo.id,
      userId: repo.user_id,
      title: 'Crash when saving an empty form',
      issueUrl: 'https://github.com/o/r/issues/1',
      state: 'closed',
    })
    startTriageJob(store, repo, 'job_triage_next', secret)
    const result = await jobs.handleCallback('job_triage_next', secret, { status: 'succeeded', triage: TRIAGE })
    assert.equal(result.ok, true)
    const open = store.listOpenWorkItems(repo.id)
    const proposed = open.find((item) => item.issue_url === 'https://github.com/o/r/issues/1')
    assert.ok(proposed !== undefined)
    assert.equal(proposed.state, 'triaged', 'a closed item with an open issue is reopened by the proposal')
    const next = decideNextJob({
      repo,
      now: Date.now(),
      lastRunAt: null,
      intervalMinutes: 1440,
      lastDurationMs: null,
      failureStreak: 0,
      openWork: open,
      reviewerEnabled: false,
      reviewDue: false,
    })
    assert.equal(next.kind, 'followup')
    assert.equal(next.workItemId, proposed.id)
    const started = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workItemId: proposed.id })
    assert.equal(started.ok, true)
    assert.equal(store.getWorkItem(proposed.id)?.state, 'in_progress')
  } finally {
    store.close()
  }
})

test('dependency, security and docs never auto-merge while iterate may', () => {
  assert.equal(autoMergeDecision('iterate', { manual: false }).ok, true)
  for (const type of ['dependency', 'security', 'docs'] as const) {
    assert.equal(autoMergeDecision(type, { manual: false }).ok, false, `${type} must not auto-merge`)
  }
  assert.equal(autoMergeDecision('security', { manual: true }).ok, true, 'a maintainer may still merge by hand')
  assert.equal(autoMergeDecision('triage', { manual: true }).ok, false, 'triage never produces a mergeable PR')
})

test('auto-merge consults the work-type contract for a non-iterate work type', async () => {
  const merges: string[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        title: 'harden input',
        state: 'open',
        head: { ref: 'fledge/security', sha: 'abc' },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean',
        draft: false,
        merged: false,
      })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/check-runs?per_page=100') {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/commits/abc/status') {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      merges.push('merge')
      json(response, 200, { merged: true, sha: 'def' })
      return
    }
    if (method === 'POST' && url === '/repos/o/r/issues/1/comments') {
      json(response, 200, {})
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'security-auto-merge', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_security_auto_merge',
      userId: user.id,
      owner: 'o',
      name: 'r',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      autoMerge: true,
      requireProtection: false,
      upstreamHtmlUrl: 'https://github.com/o/r',
      forkHtmlUrl: 'https://github.com/o/r',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const secret = 'security-secret'
    store.createJob({
      id: 'job_security',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'harden input',
      callbackHash: sha256Hex(secret),
      platformTokenHash: '',
      kind: 'iterate',
      workType: 'security',
      baseBranch: 'main',
    })
    store.updateJob('job_security', { status: 'running', branch: 'fledge/security', started_at: new Date().toISOString() })
    const result = await jobs.handleCallback('job_security', secret, {
      status: 'succeeded',
      prUrl: 'https://github.com/o/r/pull/1',
      evidence: {
        scope: 'input validation',
        acceptance: 'malformed input is rejected',
        testRed: 'test rejected the old parser',
        testGreen: 'test accepts the new parser',
        checks: 'ci green',
        rollback: 'revert the commit',
      },
    })
    assert.equal(result.ok, true)
    assert.equal(merges.length, 0)
    assert.ok(store.listAudit().some((entry) => entry.action === 'job.merge_skipped' && (entry.detail ?? '').includes('work type security')))
  } finally {
    store.close()
    await github.close()
  }
})
