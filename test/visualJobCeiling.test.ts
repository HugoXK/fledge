import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// #787: the visual job's cost is a property of the workflow, not of a page, so
// this suite reads the workflow and the runner as text. #1208 sharded the sweep;
// #1214 is the tip this branch rebased onto, so the coverage half here is the
// shared aggregate guard that a shard cannot skip.

const root = fileURLToPath(new URL('..', import.meta.url))

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function visualJob(): string {
  const text = read('.github/workflows/ci.yml')
  const start = text.indexOf('\n  visual:\n')
  assert.notEqual(start, -1, 'ci.yml has no visual job')
  const end = text.indexOf('\n  docker:\n', start)
  assert.ok(end > start, 'the visual job is not followed by the docker job')
  return text.slice(start, end)
}

test('the visual job keeps its name and its place in the required set', () => {
  const workflow = read('.github/workflows/ci.yml')
  assert.match(workflow, /\n {2}visual:\n/, 'the visual job was renamed or removed')
  assert.match(
    workflow,
    /needs: \[ci-ok,[^\]]*\bvisual\b[^\]]*\]/,
    'the visual job is not in the aggregate ci-ok needs, so a red matrix would not fail the required check',
  )
})

test('a broken cell reaches the required check instead of stopping at the job', () => {
  const job = visualJob()
  assert.match(job, /\n {6}- run: npx playwright install --with-deps chromium\n/, 'the install step is missing or guarded')
  assert.match(job, /\n {6}- run: npm run visual:matrix\n/, 'the matrix step is missing or guarded')
  assert.doesNotMatch(job, /continue-on-error/, 'a failing matrix must not be allowed to finish green')
  const runner = read('scripts/visual-matrix.ts')
  assert.match(runner, /process\.exitCode = 1/, 'a failure no longer sets a red exit code')
})

test('the aggregate refuses a matrix that would collapse coverage', () => {
  // The guard is the shard aggregate: a share that measured nothing, a result
  // that never arrived, a cell missing from a share that ran, and a cell
  // measured twice all fail the run. Pinned here as the runner wiring this job
  // depends on; the rule itself is unit-tested in `visualMatrixShards.test.ts`.
  const runner = read('scripts/visual-matrix.ts')
  assert.match(runner, /shardFailures\(/, 'the aggregate no longer uses the shared coverage guard')
  const lib = read('src/lib/visualMatrix.ts')
  assert.match(lib, /was assigned no cells/, 'an empty share no longer fails the run')
  assert.match(lib, /reported no result/, 'a missing share result no longer fails the run')
  assert.match(lib, /did not report/, 'a dropped cell no longer fails the run')
  assert.match(lib, /was measured .* times/, 'a duplicated cell no longer fails the run')
})
