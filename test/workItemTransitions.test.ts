import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { WORK_ITEM_TRANSITIONS } from '../src/lib/workItems.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// Both cases drive the public enqueue -> callback (or quotaBlocked) path and then
// ask the recorded table whether it offers the state the service just wrote, so
// the table cannot drift away from the service again without a red run.
function harness(): { store: Store; jobs: Jobs; contexts: RunnerContext[] } {
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'capture',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, testConfig(), runner, new MemoryMailer())
  return { store, jobs, contexts }
}

test('a failed job moves its work item to a state the recorded table offers', async () => {
  const { store, jobs, contexts } = harness()
  try {
    const user = makeUser(store, { login: 'transition-fail-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_transition_fail', userId: user.id, owner: 'o', name: 'tf', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const item = store.createWorkItem({ id: 'work_transition_fail', repoId: repo.id, userId: user.id, title: 'Fix parser', state: 'triaged' })
    const result = await jobs.enqueue(repo, 'manual', 'work goal', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    assert.equal(store.getWorkItem(item.id)?.state, 'in_progress', 'the job starts with the item in progress')

    await jobs.handleCallback(result.job!.id, contexts[0]!.callback.secret, { status: 'failed', error: 'bridge 502' })

    const after = store.getWorkItem(item.id)!
    assert.equal(after.state, 'triaged', 'a failed job returns its work item to triaged')
    assert.ok(
      WORK_ITEM_TRANSITIONS.in_progress.includes(after.state),
      `the service moved in_progress -> ${after.state}, but WORK_ITEM_TRANSITIONS.in_progress offers ${JSON.stringify(WORK_ITEM_TRANSITIONS.in_progress)}`,
    )
  } finally {
    store.close()
  }
})

test('a quota-refused job moves its work item to a state the recorded table offers', async () => {
  const { store, jobs } = harness()
  try {
    const user = makeUser(store, { login: 'transition-quota-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_transition_quota', userId: user.id, owner: 'o', name: 'tq', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const item = store.createWorkItem({ id: 'work_transition_quota', repoId: repo.id, userId: user.id, title: 'Fix parser', state: 'triaged' })
    const result = await jobs.enqueue(repo, 'manual', 'work goal', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    assert.equal(store.getWorkItem(item.id)?.state, 'in_progress', 'the job starts with the item in progress')

    await jobs.quotaBlocked(user)

    assert.equal(store.getJob(result.job!.id)?.status, 'quota_exhausted', 'the job ends quota_exhausted')
    const after = store.getWorkItem(item.id)!
    assert.equal(after.state, 'triaged', 'a quota-refused job leaves no active work item behind')
    assert.ok(
      WORK_ITEM_TRANSITIONS.in_progress.includes(after.state),
      `the service moved in_progress -> ${after.state}, but WORK_ITEM_TRANSITIONS.in_progress offers ${JSON.stringify(WORK_ITEM_TRANSITIONS.in_progress)}`,
    )
  } finally {
    store.close()
  }
})

// The origin the callback's pull-request link must live on. The API base is a
// loopback server, but the callback contract is https-only, so the row records
// this origin and the fake API answers the verification reads.
const ORIGIN = 'https://ghe.example.com'

test('a job that succeeds with a pull request moves an assigned work item to a state the recorded table offers', async () => {
  // Verification runs after the work-item write and talks to `apiBase`, so it
  // points at a local server that answers 404: this case is about the state the
  // service records, and no request may leave the machine.
  const api = await startFakeServer((_request, response) => json(response, 404, { message: 'Not Found' }))
  const base = testConfig()
  const store = new Store(':memory:')
  try {
    const config = testConfig({ github: { ...base.github, apiBase: api.url } })
    const contexts: RunnerContext[] = []
    const runner: Runner = {
      name: 'capture',
      async run(context) {
        contexts.push(context)
        return { status: 'running' }
      },
    }
    const jobs = new Jobs(store, config, runner, new MemoryMailer())
    const user = makeUser(store, { login: 'transition-pr-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_transition_pr', userId: user.id, owner: 'o', name: 'tp', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
      upstreamOwner: 'o', upstreamName: 'tp', upstreamDefaultBranch: 'main', upstreamHtmlUrl: `${ORIGIN}/o/tp`,
    })
    const item = store.createWorkItem({ id: 'work_transition_pr', repoId: repo.id, userId: user.id, title: 'Fix parser', state: 'triaged' })
    const result = await jobs.enqueue(repo, 'manual', 'work goal', 'iterate', { workItemId: item.id })
    assert.equal(result.ok, true)
    assert.equal(store.getWorkItem(item.id)?.state, 'in_progress', 'the job starts with the item in progress')

    // The board control refuses a step the table does not offer (src/app.ts:1641),
    // so every re-triage below is asserted against the table before it is written.
    for (const [from, to] of [['in_progress', 'triaged'], ['triaged', 'assigned']] as const) {
      assert.ok(
        WORK_ITEM_TRANSITIONS[from].includes(to),
        `the board cannot reach ${to} from ${from}: WORK_ITEM_TRANSITIONS.${from} offers ${JSON.stringify(WORK_ITEM_TRANSITIONS[from])}`,
      )
      store.updateWorkItem(item.id, { state: to })
    }

    await jobs.handleCallback(result.job!.id, contexts[0]!.callback.secret, { status: 'succeeded', prUrl: `${ORIGIN}/o/tp/pull/1`, summary: 'done' })

    const after = store.getWorkItem(item.id)!
    assert.equal(after.state, 'pr_ready', 'a succeeded job with a PR readies its work item')
    assert.ok(
      WORK_ITEM_TRANSITIONS.assigned.includes(after.state),
      `the service moved assigned -> ${after.state}, but WORK_ITEM_TRANSITIONS.assigned offers ${JSON.stringify(WORK_ITEM_TRANSITIONS.assigned)}`,
    )
  } finally {
    store.close()
    await api.close()
  }
})
