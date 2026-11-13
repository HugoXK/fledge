import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.js'
import {
  ARTIFACT_KINDS,
  FROZEN_PATHS,
  artifactKey,
  candidateRefusal,
  frozenPathsNamed,
} from '../src/lib/evolution/artifacts.js'
import { makeUser } from './helpers.js'

// #424 / ADR 0003. Six ledger lines, all against the store, because the ledger
// is a storage contract: the pure rules live in `src/lib/evolution/artifacts.ts`
// and are tested there through `candidateRefusal`, and every refusal below also
// asserts the row that must NOT exist, so a store that refuses and writes anyway
// cannot pass.

function storeWithRepos(): { store: Store; repoA: string; repoB: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'ledger-owner', admin: true, status: 'approved' })
  const repoA = store.createRepo({
    id: 'repo-ledger-a',
    userId: user.id,
    owner: 'octo',
    name: 'alpha',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: 'keep it small',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const repoB = store.createRepo({
    id: 'repo-ledger-b',
    userId: user.id,
    owner: 'octo',
    name: 'beta',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: 'keep it small',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, repoA: repoA.id, repoB: repoB.id }
}

function candidate(store: Store, input: { id: string; repoId: string; baseVersion: number; paths?: string[]; kind?: string }) {
  return store.createArtifactCandidate({
    id: input.id,
    kind: input.kind ?? 'repo-goal',
    scope: 'repository',
    repoId: input.repoId,
    content: `goal for ${input.repoId} at ${String(input.baseVersion)}`,
    hash: `hash-${input.id}`,
    baseVersion: input.baseVersion,
    paths: input.paths ?? ['repos.goal'],
  })
}

test('a candidate built on a stale base is refused by compare-and-swap', () => {
  const { store, repoA } = storeWithRepos()
  const first = candidate(store, { id: 'cand-1', repoId: repoA, baseVersion: 0 })
  assert.equal(first.ok, true)
  const stale = candidate(store, { id: 'cand-stale', repoId: repoA, baseVersion: 0 })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok ? '' : stale.refusal.code, 'STALE_BASE')
  // The refusal is not a message: the row must not exist either.
  assert.equal(store.listArtifactVersions(artifactKey({ kind: 'repo-goal', scope: 'repository', repoId: repoA }), 10).length, 1)
  // And it is on the record: a refusal a user cannot see is not a control.
  assert.ok(store.listAudit(10).some((row) => row.action === 'evolution.candidate.refused' && (row.detail ?? '').includes('STALE_BASE')))
})

test('an accepted candidate records its parent and moves the dev pointer', () => {
  const { store, repoA } = storeWithRepos()
  const key = artifactKey({ kind: 'repo-goal', scope: 'repository', repoId: repoA })
  const first = candidate(store, { id: 'cand-a1', repoId: repoA, baseVersion: 0 })
  assert.equal(first.ok, true)
  if (!first.ok) return
  const acceptedFirst = store.acceptArtifactCandidate({ id: first.row.id, repoId: repoA })
  assert.equal(acceptedFirst.ok, true)
  assert.equal(store.artifactPointer(key, 'dev')?.id, first.row.id)

  const second = candidate(store, { id: 'cand-a2', repoId: repoA, baseVersion: 1 })
  assert.equal(second.ok, true)
  if (!second.ok) return
  assert.equal(second.row.version, 2)
  assert.equal(second.row.parent_id, first.row.id, 'the lineage edge is the version the candidate declared')
  assert.equal(second.row.base_version, 1)
  const acceptedSecond = store.acceptArtifactCandidate({ id: second.row.id, repoId: repoA })
  assert.equal(acceptedSecond.ok, true)
  assert.equal(store.artifactPointer(key, 'dev')?.id, second.row.id)
  assert.deepEqual(store.artifactLineage(second.row.id).map((row) => row.id), [second.row.id, first.row.id])
})

test('a candidate naming a frozen path is refused before evaluation and audited', () => {
  const { store, repoA } = storeWithRepos()
  const frozenList = [
    'src/lib/evolution/evaluate.ts',
    'src/jobs/service.ts',
    'src/lib/stages.ts',
    '.github/workflows/ci.yml',
    'src/auth/session.ts',
  ]
  for (const frozen of frozenList) {
    const refused = candidate(store, { id: `cand-${frozen}`, repoId: repoA, baseVersion: 0, paths: ['repos.goal', frozen] })
    assert.equal(refused.ok, false, `${frozen} must be refused`)
    assert.equal(refused.ok ? '' : refused.refusal.code, 'FROZEN_PATH')
    assert.match(refused.ok ? '' : refused.refusal.detail, new RegExp(frozen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  // Nothing was stored, so nothing can be evaluated later.
  assert.equal(store.listArtifactVersions(artifactKey({ kind: 'repo-goal', scope: 'repository', repoId: repoA }), 10).length, 0)
  const refusals = store.listAudit(40).filter((row) => row.action === 'evolution.candidate.refused')
  assert.equal(refusals.length, frozenList.length)
  assert.ok(refusals.every((row) => (row.detail ?? '').includes('FROZEN_PATH')))
  // The rule is data: every frozen entry is a path the ADR names, and the
  // evaluator itself is frozen so a candidate cannot edit its own judge.
  assert.ok(FROZEN_PATHS.includes('src/lib/evolution/'))
  // The ADR's table names the stage gate frozen beside the merge gate; the code
  // has to name the same file or the record contradicts the guard (#494 #1).
  assert.ok(FROZEN_PATHS.includes('src/lib/stages.ts'))
  assert.deepEqual(frozenPathsNamed(['public/app.css', 'src/gateway/route.ts']), ['src/gateway/route.ts'])
  assert.ok(ARTIFACT_KINDS.every((spec) => spec.risk === 'low' || spec.risk === 'medium' || spec.risk === 'high'))
})

test('a frozen path is refused whatever spelling it is written in', () => {
  const { store } = storeWithRepos()
  // Candidate paths are generated input, so an equivalent spelling that walks
  // around the set would make it a convention rather than a guard (#494 #2).
  const spellings = ['./src/auth/session.ts', 'src/jobs/../auth/session.ts', '/src/gateway/route.ts', 'src\\auth\\session.ts']
  for (const spelling of spellings) {
    assert.deepEqual(frozenPathsNamed([spelling]), [spelling], `${spelling} must be recognised as frozen`)
    const refused = store.createArtifactCandidate({
      id: `cand-spelling-${spelling}`,
      kind: 'playbook',
      scope: 'global',
      content: 'candidate text',
      hash: `hash-${spelling}`,
      baseVersion: 0,
      paths: ['playbook', spelling],
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.ok ? '' : refused.refusal.code, 'FROZEN_PATH')
  }
  // Normalisation is not an over-match: an ordinary path stays admissible.
  assert.deepEqual(frozenPathsNamed(['playbook', 'src/lib/stages.ts.bak', 'src/authz/session.ts']), [])
})

test('a rollback moves the pointer back and leaves both versions readable', () => {
  const { store, repoA } = storeWithRepos()
  const key = artifactKey({ kind: 'repo-goal', scope: 'repository', repoId: repoA })
  const first = candidate(store, { id: 'cand-b1', repoId: repoA, baseVersion: 0 })
  assert.equal(first.ok, true)
  if (!first.ok) return
  store.acceptArtifactCandidate({ id: first.row.id, repoId: repoA })
  const second = candidate(store, { id: 'cand-b2', repoId: repoA, baseVersion: 1 })
  assert.equal(second.ok, true)
  if (!second.ok) return
  store.acceptArtifactCandidate({ id: second.row.id, repoId: repoA })

  const rolled = store.rollbackArtifact({ artifact: key, toVersionId: first.row.id })
  assert.equal(rolled.ok, true)
  assert.equal(store.artifactPointer(key, 'dev')?.id, first.row.id)
  // Both stay readable: a rollback is a pointer move, not a delete.
  const rows = store.listArtifactVersions(key, 10)
  assert.deepEqual(rows.map((row) => row.id).sort(), [first.row.id, second.row.id].sort())
  assert.ok(rows.some((row) => row.content.includes('at 0')))
  assert.ok(rows.some((row) => row.content.includes('at 1')))
})

test('a repository cannot accept another repository’s artifact', () => {
  const { store, repoA, repoB } = storeWithRepos()
  const mine = candidate(store, { id: 'cand-scope-a', repoId: repoA, baseVersion: 0 })
  assert.equal(mine.ok, true)
  if (!mine.ok) return
  const stolen = store.acceptArtifactCandidate({ id: mine.row.id, repoId: repoB })
  assert.equal(stolen.ok, false)
  assert.equal(stolen.ok ? '' : stolen.refusal.code, 'SCOPE_MISMATCH')
  assert.equal(store.artifactPointer(artifactKey({ kind: 'repo-goal', scope: 'repository', repoId: repoA }), 'dev'), null)
  // The same kind in the other repository is a different lineage with its own
  // version numbering, so neither can see the other's dev pointer.
  const theirs = candidate(store, { id: 'cand-scope-b', repoId: repoB, baseVersion: 0 })
  assert.equal(theirs.ok, true)
  if (!theirs.ok) return
  assert.equal(theirs.row.version, 1)
  assert.notEqual(theirs.row.artifact, mine.row.artifact)
  const global = store.createArtifactCandidate({
    id: 'cand-global',
    kind: 'playbook',
    scope: 'global',
    content: 'playbook text',
    hash: 'hash-global',
    baseVersion: 0,
    paths: ['playbook'],
  })
  assert.equal(global.ok, true)
  if (!global.ok) return
  const wrongScope = store.acceptArtifactCandidate({ id: global.row.id, repoId: repoA })
  assert.equal(wrongScope.ok, false)
  assert.equal(wrongScope.ok ? '' : wrongScope.refusal.code, 'SCOPE_MISMATCH')
})

test('the migration keeps an existing artifact version’s content, hash and status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-ledger-'))
  const path = join(dir, 'ledger.db')
  try {
    const before = new Store(path)
    before.createArtifactVersion({
      id: 'legacy-1',
      artifact: 'playbook',
      version: 1,
      hash: 'legacy-hash',
      content: 'the playbook as it was',
      status: 'promoted',
      evidenceJson: '{"dataset":"holdout"}',
    })
    // A second promoted artifact: the backfill is per artifact, not one row for
    // the whole table, so both get a `stable` pointer on the same boot (#494 #3).
    before.createArtifactVersion({
      id: 'legacy-2',
      artifact: 'default-goal',
      version: 1,
      hash: 'legacy-hash-2',
      content: 'the default goal as it was',
      status: 'promoted',
      evidenceJson: '{"dataset":"holdout"}',
    })
    // An older promoted row must not win over the newer one for the same
    // artifact: the pointer is what the latest promotion left behind.
    before.createArtifactVersion({
      id: 'legacy-3',
      artifact: 'playbook',
      version: 2,
      hash: 'legacy-hash-3',
      content: 'the playbook, second promotion',
      status: 'promoted',
      evidenceJson: '{"dataset":"holdout"}',
    })
    before.close()

    const after = new Store(path)
    const rows = after.listArtifactVersions('playbook', 10)
    assert.equal(rows.length, 2)
    const row = rows.find((entry) => entry.id === 'legacy-1')
    assert.ok(row !== undefined)
    assert.equal(row.hash, 'legacy-hash')
    assert.equal(row.content, 'the playbook as it was')
    assert.equal(row.status, 'promoted')
    // A row written before the evolvable set existed is not silently claimed to
    // be one of its kinds, and it is not claimed to be a candidate either.
    assert.equal(row.kind, 'unspecified')
    assert.equal(row.scope, 'global')
    assert.equal(row.frozen, 0)
    // A promoted legacy row becomes the stable pointer, so "what is stable now"
    // has one answer after the migration — one answer per artifact.
    assert.equal(after.artifactPointer('playbook', 'stable')?.id, 'legacy-3')
    assert.equal(after.artifactPointer('default-goal', 'stable')?.id, 'legacy-2')
    after.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a repository-scoped candidate without a repository is refused, not thrown', () => {
  const { store } = storeWithRepos()
  // `artifactKey()` cannot name a repository-scoped artifact without a
  // repository, and a refusal is a value here rather than an exception
  // (#494 finding 4), so the scope check has to run before the key is built.
  const refused = store.createArtifactCandidate({
    id: 'cand-no-repo',
    kind: 'repo-goal',
    scope: 'repository',
    content: 'goal',
    hash: 'hash-no-repo',
    baseVersion: 0,
    paths: ['repos.goal'],
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.ok ? '' : refused.refusal.code, 'SCOPE_MISMATCH')
  assert.equal(store.listArtifactVersions('repo-goal', 10).length, 0)
  assert.ok(
    store.listAudit(20).some(
      (row) => row.action === 'evolution.candidate.refused' && (row.detail ?? '').includes('SCOPE_MISMATCH'),
    ),
  )
})

test('the pure contract refuses an unknown kind before it looks at anything else', () => {
  const refusal = candidateRefusal({
    kind: 'merge-gate',
    scope: 'global',
    paths: ['src/lib/evolution/evaluate.ts'],
    baseVersion: 0,
    headVersion: 0,
  })
  assert.equal(refusal?.code, 'INELIGIBLE_KIND')
  const frozen = candidateRefusal({
    kind: 'playbook',
    scope: 'global',
    paths: ['src/lib/evolution/evaluate.ts'],
    baseVersion: 3,
    headVersion: 4,
  })
  assert.equal(frozen?.code, 'FROZEN_PATH', 'a frozen path is reported before a stale base')
  assert.equal(candidateRefusal({ kind: 'playbook', scope: 'global', paths: ['playbook'], baseVersion: 4, headVersion: 4 }), null)
})
