import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { strategyHash } from '../src/strategy/bundle.js'
import { currentStrategySections } from '../src/strategy/sources.js'
import { makeTerminalJob, makeUser, sessionFor, testConfig } from './helpers.js'

// #433 slice 2: the two questions the problem statement starts with — which
// strategy produced this job, and what changed since the last one. A job stores
// the strategy it was created under (hash, version when that content was frozen,
// and the section map itself), the job page shows it, and a change against the
// previous job on the same repository is a section-key diff. The older job keeps
// its own hash: history is read, never rewritten.

const SECTIONS = {
  'goal:guidance': 'console:goal:aaa',
  'playbook:team': 'playbook:v8:deadbeef',
  'rules:review': 'console:revision:2',
}

test('a section diff names added, changed and removed keys in a stable order', async () => {
  const { diffStrategies } = await import('../src/strategy/bundle.js')
  const changes = diffStrategies(
    { 'goal:guidance': 'console:goal:aaa', 'playbook:team': 'playbook:v8:deadbeef', 'template:bug': 'console:revision:1' },
    { 'goal:guidance': 'console:goal:aaa', 'playbook:team': 'playbook:v9:cafe', 'rubric:correctness': 'console:revision:4' },
  )
  assert.deepEqual(changes.map((change) => change.key), ['playbook:team', 'rubric:correctness', 'template:bug'])
  assert.deepEqual(changes.find((change) => change.key === 'playbook:team'), { key: 'playbook:team', before: 'playbook:v8:deadbeef', after: 'playbook:v9:cafe' })
  assert.deepEqual(changes.find((change) => change.key === 'rubric:correctness'), { key: 'rubric:correctness', after: 'console:revision:4' })
  assert.deepEqual(changes.find((change) => change.key === 'template:bug'), { key: 'template:bug', before: 'console:revision:1' })
  assert.deepEqual(diffStrategies(SECTIONS, { ...SECTIONS }), [], 'identical strategies must show no change')
})

async function harness() {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: undefined, runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'strategy-job-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_strategy_jobs',
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    autoMerge: false,
    roleCheckedAt: new Date().toISOString(),
    goal: 'ship the strategy bundle',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const other = store.createRepo({
    id: 'repo_strategy_jobs_other',
    userId: user.id,
    owner: 'acme',
    name: 'other',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    autoMerge: false,
    roleCheckedAt: new Date().toISOString(),
    goal: 'a different goal',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const session = sessionFor(built, user)
  const current = (repoId: string) => {
    const row = store.getRepo(repoId)!
    const assembled = currentStrategySections(store, { id: row.id, goal: row.goal })
    assert.equal(assembled.ok, true)
    return assembled.ok ? assembled : { sections: {}, hash: '' }
  }
  const job = (id: string, repoId = repo.id): ReturnType<Store['createJob']> => makeTerminalJob(store, {
    id,
    repoId,
    userId: user.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: `cb-${id}`,
    platformTokenHash: '',
  })
  const page = (repoId: string, jobId: string, lang = 'en') => built.app.inject({
    method: 'GET',
    url: `/repos/${repoId}/jobs/${jobId}`,
    headers: { cookie: `${session.cookie}; fledge_lang=${lang}` },
  })
  return { built, store, user, repo, other, session, current, job, page, close: async () => { await built.close() } }
}

test('a job records the exact strategy hash and section map it was created under', async () => {
  const h = await harness()
  try {
    const before = h.current(h.repo.id)
    const created = h.job('job_strategy_hash')
    const stored = h.store.getJob(created.id)!
    assert.equal(stored.strategy_hash, before.hash, 'the job did not record the strategy hash it was created under')
    assert.equal(stored.strategy_version, null, 'an unfrozen strategy claimed a version')
    assert.deepEqual(JSON.parse(stored.strategy_json ?? '{}'), before.sections, 'the job did not keep the section map it recorded')
    assert.equal(strategyHash(JSON.parse(stored.strategy_json ?? '{}')), stored.strategy_hash, 'the stored sections do not hash to the stored hash')
  } finally {
    await h.close()
  }
})

test('a job that runs a frozen strategy records its version', async () => {
  const h = await harness()
  try {
    const current = h.current(h.repo.id)
    const frozen = h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: current.sections, createdBy: h.user.login, expectedBase: 0 })
    assert.equal(frozen.ok, true)
    const created = h.job('job_strategy_version')
    const stored = h.store.getJob(created.id)!
    assert.equal(stored.strategy_hash, current.hash)
    assert.equal(stored.strategy_version, 1, 'a job on a frozen strategy did not record the version it was frozen as')
  } finally {
    await h.close()
  }
})

test('the job page shows the strategy hash and does not call an unfrozen strategy a version', async () => {
  const h = await harness()
  try {
    const hash = h.current(h.repo.id).hash
    const created = h.job('job_strategy_page')
    const response = await h.page(h.repo.id, created.id)
    assert.equal(response.statusCode, 200)
    assert.match(response.body, new RegExp(`data-strategy-hash="${hash}"`), 'the page does not show the strategy hash the job recorded')
    assert.match(response.body, /data-strategy-version="none"/, 'an unfrozen strategy is presented as a version')
    assert.match(response.body, /not frozen/i, 'the page does not say the strategy was never frozen')
  } finally {
    await h.close()
  }
})

test('a strategy change since the previous job is a section diff, and the older job keeps its own hash', async () => {
  const h = await harness()
  try {
    const first = h.job('job_strategy_first')
    const firstHash = h.store.getJob(first.id)!.strategy_hash!
    h.store.upsertRepoRuleOverride({ repoId: h.repo.id, path: '.github/rules/review.md', content: 'be brief', updatedBy: h.user.login, expectedRevision: 0 })
    const second = h.job('job_strategy_second')
    const secondHash = h.store.getJob(second.id)!.strategy_hash!
    assert.notEqual(secondHash, firstHash, 'the changed rule override did not change the recorded strategy')

    const newer = await h.page(h.repo.id, second.id)
    assert.equal(newer.statusCode, 200)
    assert.match(newer.body, /data-strategy-diff/, 'the job page does not show a strategy diff against the previous job')
    assert.match(newer.body, new RegExp(`data-strategy-key="rules:\\.github/rules/review\\.md"`), 'the diff does not name the key that changed')
    assert.match(newer.body, new RegExp(firstHash), 'the diff does not name the previous hash')
    assert.match(newer.body, new RegExp(secondHash), 'the diff does not name this job hash')
    assert.doesNotMatch(newer.body, /data-strategy-key="goal:guidance"/, 'a section that did not change is listed as a change')

    const older = await h.page(h.repo.id, first.id)
    assert.equal(older.statusCode, 200)
    assert.match(older.body, new RegExp(`data-strategy-hash="${firstHash}"`), 'the older job no longer shows the hash it recorded')
    assert.doesNotMatch(older.body, new RegExp(secondHash), 'history was rewritten: the older job page shows the newer strategy')
  } finally {
    await h.close()
  }
})

test('a strategy change is shown in both languages', async () => {
  const h = await harness()
  try {
    h.job('job_strategy_zh_first')
    h.store.upsertRepoRuleOverride({ repoId: h.repo.id, path: '.github/rules/review.md', content: 'be brief', updatedBy: h.user.login, expectedRevision: 0 })
    const second = h.job('job_strategy_zh_second')
    const zh = await h.page(h.repo.id, second.id, 'zh')
    assert.equal(zh.statusCode, 200)
    assert.match(zh.body, /策略/, 'the Chinese page does not name the strategy')
    const en = await h.page(h.repo.id, second.id, 'en')
    assert.match(en.body, /strategy/i)
  } finally {
    await h.close()
  }
})

test('a job that predates the strategy columns shows nothing rather than a wrong strategy', async () => {
  const h = await harness()
  try {
    const created = h.job('job_strategy_legacy')
    h.store.run('UPDATE jobs SET strategy_hash = NULL, strategy_version = NULL, strategy_json = NULL WHERE id = ?', created.id)
    const response = await h.page(h.repo.id, created.id)
    assert.equal(response.statusCode, 200)
    assert.doesNotMatch(response.body, /data-strategy-hash=/, 'a job with no recorded strategy still claims one')
    assert.match(response.body, /no strategy/i, 'the page does not say the job has no recorded strategy')
  } finally {
    await h.close()
  }
})

test('the previous strategy job is read from the same repository only', async () => {
  const h = await harness()
  try {
    const foreign = h.job('job_strategy_foreign', h.other.id)
    const local = h.job('job_strategy_local')
    assert.equal(h.store.previousStrategyJob(h.repo.id, local.id), undefined, 'the first job on a repository has a previous strategy job')
    const later = h.job('job_strategy_later', h.other.id)
    assert.equal(h.store.previousStrategyJob(h.other.id, later.id)?.id, foreign.id, 'a job on another repository was read as the previous strategy job')
    assert.equal(h.store.previousStrategyJob(h.repo.id, later.id)?.id, local.id, 'the repository scope was ignored')
  } finally {
    await h.close()
  }
})
