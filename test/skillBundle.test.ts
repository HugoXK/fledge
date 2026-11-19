import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { encryptSecret } from '../src/lib/secrets.js'
import {
  PLAYBOOK_BUNDLE_SOURCE,
  assembleSkillBundles,
  attestSkillBundle,
  bundleContentHash,
  parseSkillBundleRecord,
  signSkillBundle,
  skillBundleMergeBlock,
  skillBundleRecord,
  type SkillBundleManifest,
  type SkillBundleSourceRow,
  type UnsignedSkillBundle,
} from '../src/lib/skillBundle.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// #380: a loaded skill is executable influence. The bundle manifest binds the
// content to a source and a role, the allowlist decides whether that source may
// influence a job, and revocation is a row update that the next job start sees.

const KEY = testConfig().tokenEncryptionKey
const REPO_SOURCE = 'repo:o/r'

function allowed(source: string): SkillBundleSourceRow {
  return { source, state: 'allowed', updatedBy: 'owner', updatedAt: '2026-11-19T00:00:00.000Z' }
}

function manifestOf(content: string, overrides: Partial<UnsignedSkillBundle> = {}): SkillBundleManifest {
  const unsigned: UnsignedSkillBundle = {
    name: 'skill:triage',
    version: 1,
    source: REPO_SOURCE,
    contentHash: bundleContentHash(content),
    allowedRoles: ['chief', 'lead', 'reviewer'],
    ...overrides,
  }
  return signSkillBundle(unsigned, KEY)
}

test('a valid bundle from an allowed source is accepted and names its exact content hash', () => {
  const content = 'Read the failing test, then change one file.'
  const manifest = manifestOf(content)
  const decision = attestSkillBundle({ manifest, content, instanceKey: KEY, sources: [allowed(REPO_SOURCE)], role: 'lead' })
  assert.equal(decision.state, 'accepted')
  assert.equal(decision.contentHash, bundleContentHash(content))
  assert.equal(decision.source, REPO_SOURCE)
})

test('a bundle whose content no longer matches the signed hash is refused', () => {
  const manifest = manifestOf('the approved text')
  const decision = attestSkillBundle({ manifest, content: 'the approved text plus one command', instanceKey: KEY, sources: [allowed(REPO_SOURCE)], role: 'lead' })
  assert.equal(decision.state, 'refused')
  assert.match(decision.reason, /hash/i)
})

test('a bundle whose signature was edited is refused', () => {
  const content = 'the approved text'
  const manifest = manifestOf(content)
  const tampered: SkillBundleManifest = { ...manifest, signature: `${manifest.signature.slice(0, -1)}x` }
  const decision = attestSkillBundle({ manifest: tampered, content, instanceKey: KEY, sources: [allowed(REPO_SOURCE)], role: 'lead' })
  assert.equal(decision.state, 'refused')
  assert.match(decision.reason, /signature/i)
})

test('a revoked source is refused', () => {
  const content = 'the approved text'
  const revoked: SkillBundleSourceRow = { ...allowed(REPO_SOURCE), state: 'revoked' }
  const decision = attestSkillBundle({ manifest: manifestOf(content), content, instanceKey: KEY, sources: [revoked], role: 'lead' })
  assert.equal(decision.state, 'revoked')
  assert.match(decision.reason, /revoked/i)
})

test('an unknown source is held, not silently loaded', () => {
  const content = 'the approved text'
  const decision = attestSkillBundle({ manifest: manifestOf(content), content, instanceKey: KEY, sources: [], role: 'lead' })
  assert.equal(decision.state, 'held')
  assert.match(decision.reason, /allowlist/i)
})

test('a role the manifest does not allow is refused', () => {
  const content = 'the approved text'
  const manifest = manifestOf(content, { allowedRoles: ['reviewer'] })
  const decision = attestSkillBundle({ manifest, content, instanceKey: KEY, sources: [allowed(REPO_SOURCE)], role: 'lead' })
  assert.equal(decision.state, 'refused')
  assert.match(decision.reason, /role/i)
})

test('the assembled set has one canonical hash and a refused member refuses the set', () => {
  const content = 'the approved text'
  const manifest = manifestOf(content)
  const accepted = assembleSkillBundles({
    bundles: [{ manifest, content }],
    instanceKey: KEY,
    sources: [allowed(REPO_SOURCE)],
    role: 'lead',
  })
  assert.equal(accepted.state, 'accepted')
  assert.match(accepted.hash, /^[0-9a-f]{64}$/)

  const revoked = assembleSkillBundles({
    bundles: [{ manifest, content }],
    instanceKey: KEY,
    sources: [{ ...allowed(REPO_SOURCE), state: 'revoked' }],
    role: 'lead',
  })
  assert.equal(revoked.state, 'refused')
})

test('a job records the exact bundle hash and the record survives a round trip', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'bundle-record-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bundle_record', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const content = 'the approved text'
    const set = assembleSkillBundles({
      bundles: [{ manifest: manifestOf(content), content }],
      instanceKey: KEY,
      sources: [allowed(REPO_SOURCE)],
      role: 'lead',
    })
    const record = skillBundleRecord(set)
    const job = store.createJob({
      id: 'job_bundle_record',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: 'cb',
      platformTokenHash: '',
      skillBundle: { hash: set.hash, json: JSON.stringify(record), state: set.state },
    })
    assert.equal(job.skill_bundle_hash, set.hash)
    assert.equal(job.skill_state, 'accepted')
    assert.deepEqual(parseSkillBundleRecord(job.skill_bundle_json), record)
  } finally {
    store.close()
  }
})

test('a source allowed at load and revoked later blocks the merge gate', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'bundle-merge-gate-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bundle_gate', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const content = 'the approved text'
    const set = assembleSkillBundles({
      bundles: [{ manifest: manifestOf(content), content }],
      instanceKey: KEY,
      sources: [allowed(REPO_SOURCE)],
      role: 'lead',
    })
    const record = skillBundleRecord(set)
    const job = store.createJob({
      id: 'job_bundle_gate',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: 'cb',
      platformTokenHash: '',
      skillBundle: { hash: set.hash, json: JSON.stringify(record), state: set.state },
    })
    assert.equal(skillBundleMergeBlock(parseSkillBundleRecord(job.skill_bundle_json), store.listSkillBundleSources(repo.id)), null, 'an allowed source does not block')
    store.setSkillBundleSource({ repoId: repo.id, source: REPO_SOURCE, state: 'revoked', updatedBy: 'owner' })
    const block = skillBundleMergeBlock(parseSkillBundleRecord(job.skill_bundle_json), store.listSkillBundleSources(repo.id))
    assert.notEqual(block, null)
    assert.equal(block?.state, 'revoked')
    assert.equal(skillBundleMergeBlock(null, store.listSkillBundleSources(repo.id)), null, 'a job that recorded no bundle is not blocked')
    assert.equal(store.listSkillBundleSources(repo.id).find((row) => row.source === REPO_SOURCE)?.state, 'revoked')
  } finally {
    store.close()
  }
})

test('a job that loaded a bundle whose source is revoked later cannot auto-merge', async () => {
  const requests: string[] = []
  const github = await startFakeServer((request, response) => {
    const path = request.url ?? ''
    requests.push(`${request.method ?? ''} ${path}`)
    if (path.includes('/pulls/8/files')) return json(response, 200, [{ filename: 'src/x.ts', status: 'modified', additions: 1, deletions: 0 }])
    if (path.includes('/pulls/8/reviews')) return json(response, 200, [])
    if (path.includes('/commits/sha8/check-runs')) return json(response, 200, { check_runs: [{ name: 'test (24)', status: 'completed', conclusion: 'success' }, { name: 'lint', status: 'completed', conclusion: 'success' }] })
    if (path.includes('/commits/sha8/status')) return json(response, 200, { state: 'success', statuses: [] })
    if (path.includes('/branches/main/protection')) return json(response, 200, { required_status_checks: { contexts: ['lint'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
    if (path.includes('/pulls/8/merge')) return json(response, 200, { merged: true, sha: 'merge-sha' })
    if (path.includes('/pulls/8')) return json(response, 200, { number: 8, html_url: 'https://github.com/o/r/pull/8', title: 'fix', state: 'open', head: { ref: 'fledge/x', sha: 'sha8' }, base: { ref: 'main' }, mergeable: true, mergeable_state: 'clean', draft: false, merged: false })
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'bundle-auto-merge-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_bundle_auto_merge',
      userId: user.id,
      owner: 'o',
      name: 'r',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      roleCheckedAt: new Date().toISOString(),
      autoMerge: true,
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
      upstreamHtmlUrl: 'https://github.com',
    })
    const content = 'the approved text'
    const set = assembleSkillBundles({
      bundles: [{ manifest: manifestOf(content), content }],
      instanceKey: KEY,
      sources: [allowed(REPO_SOURCE)],
      role: 'lead',
    })
    const record = skillBundleRecord(set)
    const job = store.createJob({
      id: 'job_bundle_auto_merge',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: 'cb',
      platformTokenHash: '',
      kind: 'iterate',
      baseBranch: 'main',
      skillBundle: { hash: set.hash, json: JSON.stringify(record), state: set.state },
    })
    store.updateJob(job.id, { status: 'succeeded', branch: 'fledge/x', pr_url: 'https://github.com/o/r/pull/8' })
    store.setSkillBundleSource({ repoId: repo.id, source: REPO_SOURCE, state: 'revoked', updatedBy: 'owner' })

    await jobs.reconcileAutoMerge()

    assert.equal(requests.filter((line) => line.startsWith('PUT ') && line.includes('/merge')).length, 0, 'a revoked bundle must stop the automatic merge before the merge call')
    assert.equal(store.getJob(job.id)?.skill_state, 'skill-revoked', 'the job is marked with the state that blocked it')
  } finally {
    store.close()
    await github.close()
  }
})

test('the playbook is a bundle from the builtin source', () => {
  const content = 'v8:keep the change small'
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'bundle-playbook-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bundle_playbook', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const manifest = signSkillBundle({ name: 'fledge-playbook', version: 8, source: PLAYBOOK_BUNDLE_SOURCE, contentHash: bundleContentHash(content), allowedRoles: ['chief', 'lead'] }, KEY)
    const decision = attestSkillBundle({ manifest, content, instanceKey: KEY, sources: [allowed(PLAYBOOK_BUNDLE_SOURCE)], role: 'lead' })
    assert.equal(decision.state, 'accepted')
    assert.equal(repo.id, 'repo_bundle_playbook')
  } finally {
    store.close()
  }
})
