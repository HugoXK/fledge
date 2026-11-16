import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Store, type JobRow, type RepoRow, type UserRow } from '../src/db.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Jobs } from '../src/jobs/service.js'
import { MockRunner } from '../src/jobs/mock.js'
import { capabilitiesForRole } from '../src/identity/authorization.js'
import { managementActor } from '../src/management/actor.js'
import { ManagementService, type CommandEnvelope } from '../src/management/service.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { flashOf, formBody, MemoryMailer, makeUser, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #540 slice 6: merging is the first command whose durable effect is not in
// SQLite. GitHub performs the merge and the answer can be lost, so the receipt
// enters `unknown`; the next attempt reads the pull request back and either
// settles the local record the lost answer skipped or resends, never blindly.

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

interface GithubState {
  merged: boolean
  mergeAttempts: number
  mergeSha: string
  draft: boolean
  // 'lost' performs the merge and drops the answer; 'refuse' drops the answer
  // without merging, which is the case the probe must read as absent.
  mode: 'none' | 'lost' | 'refuse'
}

interface Harness {
  store: Store
  jobs: Jobs
  service: ManagementService
  repo: RepoRow
  job: JobRow
  state: GithubState
  user: string
  close: () => Promise<void>
}

// #540 slice 6: both suites below need the same fake GitHub. The merge route
// and the command service read the pull request, its checks and its merge
// answer from here.
function fakeGithub(state: GithubState): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        title: 'fix',
        state: state.merged ? 'closed' : 'open',
        head: { ref: 'fledge/fix', sha: 'abc' },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean',
        draft: state.draft,
        merged: state.merged,
        ...(state.merged ? { merge_commit_sha: state.mergeSha } : {}),
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
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      state.mergeAttempts += 1
      if (state.mode === 'lost') {
        state.merged = true
        request.socket.destroy()
        return
      }
      if (state.mode === 'refuse') {
        request.socket.destroy()
        return
      }
      state.merged = true
      json(response, 200, { merged: true, sha: state.mergeSha })
      return
    }
    json(response, 404, { message: 'Not Found' })
  }
}

async function harness(id: string): Promise<Harness> {
  const state: GithubState = { merged: false, mergeAttempts: 0, mergeSha: 'def', draft: false, mode: 'none' }
  const github = await startFakeServer(fakeGithub(state))

  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url }, managementService: 'on' })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' as const } } }, new MemoryMailer())
  const user = makeUser(store, { login: `merge-${id}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_merge_${id}`,
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    upstreamHtmlUrl: 'https://github.com/o/r',
    forkHtmlUrl: 'https://github.com/o/r',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const item = store.createWorkItem({ id: `work_merge_${id}`, repoId: repo.id, userId: user.id, title: 'fix', prUrl: 'https://github.com/o/r/pull/1', state: 'pr_ready' })
  const job = store.createJob({ id: `job_merge_${id}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb-merge-${id}`, platformTokenHash: '', kind: 'iterate', baseBranch: 'main', workItemId: item.id })
  store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/fix', pr_url: 'https://github.com/o/r/pull/1', finished_at: new Date().toISOString() })
  const service = new ManagementService(store, jobs)
  return {
    store,
    jobs,
    service,
    repo,
    job: store.getJob(job.id)!,
    state,
    user: user.id,
    close: async () => {
      store.close()
      await github.close()
    },
  }
}

function envelope(h: Harness, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    operation: 'task.merge',
    target: { projectId: h.repo.id, jobId: h.job.id },
    arguments: {},
    expectedRevision: h.service.revisionOf('job', h.job.id),
    idempotencyKey: 'key-merge-1',
    ...overrides,
  }
}

test('the same key and target replay one merge and one receipt', async () => {
  const h = await harness('replay')
  try {
    const actor = managementActor({ store: h.store, userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-m1' })
    // The form carries the revision it rendered, so a replay sends that same
    // revision — recomputing it after the merge would read as a different request.
    const env = envelope(h)
    const first = await h.service.run(actor, env)
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.equal(first.replayed, false)
    assert.equal(h.state.mergeAttempts, 1)

    const again = await h.service.run(actor, env)
    assert.equal(again.ok, true)
    if (!again.ok) return
    assert.equal(again.replayed, true, 'a second submit answers the first receipt')
    assert.equal(again.receipt.id, first.receipt.id)
    assert.equal(h.state.mergeAttempts, 1, 'a replay never reaches GitHub')
    assert.equal(h.store.listAudit(100).filter((row) => row.action === 'job.manually_merged').length, 1)
    assert.equal(h.store.getWorkItem(`work_merge_replay`)?.state, 'merged')
    assert.equal(h.store.getJob(h.job.id)?.pr_state, 'merged')
  } finally {
    await h.close()
  }
})

test('the same key with a different target is an idempotency conflict', async () => {
  const h = await harness('conflict')
  try {
    const actor = managementActor({ store: h.store, userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-m2' })
    const other = h.store.createJob({ id: 'job_merge_conflict_2', repoId: h.repo.id, userId: h.user, trigger: 'manual', goal: 'g', callbackHash: 'cb-merge-conflict-2', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    h.store.updateJob(other.id, { status: 'succeeded', branch: 'fledge/fix2', pr_url: 'https://github.com/o/r/pull/1' })

    const first = await h.service.run(actor, envelope(h))
    assert.equal(first.ok, true)
    const conflicted = await h.service.run(actor, envelope(h, { target: { projectId: h.repo.id, jobId: other.id }, expectedRevision: h.service.revisionOf('job', other.id) }))
    assert.equal(conflicted.ok, false)
    if (conflicted.ok) return
    assert.equal(conflicted.code, 'idempotency_conflict')
    assert.equal(h.state.mergeAttempts, 1, 'the conflict never reaches GitHub')
  } finally {
    await h.close()
  }
})

test('a stale expected revision writes nothing', async () => {
  const h = await harness('stale')
  try {
    const actor = managementActor({ store: h.store, userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-m3' })
    const stale = await h.service.run(actor, envelope(h, { expectedRevision: h.service.revisionOf('job', h.job.id) + 7 }))
    assert.equal(stale.ok, false)
    if (stale.ok) return
    assert.equal(stale.code, 'management_revision_conflict')
    assert.equal(h.state.mergeAttempts, 0, 'a stale page never merges')
    assert.equal(h.store.getWorkItem('work_merge_stale')?.state, 'pr_ready')
  } finally {
    await h.close()
  }
})

test('a lost merge answer stays unknown, and the retry settles the local record without a second merge', async () => {
  const h = await harness('lost')
  try {
    const actor = managementActor({ store: h.store, userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-m4' })
    h.state.mode = 'lost'
    const lost = await h.service.run(actor, envelope(h))
    assert.equal(lost.ok, false)
    if (lost.ok) return
    assert.equal(lost.code, 'management_unknown', 'a transport failure is unknown, not a refusal')
    assert.equal(h.state.mergeAttempts, 1)
    assert.equal(h.state.merged, true, 'GitHub merged; only the answer was lost')
    assert.equal(h.store.commandReceipt(lost.receipt?.id ?? '')?.status, 'unknown')
    assert.equal(h.store.getWorkItem('work_merge_lost')?.state, 'pr_ready', 'the local record was not written yet')

    h.state.mode = 'none'
    const settled = await h.service.run(actor, envelope(h))
    assert.equal(settled.ok, true)
    if (!settled.ok) return
    assert.equal(settled.result.reconciled, true, 'the receipt says the effect was found, not performed')
    assert.equal(h.state.mergeAttempts, 1, 'the reconcile probe is a read; no second merge')
    assert.equal(h.store.getWorkItem('work_merge_lost')?.state, 'merged', 'the settle writes what the lost answer skipped')
    assert.equal(h.store.getWorkItem('work_merge_lost')?.merge_commit, 'def', 'the settle records the commit GitHub made')
    assert.equal(h.store.getJob(h.job.id)?.pr_state, 'merged')
    assert.equal(h.store.listAudit(100).filter((row) => row.action === 'job.manually_merged').length, 1, 'one merge, one audit row')
  } finally {
    await h.close()
  }
})

test('an unconfirmed merge that did not happen is resent exactly once', async () => {
  const h = await harness('absent')
  try {
    const actor = managementActor({ store: h.store, userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-m5' })
    h.state.mode = 'refuse'
    const lost = await h.service.run(actor, envelope(h))
    assert.equal(lost.ok, false)
    if (lost.ok) return
    assert.equal(lost.code, 'management_unknown')
    assert.equal(h.state.merged, false, 'GitHub did not merge, so the probe can prove absence')

    h.state.mode = 'none'
    const resent = await h.service.run(actor, envelope(h))
    assert.equal(resent.ok, true)
    if (!resent.ok) return
    assert.equal(resent.replayed, false, 'a reconciled resend is a real execution')
    assert.equal(resent.result.reconciled, undefined)
    assert.equal(h.state.mergeAttempts, 2, 'the command ran again exactly once')
    assert.equal(h.store.getWorkItem('work_merge_absent')?.state, 'merged')
  } finally {
    await h.close()
  }
})

test('a caller without job.merge cannot merge', async () => {
  const h = await harness('capability')
  try {
    assert.equal(capabilitiesForRole('maintainer').includes('job.merge'), true)
    assert.equal(capabilitiesForRole('developer').includes('job.merge'), false, 'merging stays maintainer-only')
    const stranger = makeUser(h.store, { login: 'merge-stranger', status: 'approved' })
    const actor = managementActor({ store: h.store, userId: stranger.id, repo: h.repo, channel: 'web', requestId: 'req-m6' })
    const refused = await h.service.run(actor, envelope(h))
    assert.equal(refused.ok, false)
    if (refused.ok) return
    assert.equal(refused.code, 'authorization_revoked')
    assert.equal(h.state.mergeAttempts, 0, 'the refusal happens before the merge call')
    assert.equal(h.store.getWorkItem('work_merge_capability')?.state, 'pr_ready')
  } finally {
    await h.close()
  }
})

// #540 slice 6: the command service covers the contract; these two cover what
// the merge button is for a maintainer — a fresh key after the merge already
// landed still succeeds and writes the rows, and the route runs the same command
// in `on`, `shadow` and `off` without changing what it does.

test('a fresh key after the merge landed succeeds and writes the skipped rows', async () => {
  const h = await harness('freshafter')
  try {
    const actor = managementActor({ store: h.store, userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-m7' })
    const first = await h.service.run(actor, envelope(h))
    assert.equal(first.ok, true)
    assert.equal(h.state.mergeAttempts, 1)

    // A second attempt with a new key does not replay the old receipt: it reads
    // the pull request back, finds the effect already there and records it.
    const second = await h.service.run(actor, envelope(h, { idempotencyKey: 'key-merge-2' }))
    assert.equal(second.ok, true, 'the effect is there, so the command succeeds')
    if (!second.ok) return
    assert.equal(second.replayed, false)
    assert.equal(second.result.alreadyMerged, true)
    assert.equal(h.state.mergeAttempts, 1, 'the probe is a read; no second merge')
    assert.equal(h.store.getWorkItem(`work_merge_freshafter`)?.state, 'merged')
    assert.equal(h.store.getJob(h.job.id)?.pr_state, 'merged')
  } finally {
    await h.close()
  }
})

interface AppHarness {
  built: BuiltApp
  store: Store
  state: GithubState
  user: UserRow
  repo: RepoRow
  job: JobRow
  close: () => Promise<void>
}

async function appHarness(id: string, mode: 'on' | 'shadow' | 'off'): Promise<AppHarness> {
  const state: GithubState = { merged: false, mergeAttempts: 0, mergeSha: 'def', draft: false, mode: 'none' }
  const github = await startFakeServer(fakeGithub(state))
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url }, managementService: mode })
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const runner = new MockRunner()
  const built = await buildApp({ config, store, mailer, runner, startScheduler: false })
  const user = makeUser(store, { login: `route-merge-${id}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_route_${id}`,
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    upstreamHtmlUrl: 'https://github.com/o/r',
    forkHtmlUrl: 'https://github.com/o/r',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const item = store.createWorkItem({ id: `work_route_${id}`, repoId: repo.id, userId: user.id, title: 'fix', prUrl: 'https://github.com/o/r/pull/1', state: 'pr_ready' })
  const job = store.createJob({ id: `job_route_${id}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb-route-${id}`, platformTokenHash: '', kind: 'iterate', baseBranch: 'main', workItemId: item.id })
  store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/fix', pr_url: 'https://github.com/o/r/pull/1', finished_at: new Date().toISOString() })
  return {
    built,
    store,
    state,
    user,
    repo,
    job: store.getJob(job.id)!,
    close: async () => {
      // `built.close()` closes the store it was given; closing it twice throws.
      await built.close()
      await github.close()
    },
  }
}

function mergeForm(h: AppHarness, fields: Record<string, string> = {}) {
  const session = sessionFor(h.built, h.user)
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/jobs/${h.job.id}/merge`,
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf: session.csrf, ...fields }),
  })
}

test('the merge route runs the command in on mode, replays its key, and refuses a stale page', async () => {
  const h = await appHarness('on', 'on')
  try {
    const first = await mergeForm(h, { idempotency_key: 'route-key-1' })
    assert.equal(first.statusCode, 302)
    assert.match(flashOf(first)?.notice?.text ?? '', /已合并/)
    assert.equal(h.state.mergeAttempts, 1)

    const replay = await mergeForm(h, { idempotency_key: 'route-key-1', expected_revision: '1' })
    assert.equal(replay.statusCode, 302)
    assert.match(flashOf(replay)?.notice?.text ?? '', /已合并/)
    assert.equal(h.state.mergeAttempts, 1, 'the same key replays the receipt; GitHub is not called again')

    // The page rendered before the merge carried the old revision.
    const stale = await mergeForm(h, { idempotency_key: 'route-key-2', expected_revision: '1' })
    assert.equal(stale.statusCode, 302)
    assert.match(flashOf(stale)?.error?.key ?? '', /^management_revision_conflict:/)
    assert.equal(h.state.mergeAttempts, 1, 'a stale page never merges')
  } finally {
    await h.close()
  }
})

test('the merge route reports a gate refusal with the job code', async () => {
  const h = await appHarness('gate', 'on')
  try {
    // A draft is a gate `tryMerge` applies to a manual merge too.
    h.state.draft = true
    const response = await mergeForm(h, { idempotency_key: 'route-key-gate' })
    assert.equal(response.statusCode, 302)
    assert.match(flashOf(response)?.error?.key ?? '', /^job_not_merged:/)
    assert.match(flashOf(response)?.error?.text ?? '', /open/)
    assert.equal(h.state.mergeAttempts, 0, 'the gate refuses before the merge call')
  } finally {
    await h.close()
  }
})

test('the shadow route merges and settles the receipt, and off has no command', async () => {
  const shadow = await appHarness('shadow', 'shadow')
  try {
    const response = await mergeForm(shadow, { idempotency_key: 'route-key-shadow' })
    assert.equal(response.statusCode, 302)
    assert.match(flashOf(response)?.notice?.text ?? '', /已合并/)
    assert.equal(shadow.state.mergeAttempts, 1, 'shadow mode does not stop the merge')
  } finally {
    await shadow.close()
  }

  const off = await appHarness('off', 'off')
  try {
    const response = await mergeForm(off, { idempotency_key: 'route-key-off' })
    assert.equal(response.statusCode, 302)
    assert.match(flashOf(response)?.notice?.text ?? '', /已合并/)
    assert.equal(off.state.mergeAttempts, 1, 'off runs the direct path unchanged')
  } finally {
    await off.close()
  }
})
