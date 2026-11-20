import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/db.js'
import { Jobs, DEFAULT_REVIEW_GOAL } from '../src/jobs/service.js'
import { CARRY_OVER_MARKER } from '../src/jobs/continuity.js'
import { playbookFor, playbookTextHash, teamLabelFor } from '../src/flybot/playbook.js'
import type { InstanceManager, RepoTeam } from '../src/flybot/instances.js'
import type { RepoRules } from '../src/rules.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #1118: the sealed contract has to name the playbook text the team was told.
// `ensurePlaybook` applies `playbookFor(role, team, repo.goal)` — the goal the
// repository form saves — while a job's own goal is the kind prompt for
// review/discover/triage/scope/verify and carries the preflight and carry-over
// tail for a follow-up. So the two can differ in the one section the text calls
// authoritative, and a contract built from the job goal records a text nobody
// was given.
//
// These cases drive the real seal: the rules loader is stubbed because reading a
// repository's rules needs the GitHub API, and everything after it — the skill
// bundle attestation, the contract, the row — runs as it does in a dispatch.

const RULES: RepoRules = {
  owner: 'acme',
  name: 'demo',
  commit: 'c'.repeat(40),
  files: [],
  skills: [],
  layers: [],
  effective: '',
  hash: 'h'.repeat(40),
  totalBytes: 0,
}

function repoTeam(upstreamName: string): RepoTeam {
  return {
    chief: 'sess-chief',
    lead: 'sess-lead',
    product: 'sess-product',
    test: 'sess-test',
    security: '',
    reviewer: 'sess-reviewer',
    dev1: 'sess-dev1',
    dev2: 'sess-dev2',
    reviewerScope: 'self',
    team: teamLabelFor(upstreamName),
    playbook: 8,
    playbookHash: 'x',
  }
}

function fakeInstances(upstreamName: string): InstanceManager {
  const team = repoTeam(upstreamName)
  return {
    ensurePlaybook: async () => 'unchanged',
    refreshTeam: async () => true,
    bridgeFor: () => ({ url: 'http://127.0.0.1:1', token: 'bridge-token', team }),
    applyBotModels: async () => ({ updated: 0, skipped: [] }),
  } as unknown as InstanceManager
}

function harness(goal: string, upstreamName: string) {
  const config = {
    ...testConfig(),
    flybot: { ...testConfig().flybot, instanceImage: 'fledge/test' },
    runner: { ...testConfig().runner, queueDispatch: false },
  }
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `seal-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 10)}`,
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    canReview: true,
    reviewerEnabled: true,
    canCreateIssue: true,
    goal,
    autoIterate: false,
    intervalMinutes: 1440,
    upstreamOwner: 'acme',
    upstreamName,
    upstreamDefaultBranch: 'main',
  })
  const jobs = new Jobs(store, config, { name: 'flybot', async run() { return { status: 'running' } } }, new MemoryMailer(), fakeInstances(upstreamName))
  // The rules read is the only network step; the seal is what this case is about.
  ;(jobs as unknown as { loadRules: () => Promise<{ ok: true; rules: RepoRules }> }).loadRules = async () => ({ ok: true, rules: RULES })
  return { store, jobs, repo, user }
}

function sealedPlaybook(store: Store, jobId: string): { hash: string } {
  const job = store.getJob(jobId)!
  const bundle = JSON.parse(job.context_bundle_json ?? 'null') as { contract: { playbook: { version: string | null; hash: string }; role: string | null } } | null
  assert.ok(bundle !== null, 'the dispatch sealed no bundle')
  assert.equal(bundle.contract.playbook.version, null, 'the version is chosen by the instance, so it stays null')
  assert.equal(bundle.contract.role, 'reviewer', 'the review dispatch has to record the reviewer role')
  return bundle.contract.playbook
}

test('a review job seals the playbook text the reviewer was told, not the review prompt', async () => {
  const goal = 'Make the counter wrap at 255 instead of overflowing silently.'
  const h = harness(goal, 'acme-demo')
  try {
    const result = await h.jobs.enqueue(h.repo, 'manual', undefined, 'review', {})
    assert.equal(result.ok, true, result.error ?? 'enqueue failed')
    const job = h.store.getJob(result.job!.id)!
    assert.equal(job.goal, DEFAULT_REVIEW_GOAL, 'the review job did not receive the review prompt')

    const label = teamLabelFor(h.repo.upstream_name)
    const applied = playbookTextHash(playbookFor('reviewer', label, h.repo.goal))
    const prompt = playbookTextHash(playbookFor('reviewer', label, job.goal))
    assert.notEqual(applied, prompt, 'the two texts differ, so one of them is the wrong record')

    const sealed = sealedPlaybook(h.store, job.id)
    assert.equal(sealed.hash, applied, 'the contract did not record the text the reviewer was told')
    assert.notEqual(sealed.hash, prompt, 'the contract recorded the job prompt as the playbook text')
  } finally {
    h.store.close()
  }
})

test('a follow-up that carries state still seals the repository goal text, not the tailed prompt', async () => {
  const goal = 'Keep the import pipeline under ten seconds for a thousand files.'
  const h = harness(goal, 'acme-demo')
  try {
    const previous = h.store.createJob({
      id: 'job_seal_prev',
      repoId: h.repo.id,
      userId: h.user.id,
      trigger: 'manual',
      goal: 'earlier run',
      callbackHash: 'h',
      platformTokenHash: '',
      kind: 'iterate',
      baseBranch: 'main',
    })
    h.store.updateJob(previous.id, { status: 'succeeded', finished_at: '2026-11-19T00:05:00.000Z', summary: 'narrowed the parser to one allocation' })

    const result = await h.jobs.enqueue(h.repo, 'followup', undefined, 'review', {})
    assert.equal(result.ok, true, result.error ?? 'enqueue failed')
    const job = h.store.getJob(result.job!.id)!
    assert.ok(job.goal.includes(CARRY_OVER_MARKER), 'the follow-up goal carries no carry-over block')
    assert.notEqual(job.goal, h.repo.goal, 'the goal with a tail cannot equal the repository goal')

    const label = teamLabelFor(h.repo.upstream_name)
    const applied = playbookTextHash(playbookFor('reviewer', label, h.repo.goal))
    const tailed = playbookTextHash(playbookFor('reviewer', label, job.goal))
    assert.notEqual(applied, tailed)

    const sealed = sealedPlaybook(h.store, job.id)
    assert.equal(sealed.hash, applied, 'the carry-over tail moved the recorded playbook text')
    assert.notEqual(sealed.hash, tailed)
  } finally {
    h.store.close()
  }
})
