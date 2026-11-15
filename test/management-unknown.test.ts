import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type JobRow, type RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { managementActor } from '../src/management/actor.js'
import { ManagementService, type CommandEnvelope } from '../src/management/service.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #540 slice 5: a command whose external write may have crossed the commit
// boundary enters `unknown`, and the next attempt reconciles before it decides
// whether to resend. Before this slice the only answer was `command_in_progress`
// for ever, so a person whose bridge call timed out could neither retry nor
// learn what happened.

function harness(): { store: Store; jobs: Jobs; service: ManagementService; user: RepoRow['user_id']; repo: RepoRow } {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' as const } } }, new MemoryMailer())
  const user = makeUser(store, { login: 'unknown-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_unknown',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, jobs, service: new ManagementService(store, jobs), user: user.id, repo }
}

function queuedJob(store: Store, userId: string, repoId: string, id = 'job_unknown'): JobRow {
  return store.createJob({ id, repoId, userId, trigger: 'manual', goal: 'g', callbackHash: `cb-${id}`, platformTokenHash: '' })
}

function cancelEnvelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    operation: 'task.cancel',
    target: { projectId: 'repo_unknown', jobId: 'job_unknown' },
    arguments: {},
    expectedRevision: 1,
    idempotencyKey: 'key-unknown-1',
    ...overrides,
  }
}

// The external step is `Jobs.prepareCancel`, the bridge stop. Making it throw is
// the smallest honest simulation of a transport failure whose outcome nobody
// knows: the local write never ran, but the bridge may have received the stop.
function loseTheResponse(jobs: Jobs): () => void {
  const original = jobs.prepareCancel.bind(jobs)
  jobs.prepareCancel = async () => {
    throw new Error('socket hang up')
  }
  return () => {
    jobs.prepareCancel = original
  }
}

test('a lost external response leaves the receipt unknown, not an error and not a silent success', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-u1' })
    const restore = loseTheResponse(h.jobs)
    let outcome
    try {
      outcome = await h.service.run(actor, cancelEnvelope())
    } finally {
      restore()
    }
    assert.equal(outcome.ok, false)
    if (outcome.ok) return
    assert.equal(outcome.code, 'management_unknown', 'a transport failure is unknown, not a refusal to retry')
    const receipt = h.service.receipt(outcome.receipt?.id ?? '')
    assert.equal(receipt?.status, 'unknown')
    assert.equal(h.store.getJob('job_unknown')?.status, 'queued', 'the business write did not run')
    assert.equal(h.store.listAudit(50).filter((row) => row.action === 'job.cancelled').length, 0)
  } finally {
    h.store.close()
  }
})

test('the next attempt reconciles: an absent effect is resent exactly once', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-u2' })
    const restore = loseTheResponse(h.jobs)
    try {
      const lost = await h.service.run(actor, cancelEnvelope())
      assert.equal(lost.ok, false)
    } finally {
      restore()
    }
    // The bridge never received the stop, so the job row still says queued: the
    // reconcile finds nothing applied and the same command runs once more.
    const retried = await h.service.run(actor, cancelEnvelope())
    assert.equal(retried.ok, true)
    if (!retried.ok) return
    assert.equal(retried.replayed, false, 'a reconciled resend is a real execution, not a replay')
    assert.equal(retried.receipt.status, 'succeeded')
    assert.equal(h.store.getJob('job_unknown')?.status, 'cancelled')
    assert.equal(h.store.listAudit(50).filter((row) => row.action === 'job.cancelled').length, 1, 'one cancel, never two')
    assert.equal(h.store.listAudit(50).filter((row) => row.action === 'management.command').length >= 1, true)
  } finally {
    h.store.close()
  }
})

test('a reconcile that finds the effect already applied settles without a second cancel', async () => {
  const h = harness()
  try {
    queuedJob(h.store, h.user, h.repo.id)
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-u3' })
    const restore = loseTheResponse(h.jobs)
    try {
      const lost = await h.service.run(actor, cancelEnvelope())
      assert.equal(lost.ok, false)
    } finally {
      restore()
    }
    // Someone else's cancel (or the job finishing) is the effect this command
    // wanted; the marker is the job row, so the retry must not cancel again.
    h.store.updateJob('job_unknown', { status: 'cancelled' })
    const retried = await h.service.run(actor, cancelEnvelope())
    assert.equal(retried.ok, true)
    if (!retried.ok) return
    assert.equal(retried.receipt.status, 'succeeded')
    assert.equal(retried.result.reconciled, true, 'the receipt says the effect was found, not performed')
    assert.equal(h.store.listAudit(50).filter((row) => row.action === 'job.cancelled').length, 0, 'no second cancel')
  } finally {
    h.store.close()
  }
})

test('an operation with no reconcile hook stays unknown instead of being resent blind', async () => {
  const h = harness()
  try {
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-u4' })
    const repoEnvelope: CommandEnvelope = {
      operation: 'repo.update',
      target: { projectId: h.repo.id },
      arguments: { targetBranch: 'trunk' },
      expectedRevision: h.service.revisionOf('repo', h.repo.id),
      idempotencyKey: 'key-unknown-repo',
    }
    const begun = h.service.begin(actor, repoEnvelope)
    assert.equal(begun.ok, true)
    if (!begun.ok) return
    const marked = h.service.markUnknown(begun.receipt.id, actor)
    assert.equal(marked.ok, false)
    if (marked.ok) return
    assert.equal(marked.code, 'management_unknown')
    const retry = await h.service.run(actor, repoEnvelope)
    assert.equal(retry.ok, false)
    if (retry.ok) return
    assert.equal(retry.code, 'management_unknown', 'nothing proves the effect, so nothing is resent')
    assert.equal(h.store.commandReceipt(begun.receipt.id)?.status, 'unknown', 'it stays unknown, not failed')
    assert.equal(h.store.getRepo(h.repo.id)?.target_branch, 'main', 'no business write')
  } finally {
    h.store.close()
  }
})

test('only the principal that owns the receipt may mark it unknown', async () => {
  const h = harness()
  try {
    const actor = managementActor({ userId: h.user, repo: h.repo, channel: 'web', requestId: 'req-u5' })
    const begun = h.service.begin(actor, cancelEnvelope())
    assert.equal(begun.ok, true)
    if (!begun.ok) return
    const stranger = { ...actor, principalId: 'user_someone_else' }
    const refused = h.service.markUnknown(begun.receipt.id, stranger)
    assert.equal(refused.ok, false)
    if (refused.ok) return
    assert.equal(refused.code, 'actor_not_allowed')
    assert.equal(h.store.commandReceipt(begun.receipt.id)?.status, 'accepted', 'the receipt is untouched')
    const owned = h.service.markUnknown(begun.receipt.id, actor)
    assert.equal(owned.ok, false)
    if (owned.ok) return
    assert.equal(owned.code, 'management_unknown')
    assert.equal(h.store.commandReceipt(begun.receipt.id)?.status, 'unknown')
  } finally {
    h.store.close()
  }
})
