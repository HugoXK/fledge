import test from 'node:test'
import assert from 'node:assert/strict'
import { assertExportable, buildDataset, checkHoldoutLeak, REQUIRED_JOB_COLUMNS, type EvolutionRow } from '../src/lib/evolution/dataset.js'
import { makeUser } from './helpers.js'

function row(input: Partial<EvolutionRow> & { jobId: string; repo: string; finishedAt: string }): EvolutionRow {
  return {
    repoGoal: '',
    kind: 'iterate',
    status: 'succeeded',
    trigger: 'manual',
    goal: 'tighten the parser',
    baseSha: null,
    branch: null,
    prUrl: null,
    issueUrl: null,
    reviewScore: null,
    evidence: null,
    attribution: null,
    attributionGround: null,
    teamStats: null,
    checkpoint: null,
    costUsd: 0,
    createdAt: input.finishedAt,
    startedAt: input.finishedAt,
    stageMode: null,
    repoRole: 'maintainer',
    autoMerge: false,
    ...input,
  }
}

const NOW = new Date('2026-11-15T00:00:00.000Z')
const OPTIONS = { days: 90, now: NOW }

function spread(): EvolutionRow[] {
  const rows: EvolutionRow[] = []
  for (let index = 0; index < 5; index += 1) {
    rows.push(row({ jobId: `a_${index}`, repo: 'a/r', finishedAt: `2026-09-0${index + 1}T00:00:00.000Z` }))
  }
  for (let index = 0; index < 5; index += 1) {
    rows.push(row({ jobId: `b_${index}`, repo: 'b/r', finishedAt: `2026-11-0${index + 1}T00:00:00.000Z` }))
  }
  return rows
}

test('every exported string passes through the one recogniser and the row is kept', () => {
  const dataset = buildDataset([
    row({
      jobId: 'job_secret',
      repo: 'a/r',
      finishedAt: '2026-11-01T00:00:00.000Z',
      goal: `use ${'ghp_'}${'a'.repeat(36)} to read the repo`,
      evidence: { summary: `the callback answered with ${'flg_'}${'a'.repeat(22)}` },
    }),
  ], OPTIONS)
  const text = JSON.stringify(dataset)
  assert.equal(/ghp_[A-Za-z0-9]{20,}|flg_[A-Za-z0-9_-]{16,}/.test(text), false, 'a secret survived the export')
  assert.equal(dataset.records.length, 1, 'the row must be redacted, not dropped')
  assert.match(text, /\[redacted-github-token\]/)
  assert.match(text, /\[redacted-fledge-token\]/)
})

test('a record carries the observed ground beside the claim, and the schema version moves to 2', () => {
  const ground = { steps: [{ key: 'writtenBy' as const, claimed: 'Dev-2', observed: 'Dev-1', state: 'unobserved' as const }] }
  const dataset = buildDataset([
    row({
      jobId: 'job_observed',
      repo: 'a/r',
      finishedAt: '2026-11-01T00:00:00.000Z',
      attribution: { writtenBy: 'Dev-2' },
      attributionGround: ground,
    }),
    row({ jobId: 'job_unrecorded', repo: 'a/r', finishedAt: '2026-11-02T00:00:00.000Z', attribution: { writtenBy: 'Dev-2' } }),
  ], OPTIONS)
  const observed = dataset.records.find((record) => record.jobId === 'job_observed')
  const unrecorded = dataset.records.find((record) => record.jobId === 'job_unrecorded')
  assert.deepEqual(observed?.attribution, { writtenBy: 'Dev-2' }, 'the claim stays the stored object as-is')
  assert.deepEqual(observed?.attributionGround, ground, 'the record carries the per-key ground beside the claim')
  assert.equal(unrecorded?.attributionGround, null, 'no recorded ground is null, never a fabricated grounded')
  assert.equal(dataset.manifest.schemaVersion, 2, 'a record-shape change moves the dataset schema version')
})

test('the same rows give the same id and hash, in any input order', () => {
  const rows = spread()
  const first = buildDataset(rows, OPTIONS)
  const second = buildDataset([...rows].reverse(), OPTIONS)
  assert.equal(first.manifest.contentHash, second.manifest.contentHash)
  assert.equal(first.manifest.id, second.manifest.id)
  assert.equal(first.manifest.contentHash.length, 64)
  assert.equal(first.manifest.id, `ds_${first.manifest.contentHash.slice(0, 16)}`)
})

test('without an explicit now the window ends at the newest row, so two exports match', () => {
  // The CLI does not pass `now`; if the default were the wall clock, two exports
  // of the same rows would carry different hashes and no reader could check that
  // they describe the same dataset.
  const rows = spread()
  const first = buildDataset(rows, { days: 90 })
  const second = buildDataset([...rows].reverse(), { days: 90 })
  assert.equal(first.manifest.window.to, '2026-11-05T00:00:00.000Z')
  assert.equal(first.manifest.window.from, '2026-08-07T00:00:00.000Z')
  assert.equal(first.manifest.contentHash, second.manifest.contentHash)
  assert.equal(first.manifest.id, second.manifest.id)
})

test('a changed row and a changed window both change the hash', () => {
  const rows = spread()
  const base = buildDataset(rows, OPTIONS)
  const changedRow = buildDataset(rows.map((item) => item.jobId === 'a_0' ? { ...item, goal: 'something else entirely' } : item), OPTIONS)
  assert.notEqual(base.manifest.contentHash, changedRow.manifest.contentHash)
  const changedWindow = buildDataset(rows, { days: 30, now: NOW })
  assert.notEqual(base.manifest.contentHash, changedWindow.manifest.contentHash)
})

test('the split is repository-disjoint and takes the newest 20%', () => {
  // Two repositories: the newest tail names b/r, so every b/r row moves to the
  // holdout even though the tail itself is two rows. That is the rule — no
  // repository is on both sides — and it is why this fixture holds out five.
  const dataset = buildDataset(spread(), OPTIONS)
  const { train, holdout } = dataset.manifest.split
  assert.equal(holdout.length, 5)
  assert.equal(train.length, 5)
  const trainRepos = new Set(dataset.records.filter((item) => train.includes(item.jobId)).map((item) => item.repo))
  const holdoutRepos = new Set(dataset.records.filter((item) => holdout.includes(item.jobId)).map((item) => item.repo))
  for (const repo of holdoutRepos) assert.equal(trainRepos.has(repo), false, `${repo} is on both sides of the split`)
  assert.deepEqual([...holdoutRepos], ['b/r'], 'the newest tail belongs to the later repository')
  assert.equal(dataset.manifest.holdoutProtected.length, holdout.length, 'every holdout row has one protected entry')

  // Ten rows in ten repositories: the tail is exactly the newest two, and no
  // repository expands it.
  const oneEach = Array.from({ length: 10 }, (_, index) => row({
    jobId: `j_${index}`,
    repo: `o/r${index}`,
    finishedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
  }))
  const single = buildDataset(oneEach, OPTIONS)
  assert.equal(single.manifest.split.holdout.length, 2)
  assert.equal(single.manifest.split.train.length, 8)
})

test('a prompt that repeats a holdout entry is refused, and the entry is named', () => {
  const dataset = buildDataset([
    row({ jobId: 'abc123', repo: 'a/r', finishedAt: '2026-11-01T00:00:00.000Z', prUrl: 'https://github.com/a/r/pull/42' }),
  ], OPTIONS)
  const refused = checkHoldoutLeak('apply the change from a/r#42 as the holdout did', dataset.manifest)
  assert.equal(refused.ok, false)
  assert.equal(refused.ok === false ? refused.code : '', 'HOLDOUT_LEAK')
  assert.equal(refused.ok === false ? refused.protected : '', 'a/r#42')
  const clean = checkHoldoutLeak('apply the change from a/r#43 as the holdout did', dataset.manifest)
  assert.equal(clean.ok, true)
  const caseAndSpace = checkHoldoutLeak('Apply  the change from  A/R#42  as the holdout did', dataset.manifest)
  assert.equal(caseAndSpace.ok, false, 'the match is case-insensitive and whitespace-collapsed')
})

test('the frozen schema refusal is gone: the guard reads the columns it needs', () => {
  assert.doesNotThrow(() => assertExportable(['kind', 'evidence_json', 'team_stats_json', 'attribution_ground_json', 'goal'], 38))
  assert.throws(() => assertExportable(['kind', 'team_stats_json'], 38), /evidence_json/)
  assert.throws(() => assertExportable(['kind', 'evidence_json'], 38), /team_stats_json/)
  // A database written before #1186 has no ground column, so the export refuses
  // it by name instead of writing records that cannot carry the observation.
  assert.throws(
    () => assertExportable(['kind', 'evidence_json', 'team_stats_json'], 38),
    /attribution_ground_json/,
  )
  assert.equal(REQUIRED_JOB_COLUMNS.length, 4)
})

// The consent gate, end to end: a real Store at a temp path, the exporter's own
// row loader, and one consented plus one unconsented repository. The unconsented
// one must be absent from every side of the split and from the manifest.
test('an unconsented repository is absent from the dataset, and a consented one is present', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { Store } = await import('../src/db.js')
  const { loadEvolutionRows } = await import('../src/lib/evolution/export.js')
  const dir = mkdtempSync(join(tmpdir(), 'fledge-evolution-'))
  const path = join(dir, 'fledge.db')
  const store = new Store(path)
  try {
    const user = makeUser(store, { login: 'evo', admin: true, superadmin: true, status: 'approved' })
    const consented = store.createRepo({ id: 'repo_on', userId: user.id, owner: 'o', name: 'on', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const quiet = store.createRepo({ id: 'repo_off', userId: user.id, owner: 'o', name: 'off', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const createdAt = new Date().toISOString()
    store.createJob({ id: 'job_on', repoId: consented.id, userId: user.id, trigger: 'manual', goal: 'on goal', callbackHash: 'h1', platformTokenHash: 'p1', createdAt })
    store.createJob({ id: 'job_off', repoId: quiet.id, userId: user.id, trigger: 'manual', goal: 'off goal', callbackHash: 'h2', platformTokenHash: 'p2', createdAt })
    store.setRepoEvolutionConsent(consented.id, true, user.id)
    assert.equal(store.listEvolutionConsent().find((row) => row.repoId === consented.id)?.consent, true)
    assert.equal(store.listEvolutionConsent().find((row) => row.repoId === quiet.id)?.consent, false)
    assert.equal(store.listAudit(20).some((row) => row.action === 'evolution.consent'), true, 'the consent change must be audited')

    const reader = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = loadEvolutionRows(reader, { since: new Date(Date.now() - 86_400_000).toISOString(), limit: 100 })
      assert.deepEqual(rows.map((row) => row.jobId), ['job_on'])
      const dataset = buildDataset(rows, { days: 1, now: new Date() })
      assert.deepEqual(dataset.manifest.repositories, ['o/on'])
      // One row is one row: the split's minimum holdout is a single row, so the
      // consented row is held out and the unconsented one appears nowhere.
      assert.deepEqual([...dataset.manifest.split.train, ...dataset.manifest.split.holdout], ['job_on'])
      assert.deepEqual(dataset.manifest.holdoutProtected, ['o/on#job_on'])
      assert.equal(dataset.manifest.split.train.length + dataset.manifest.split.holdout.length, dataset.manifest.rowCount)
    } finally {
      reader.close()
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the loader reads the stored ground and reconstructs a legacy row, never guessing grounded', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { Store } = await import('../src/db.js')
  const { loadEvolutionRows } = await import('../src/lib/evolution/export.js')
  const dir = mkdtempSync(join(tmpdir(), 'fledge-evolution-ground-'))
  const path = join(dir, 'fledge.db')
  const store = new Store(path)
  try {
    const user = makeUser(store, { login: 'evo', admin: true, superadmin: true, status: 'approved' })
    // One active job per repository, so the two rows live in two repositories.
    const storedRepo = store.createRepo({ id: 'repo_stored', userId: user.id, owner: 'o', name: 'stored', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const legacyRepo = store.createRepo({ id: 'repo_legacy', userId: user.id, owner: 'o', name: 'legacy', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const createdAt = new Date().toISOString()
    store.createJob({ id: 'job_stored', repoId: storedRepo.id, userId: user.id, trigger: 'manual', goal: 'stored', callbackHash: 'h1', platformTokenHash: 'p1', createdAt })
    store.updateJob('job_stored', {
      attribution_json: JSON.stringify({ writtenBy: 'Dev-2' }),
      attribution_ground_json: JSON.stringify({ steps: [{ key: 'writtenBy', claimed: 'Dev-2', observed: 'Dev-1', state: 'unobserved' }] }),
    })
    store.createJob({ id: 'job_legacy', repoId: legacyRepo.id, userId: user.id, trigger: 'manual', goal: 'legacy', callbackHash: 'h2', platformTokenHash: 'p2', createdAt })
    store.updateJob('job_legacy', {
      attribution_json: JSON.stringify({ writtenBy: 'Dev-1' }),
      team_stats_json: JSON.stringify([{ role: 'dev1', calls: 2 }]),
    })
    store.setRepoEvolutionConsent(storedRepo.id, true, user.id)
    store.setRepoEvolutionConsent(legacyRepo.id, true, user.id)

    const reader = new DatabaseSync(path, { readOnly: true })
    try {
      const rows = loadEvolutionRows(reader, { since: new Date(Date.now() - 86_400_000).toISOString(), limit: 100 })
      const stored = rows.find((item) => item.jobId === 'job_stored')
      const legacy = rows.find((item) => item.jobId === 'job_legacy')
      assert.deepEqual(
        stored?.attributionGround,
        { steps: [{ key: 'writtenBy', claimed: 'Dev-2', observed: 'Dev-1', state: 'unobserved' }] },
        'a stored ground record travels into the export as recorded',
      )
      // Before #1186 the observation was written over attribution_json, so a row
      // that carries team stats holds the observed half there: grounded, and no
      // claim to print beside it.
      assert.deepEqual(
        legacy?.attributionGround,
        { steps: [{ key: 'writtenBy', claimed: null, observed: 'Dev-1', state: 'grounded' }] },
        'a pre-#1186 row is reconstructed by the same rule the page uses',
      )
      const dataset = buildDataset(rows, { days: 1, now: new Date() })
      assert.ok(dataset.records.every((record) => 'attributionGround' in record), 'every record carries the field, even when it is null')
    } finally {
      reader.close()
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the manifest records the effective split sizes so nobody counts arrays', () => {
  const dataset = buildDataset(spread(), OPTIONS)
  assert.equal(dataset.manifest.trainRows, 5)
  assert.equal(dataset.manifest.holdoutRows, 5)
  assert.equal(dataset.manifest.trainRows + dataset.manifest.holdoutRows, dataset.manifest.rowCount)
})

test('a split that holds out every row is refused by name', () => {
  const solo = Array.from({ length: 3 }, (_, index) => row({
    jobId: `s_${index}`,
    repo: 'solo/r',
    finishedAt: `2026-11-0${index + 1}T00:00:00.000Z`,
  }))
  const dataset = buildDataset(solo, OPTIONS)
  assert.equal(dataset.manifest.trainRows, 0)
  assert.throws(
    () => assertExportable(['kind', 'evidence_json', 'team_stats_json', 'attribution_ground_json'], 38, dataset.manifest.trainRows),
    /NO_TRAINING_ROWS/,
  )
  assert.doesNotThrow(() => assertExportable(['kind', 'evidence_json', 'team_stats_json', 'attribution_ground_json'], 38, 1))
})

test('the manifest records the selection and the exported coverage', () => {
  const bounded = buildDataset(spread(), { days: 90, limit: 500 })
  assert.deepEqual(bounded.manifest.selection, { days: 90, limit: 500 })
  assert.equal(bounded.manifest.window.oldestRowAt, '2026-09-01T00:00:00.000Z')
  assert.equal(bounded.manifest.window.newestRowAt, '2026-11-05T00:00:00.000Z')
  const unbounded = buildDataset(spread(), OPTIONS)
  assert.deepEqual(unbounded.manifest.selection, { days: 90, limit: null })
  assert.equal(unbounded.manifest.window.oldestRowAt, '2026-09-01T00:00:00.000Z')
})

test('the hash covers the rows and the selection, not the wall-clock window', () => {
  const rows = spread()
  const early = buildDataset(rows, { days: 90, limit: 500, now: new Date('2026-11-15T00:00:00.000Z') })
  const late = buildDataset(rows, { days: 90, limit: 500, now: new Date('2026-12-01T00:00:00.000Z') })
  assert.notEqual(early.manifest.window.to, late.manifest.window.to)
  assert.equal(early.manifest.contentHash, late.manifest.contentHash)
  assert.equal(early.manifest.id, late.manifest.id)
  const wider = buildDataset(rows, { days: 90, limit: 1000 })
  assert.notEqual(early.manifest.contentHash, wider.manifest.contentHash, 'the applied limit is part of the identity')
})

test('a holdout entry with a space before the number is still refused', () => {
  const dataset = buildDataset([
    row({ jobId: 'abc123', repo: 'a/r', finishedAt: '2026-11-01T00:00:00.000Z', prUrl: 'https://github.com/a/r/pull/42' }),
  ], OPTIONS)
  const refused = checkHoldoutLeak('use A/R #42 as the holdout did', dataset.manifest)
  assert.equal(refused.ok, false, 'a space before # must not slip past the only guard')
  assert.equal(refused.ok === false ? refused.protected : '', 'a/r#42')
})
