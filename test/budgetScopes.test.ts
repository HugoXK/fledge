import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { MockRunner } from '../src/jobs/mock.js'
import { budgetStop } from '../src/lib/budgetScope.js'
import type { BudgetScopeCandidate } from '../src/lib/budgetScope.js'
import { identityPrincipalId } from '../src/identity/authorization.js'
import { localizeMessage } from '../src/i18n.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { repoPage } from '../src/views/pages.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #697: the per-job budget (#357, #636) is one scope. This slice adds two more —
// a repository cap and a principal (the actor who starts work) cap — over one
// additive table, read at the same single checkpoint, with the same
// `job_budget_action` vocabulary and the same `#357` unknown-not-zero guard.
//
// The properties this suite exists for, in the order they can go wrong:
// - one cap per scope, not one per job: spend from two jobs and a retry chain
//   crosses a single repository cap once;
// - a principal cap follows the person across repositories;
// - an unpriced call is never read as zero at any scope, while a chain priced
//   only in CNY still counts as priced (the `#357` guard needs that);
// - another currency cannot move a CNY cap;
// - precedence job > repository > principal, and the refusal names the scope
//   that fired, so an operator can tell which cap to raise;
// - the console shows the cap, the spend and the scope, and says when the spend
//   is a lower bound because a call could not be priced.

const CJK = /[\u3400-\u9fff]/

interface Harness {
  store: Store
  jobs: Jobs
  mailer: MemoryMailer
  config: ReturnType<typeof testConfig>
}

function harness(): Harness {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, config, new MockRunner(), mailer)
  return { store, jobs, mailer, config }
}

let seq = 0

function makeRepo(h: Harness, userId: string, id: string, input: { jobBudgetCny?: number; jobBudgetAction?: string } = {}): RepoRow {
  return h.store.createRepo({
    id,
    userId,
    owner: 'o',
    name: id,
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', h.config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
    jobBudgetCny: input.jobBudgetCny ?? 0,
    ...(input.jobBudgetAction === undefined ? {} : { jobBudgetAction: input.jobBudgetAction }),
  } as Parameters<Store['createRepo']>[0])
}

function startJob(h: Harness, repo: RepoRow, userId: string, input: { retryOf?: string } = {}): { id: string; secret: string } {
  seq += 1
  const id = `job_budget_scope_${seq}`
  const secret = `secret_${seq}`
  h.store.createJob({
    id,
    repoId: repo.id,
    userId,
    trigger: 'manual',
    goal: 'g',
    callbackHash: sha256Hex(secret),
    platformTokenHash: '',
    kind: 'iterate',
    retryOf: input.retryOf ?? null,
  })
  h.store.updateJob(id, { status: 'running', started_at: new Date().toISOString() })
  return { id, secret }
}

const candidate = (kind: BudgetScopeCandidate['kind'], id: string, capCny: number, spentUsd: number, action = 'pause'): BudgetScopeCandidate => ({ kind, id, capCny, spentUsd, action })

// The decision itself, with no store and no clock: precedence first, then the
// stricter of two caps at the same specificity, and never an `alert` scope.
test('#697 the decision prefers the more specific scope over a wider one with less room', () => {
  const stop = budgetStop([
    candidate('principal', identityPrincipalId('u1'), 100, 20), // 144 CNY spent of 100: over
    candidate('repository', 'repo_1', 100, 30), // 216 of 100: over, less room than the job
    candidate('job', 'job_1', 10, 2), // 14.4 of 10: over
  ], 7.2)
  assert.equal(stop?.kind, 'job', 'the job scope is the most specific and wins even with more room left')
  assert.equal(stop?.code, 'JOB_BUDGET_PAUSED')
})

test('#697 two exceeded scopes at the same specificity are decided by the lower remaining budget', () => {
  const stop = budgetStop([
    candidate('principal', 'principal:a', 10, 1.5), // 108 spent of 10
    candidate('principal', 'principal:b', 100, 20), // 144 of 100: lower remaining
  ], 7.2)
  assert.equal(stop?.id, 'principal:b', 'the stricter cap is the one that fires')
})

test('#697 an alert scope never stops a job, and a scope under its cap is not a stop', () => {
  assert.equal(budgetStop([candidate('repository', 'repo_1', 10, 5, 'alert')], 7.2), null)
  assert.equal(budgetStop([candidate('repository', 'repo_1', 100, 5)], 7.2), null)
  assert.equal(budgetStop([], 7.2), null)
})

test('#697 a repository cap is one cap for the repository, and a retry does not reset it', async () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-repo', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_repo')
    h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 0.04, action: 'pause' })
    const first = startJob(h, repo, user.id)
    h.store.recordUsage(user.id, first.id, 0.003, null, repo.id, { currency: 'USD' })
    // A retry follows a job that already ended: one running job per repository.
    h.store.updateJob(first.id, { status: 'failed', finished_at: new Date().toISOString() })
    // The first job's own chain is under the cap; the repository total is not.
    assert.equal(h.store.repoUsageSince(repo.id, new Date(Date.now() - 30 * 86_400_000).toISOString()) > 0, true)
    const retry = startJob(h, repo, user.id, { retryOf: first.id })
    h.store.recordUsage(user.id, retry.id, 0.003, null, repo.id, { currency: 'USD' })

    const result = await h.jobs.handleCallback(retry.id, retry.secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(result.ok, true)
    const job = h.store.getJob(retry.id)
    assert.equal(job?.status, 'paused', 'the repository cap stops the job that crosses it')
    assert.match(String(job?.error), /^JOB_BUDGET_PAUSED/, 'the same code shape as the per-job stop')
    assert.equal(CJK.test(localizeMessage('en', String(job?.error)) ?? ''), false, `the English reason must not be the raw Chinese sentence: ${String(job?.error)}`)
    const audit = h.store.listAudit(50).find((row) => row.action === 'job.budget_paused')
    assert.ok(audit, 'the stop is audited')
    assert.match(String(audit.detail), new RegExp(`repository ${repo.id}`), 'the audit names the scope that fired')
  } finally {
    h.store.close()
  }
})

test('#697 a principal cap follows the same user across repositories', async () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-user', status: 'approved' })
    const repoA = makeRepo(h, user.id, 'repo_scope_a')
    const repoB = makeRepo(h, user.id, 'repo_scope_b')
    const principal = identityPrincipalId(user.id)
    h.store.setBudgetScope({ kind: 'principal', id: principal, capCny: 0.04, action: 'pause' })
    const jobA = startJob(h, repoA, user.id)
    h.store.recordUsage(user.id, jobA.id, 0.003, null, repoA.id, { currency: 'USD' })
    const jobB = startJob(h, repoB, user.id)
    h.store.recordUsage(user.id, jobB.id, 0.003, null, repoB.id, { currency: 'USD' })

    const result = await h.jobs.handleCallback(jobB.id, jobB.secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(result.ok, true)
    const job = h.store.getJob(jobB.id)
    assert.equal(job?.status, 'paused', 'spend in another repository counts against the principal cap')
    assert.match(String(job?.error), /JOB_BUDGET_PAUSED/)
    const audit = h.store.listAudit(50).find((row) => row.action === 'job.budget_paused')
    assert.match(String(audit?.detail), new RegExp(`principal ${principal}`), 'the refusal names the principal scope')
  } finally {
    h.store.close()
  }
})

test('#697 an unpriced chain is an unknown cost at the repository scope, not a pass', async () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-repo-unknown', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_unknown')
    h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 0.04, action: 'pause' })
    const job = startJob(h, repo, user.id)

    await h.jobs.handleCallback(job.id, job.secret, { status: 'running', summary: 'checkpoint 1' })
    await h.jobs.handleCallback(job.id, job.secret, { status: 'running', summary: 'checkpoint 2' })
    assert.equal(h.store.getJob(job.id)?.status, 'running', 'an unpriced call never reads as fitting the cap')
    const unknowns = h.store.listJobEvents(job.id).filter((row) => row.kind === 'job.budget_unknown')
    assert.equal(unknowns.length, 1, 'the unknown refusal is recorded once, not on every checkpoint')
    assert.equal(h.store.listAudit(50).filter((row) => row.action === 'job.budget_unknown').length, 1)
  } finally {
    h.store.close()
  }
})

test('#697 an unpriced chain is an unknown cost at the principal scope too', async () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-user-unknown', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_user_unknown')
    h.store.setBudgetScope({ kind: 'principal', id: identityPrincipalId(user.id), capCny: 0.04, action: 'cancel' })
    const job = startJob(h, repo, user.id)

    await h.jobs.handleCallback(job.id, job.secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(h.store.getJob(job.id)?.status, 'running', 'no priced row is unknown, never zero')
    assert.equal(h.store.listJobEvents(job.id).filter((row) => row.kind === 'job.budget_unknown').length, 1)
  } finally {
    h.store.close()
  }
})

test('#697 another currency cannot move a CNY cap, and a CNY-only chain is not an unknown cost', async () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-cny', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_cny')
    h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 0.01, action: 'pause' })
    const job = startJob(h, repo, user.id)
    h.store.recordUsage(user.id, job.id, 100, null, repo.id, { currency: 'CNY' })

    await h.jobs.handleCallback(job.id, job.secret, { status: 'running', summary: 'checkpoint 1' })
    const after = h.store.getJob(job.id)
    assert.equal(after?.status, 'running', 'a CNY-priced row does not move a CNY cap fed by USD rows')
    assert.equal(h.store.listJobEvents(job.id).filter((row) => row.kind === 'job.budget_unknown').length, 0, 'the chain recorded a priced row, so it is not unknown')
  } finally {
    h.store.close()
  }
})

test('#697 the narrower scope wins when two scopes are over at once', async () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-narrow', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_narrow')
    h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 0.01, action: 'pause' })
    h.store.setBudgetScope({ kind: 'principal', id: identityPrincipalId(user.id), capCny: 100, action: 'pause' })
    const job = startJob(h, repo, user.id)
    h.store.recordUsage(user.id, job.id, 1, null, repo.id, { currency: 'USD' })

    await h.jobs.handleCallback(job.id, job.secret, { status: 'running', summary: 'checkpoint 1' })
    assert.equal(h.store.getJob(job.id)?.status, 'paused')
    const audit = h.store.listAudit(50).find((row) => row.action === 'job.budget_paused')
    assert.match(String(audit?.detail), new RegExp(`repository ${repo.id}`), 'the repository scope is more specific than the principal scope')
  } finally {
    h.store.close()
  }
})

test('#697 the per-job budget still wins over both new scopes', async () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-job-first', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_job', { jobBudgetCny: 0.01, jobBudgetAction: 'pause' })
    h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 100, action: 'cancel' })
    const job = startJob(h, repo, user.id)
    h.store.recordUsage(user.id, job.id, 1, null, repo.id, { currency: 'USD' })

    await h.jobs.handleCallback(job.id, job.secret, { status: 'running', summary: 'checkpoint 1' })
    const after = h.store.getJob(job.id)
    assert.equal(after?.status, 'paused', 'the per-job pause is unchanged')
    assert.match(String(after?.error), /^JOB_BUDGET_PAUSED/, 'the more specific scope decides the action and the sentence')
  } finally {
    h.store.close()
  }
})

test('#697 a scope cap is one row per scope, replaces in place, and zero removes it', () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-store', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_store')
    h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 5, action: 'pause' })
    h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 7, action: 'cancel' })
    assert.equal(h.store.listBudgetScopes('repository').length, 1, 'setting the same scope twice keeps one row')
    assert.equal(h.store.getBudgetScope('repository', repo.id)?.cap_cny, 7)
    assert.equal(h.store.getBudgetScope('repository', repo.id)?.action, 'cancel')
    h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 0, action: 'pause' })
    assert.equal(h.store.getBudgetScope('repository', repo.id), undefined, 'a zero cap removes the row: no row means no cap')
    assert.throws(() => h.store.setBudgetScope({ kind: 'branch', id: repo.id, capCny: 1, action: 'pause' }), /scope kind/i)
    assert.throws(() => h.store.setBudgetScope({ kind: 'repository', id: repo.id, capCny: 1, action: 'stop' }), /action/i)
  } finally {
    h.store.close()
  }
})

test('#697 the repository page shows the cap, the spend, the scope and the lower-bound caveat', () => {
  const h = harness()
  try {
    const user = makeUser(h.store, { login: 'scope-console', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_console')
    const viewer = { user: h.store.userById(user.id)!, csrfToken: 'csrf' }
    const page = repoPage({
      config: h.config,
      locale: 'en',
      viewer,
      repo,
      jobs: [],
      budgetScopes: [
        { kind: 'repository', label: 'o/repo_scope_console', capCny: 3, spentCny: 1.2, action: 'pause', unknownCount: 0 },
        { kind: 'principal', label: '@scope-console', capCny: 0, spentCny: 0.4, action: 'alert', unknownCount: 2 },
      ],
    })
    assert.match(page, /Repository budget/)
    assert.match(page, /User budget/)
    assert.match(page, /o\/repo_scope_console/, 'the scope row names the scope it belongs to')
    assert.match(page, /3\.00/, 'the cap')
    assert.match(page, /1\.20/, 'the spend consumed against it')
    assert.match(page, /no cap/i, 'the empty state is stated, not left blank')
    assert.match(page, /lower bound/i, 'an unpriced call makes the spend a lower bound')
    assert.match(page, /2 calls could not be priced/i, 'the caveat carries the count')
    const zh = repoPage({
      config: h.config,
      locale: 'zh',
      viewer,
      repo,
      jobs: [],
      budgetScopes: [{ kind: 'principal', label: '@scope-console', capCny: 0, spentCny: 0.4, action: 'alert', unknownCount: 1 }],
    })
    assert.match(zh, /用户预算/)
    assert.match(zh, /未设置/)
  } finally {
    h.store.close()
  }
})

test('#697 the repository settings form sets and clears both scope caps', async () => {
  const h = harness()
  const built = await buildApp({ config: h.config, store: h.store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(h.store, { login: 'scope-form', status: 'approved' })
    const repo = makeRepo(h, user.id, 'repo_scope_form')
    const { cookie, csrf } = sessionFor(built, user)

    const save = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repoRole: 'maintainer', repoBudget: '3', repoBudgetAction: 'pause', principalBudget: '5', principalBudgetAction: 'cancel' }),
    })
    assert.equal(save.statusCode, 302)
    assert.equal(h.store.getBudgetScope('repository', repo.id)?.cap_cny, 3)
    assert.equal(h.store.getBudgetScope('repository', repo.id)?.action, 'pause')
    assert.equal(h.store.getBudgetScope('principal', identityPrincipalId(user.id))?.cap_cny, 5)
    assert.equal(h.store.getBudgetScope('principal', identityPrincipalId(user.id))?.action, 'cancel')

    const clear = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repoRole: 'maintainer', repoBudget: '0', repoBudgetAction: 'pause', principalBudget: '0', principalBudgetAction: 'alert' }),
    })
    assert.equal(clear.statusCode, 302)
    assert.equal(h.store.getBudgetScope('repository', repo.id), undefined, 'zero clears the repository cap')
    assert.equal(h.store.getBudgetScope('principal', identityPrincipalId(user.id)), undefined, 'zero clears the principal cap')
  } finally {
    // `built.close()` closes the store, so it is not closed twice.
    await built.close()
  }
})
