import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// #787: the visual job's cost and its reporting are properties of the workflow
// and the runner, not of a page, so this suite reads both as text. #1208
// sharded the sweep, so the coverage half here is the shared aggregate guard
// and the summary is built from what the shares reported.

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

const lib = (await import('../src/lib/visualMatrix.js')) as unknown as {
  visualWorkload?: () => readonly ColumnCell[]
  cellLabel?: (cell: ColumnCell) => string
  caseRows?: (cells: readonly ColumnCell[], results: readonly (ShardResult | null)[]) => readonly Row[]
  summaryMarkdown?: (rows: readonly Row[], notes?: readonly string[]) => string
}

interface ColumnCell {
  readonly kind: 'sweep' | 'narrow' | 'gate' | 'theme'
  readonly locale: string
  readonly width: number
  readonly scheme?: string
  readonly path: string
}

interface ShardResult {
  readonly share: number
  readonly cells: readonly string[]
  readonly failures: readonly string[]
}

interface Row {
  readonly locale: string
  readonly width: number
  readonly scheme: string
  readonly path: string
  readonly ok: boolean
  readonly detail: readonly string[]
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
  const text = read('src/lib/visualMatrix.ts')
  assert.match(text, /was assigned no cells/, 'an empty share no longer fails the run')
  assert.match(text, /reported no result/, 'a missing share result no longer fails the run')
  assert.match(text, /did not report/, 'a dropped cell no longer fails the run')
  assert.match(text, /was measured .* times/, 'a duplicated cell no longer fails the run')
})

test('the coordinator publishes the case table to the job summary', () => {
  const runner = read('scripts/visual-matrix.ts')
  assert.match(runner, /GITHUB_STEP_SUMMARY/, 'the runner never reads GITHUB_STEP_SUMMARY')
  assert.match(runner, /summaryMarkdown\(/, 'the runner does not build the case table')
  assert.match(runner, /appendFileSync\(target, summaryMarkdown/, 'the runner does not append the case table')
})

test('the summary names the page, viewport and scheme of every case', () => {
  const formatter = lib.summaryMarkdown
  assert.ok(formatter !== undefined, 'summaryMarkdown is not exported')
  const out = formatter!([
    { locale: 'en', width: 360, scheme: 'dark', path: '/settings', ok: true, detail: [] },
    {
      locale: 'zh',
      width: 768,
      scheme: 'light',
      path: '/dashboard',
      ok: false,
      detail: ['button[name] is 39px tall'],
    },
  ])
  assert.match(out, /^visual matrix: 1\/2 case\(s\) passed$/m)
  assert.match(out, /^\| locale \| viewport \| scheme \| page \| result \|$/m)
  assert.match(out, /^\| en \| 360px \| dark \| `\/settings` \| pass \|$/m)
  assert.match(out, /^\| zh \| 768px \| light \| `\/dashboard` \| fail: button\[name\] is 39px tall \|$/m)
})

test('a reason with a pipe cannot break the table', () => {
  const formatter = lib.summaryMarkdown
  assert.ok(formatter !== undefined, 'summaryMarkdown is not exported')
  const out = formatter!([{ locale: 'en', width: 1280, scheme: 'host', path: '/', ok: false, detail: ['a | b'] }])
  assert.match(out, /a \\\| b/, 'a pipe in a reason is not escaped')
})

test('a cell no share reported reads as a failure in the table', () => {
  const workload = lib.visualWorkload
  const label = lib.cellLabel
  const rowsOf = lib.caseRows
  assert.ok(workload !== undefined && label !== undefined && rowsOf !== undefined, 'caseRows is not exported')

  const cells = workload!().slice(0, 2)
  const measured = label!(cells[0]!)
  const results: (ShardResult | null)[] = [
    { share: 1, cells: [measured], failures: [`${measured}: element outside the viewport`] },
    null,
  ]
  const rows = rowsOf!(cells, results)
  assert.equal(rows.length, 2, 'the table has one row per promised cell')
  assert.equal(rows[0]!.ok, false, 'a cell whose failure the share reported must read as a failure')
  assert.deepEqual(rows[0]!.detail, ['element outside the viewport'], 'the reason keeps its text without the cell prefix')
  assert.equal(rows[1]!.ok, false, 'a cell no share reported must not read as a pass')
  assert.match(String(rows[1]!.detail[0]), /never measured|reported no result/, 'an unmeasured cell names why it is not verified')
})

test('the scheme column says which mode the cell was measured in', () => {
  const workload = lib.visualWorkload
  const rowsOf = lib.caseRows
  assert.ok(workload !== undefined && rowsOf !== undefined, 'caseRows is not exported')
  const all = workload!()
  const rows = rowsOf!(all, [])
  const schemes = new Set(rows.map((row) => row.scheme))
  assert.ok(schemes.has('host'), 'the sweep rows do not name the host colour scheme')
  assert.ok(schemes.has('light') && schemes.has('dark'), 'the gate rows do not name their forced scheme')
  assert.ok(schemes.has('explicit-dark'), 'the theme probe row does not name its scheme')
})
