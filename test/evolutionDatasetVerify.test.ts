import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDataset, verifyDataset, type EvolutionRow } from '../src/lib/evolution/dataset.js'

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

const OPTIONS = { days: 90, now: new Date('2026-11-15T00:00:00.000Z') }

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

test('a written dataset verifies by recomputing the hash and the id', () => {
  const payload = JSON.parse(JSON.stringify(buildDataset(spread(), OPTIONS)))
  const verdict = verifyDataset(payload)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.ok === true ? verdict.manifest.id : '', payload.manifest.id)
})

test('a moved split id is refused as SPLIT_MISMATCH even before the hash is consulted', () => {
  const payload = JSON.parse(JSON.stringify(buildDataset(spread(), OPTIONS))) as ReturnType<typeof buildDataset>
  const moved = payload.manifest.split.holdout.pop()
  assert.ok(moved)
  payload.manifest.split.train.push(moved)
  const verdict = verifyDataset(payload)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.code : 'ok', 'SPLIT_MISMATCH')
})

test('an edited content hash is refused as CONTENT_HASH_MISMATCH', () => {
  const payload = JSON.parse(JSON.stringify(buildDataset(spread(), OPTIONS))) as ReturnType<typeof buildDataset>
  payload.manifest.contentHash = `${payload.manifest.contentHash[0] === 'a' ? 'b' : 'a'}${payload.manifest.contentHash.slice(1)}`
  const verdict = verifyDataset(payload)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.code : 'ok', 'CONTENT_HASH_MISMATCH')
})

test('an edited dataset id is refused as DATASET_ID_MISMATCH', () => {
  const payload = JSON.parse(JSON.stringify(buildDataset(spread(), OPTIONS))) as ReturnType<typeof buildDataset>
  payload.manifest.id = `ds_${'0'.repeat(16)}`
  const verdict = verifyDataset(payload)
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ok === false ? verdict.code : 'ok', 'DATASET_ID_MISMATCH')
})

test('a payload that is not a dataset is refused as MALFORMED_DATASET', () => {
  for (const payload of [null, {}, { manifest: {}, records: [] }, { manifest: { records: [] } }]) {
    const verdict = verifyDataset(payload)
    assert.equal(verdict.ok, false)
    assert.equal(verdict.ok === false ? verdict.code : 'ok', 'MALFORMED_DATASET')
  }
})
