import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as visualMatrix from '../src/lib/visualMatrix.js'
import {
  GATE_SCHEMES,
  GATE_WIDTHS,
  VISUAL_NARROW_CASES,
  VISUAL_PATHS,
  VISUAL_WIDTHS,
} from '../src/lib/visualMatrix.js'

// #1208: the sweep is one serial loop, so the gate's wall time is the sum of
// independent cells instead of the longest share. Sharding only helps if the
// partition is provably the same work: every cell exactly once, no share that
// checks nothing, and a share whose results never arrive failing the aggregate.
//
// The API is reached through the module object so this file still loads on a
// tree that has no partition yet (the red run at the pin), instead of failing
// at import time and hiding which assertion is missing.
interface Cell {
  readonly kind: string
  readonly locale: string
  readonly width: number
  readonly path?: string
  readonly scheme?: string
}

interface ShardResult {
  readonly share: number
  readonly cells: readonly string[]
  readonly failures: readonly string[]
}

interface ShardApi {
  visualWorkload?: () => readonly Cell[]
  cellLabel?: (cell: Cell) => string
  partitionWorkload?: (cells: readonly Cell[], shares: number) => readonly (readonly Cell[])[]
  shardFailures?: (cells: readonly Cell[], shares: number, results: readonly (ShardResult | null)[]) => string[]
}

const api = visualMatrix as unknown as ShardApi

function exported<T>(name: keyof ShardApi): T {
  const value = api[name]
  assert.equal(
    typeof value,
    'function',
    `src/lib/visualMatrix.ts must export ${String(name)}: without it the sweep cannot be partitioned, and a shard that checks less reads green`,
  )
  return value as unknown as T
}

const LOCALES = ['zh', 'en'] as const

/** `noUncheckedIndexedAccess` is on; an index this test indexes had better exist. */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index]
  assert.ok(value !== undefined, `expected an entry at index ${String(index)}`)
  return value
}

/** The cross-product the serial runner visits today, rebuilt from the same lists. */
function expectedLabels(): string[] {
  const labels: string[] = []
  for (const locale of LOCALES) {
    for (const width of VISUAL_WIDTHS) labels.push(`${locale} ${String(width)}px /`)
    for (const width of VISUAL_WIDTHS) {
      for (const path of VISUAL_PATHS) {
        if (path === '/') continue
        labels.push(`${locale} ${String(width)}px ${path}`)
      }
    }
    for (const narrow of VISUAL_NARROW_CASES) labels.push(`${locale} ${String(narrow.width)}px ${narrow.path}`)
    for (const width of GATE_WIDTHS) {
      for (const scheme of GATE_SCHEMES) {
        for (const path of VISUAL_PATHS) labels.push(`${locale} width=${String(width)} scheme=${scheme} ${path}`)
      }
    }
    for (const width of GATE_WIDTHS) labels.push(`${locale} width=${String(width)} scheme=explicit-dark /dashboard`)
  }
  return labels
}

test('the shares partition the whole sweep exactly once', () => {
  const workload = exported<() => readonly Cell[]>('visualWorkload')()
  const label = exported<(cell: Cell) => string>('cellLabel')
  const partition = exported<(cells: readonly Cell[], shares: number) => readonly (readonly Cell[])[]>('partitionWorkload')

  const workloadLabels = workload.map(label).sort()
  assert.deepEqual(workloadLabels, expectedLabels().sort(), 'the workload is the sweep and the gate cross-product, built from the same lists the runner reads')

  for (const shares of [2, 4]) {
    const parts = partition(workload, shares)
    assert.equal(parts.length, shares, `a ${String(shares)}-way split has ${String(shares)} shares`)
    const flat = parts.flat().map(label)
    assert.equal(flat.length, workloadLabels.length, 'partitions must not drop or duplicate a cell')
    assert.deepEqual([...flat].sort(), workloadLabels, 'the union of the shares is the workload, each cell exactly once')
    for (const part of parts) {
      assert.ok(part.length > 0, 'every share of a well-sized split is non-empty')
    }
    const average = workload.length / shares
    for (const part of parts) {
      assert.ok(
        Math.abs(part.length - average) <= 1,
        `a share of ${String(part.length)} cells is not within one cell of the ${String(average)} average, so one core idles`,
      )
      // A share has to be a prefix/contiguous slice of the workload, not a
      // round robin: the runner reuses one browser context per locale and mode.
      const indexes = part.map((cell) => workload.findIndex((other) => label(other) === label(cell)))
      assert.deepEqual(indexes, [...indexes].sort((left, right) => left - right), 'a share keeps the workload order')
    }
  }

  const four = partition(workload, 4).flat().map(label)
  assert.ok(four.includes('en 360px /admin'), 'the split still covers /admin at the narrowest phone width')
  assert.ok(four.includes('zh width=1280 scheme=dark /console'), 'the split still covers the gate pass in both schemes')
})

test('a share assigned no cells fails instead of reporting success', () => {
  const workload = exported<() => readonly Cell[]>('visualWorkload')()
  const label = exported<(cell: Cell) => string>('cellLabel')
  const partition = exported<(cells: readonly Cell[], shares: number) => readonly (readonly Cell[])[]>('partitionWorkload')
  const problems = exported<(cells: readonly Cell[], shares: number, results: readonly (ShardResult | null)[]) => string[]>(
    'shardFailures',
  )

  const shares = workload.length + 1
  const parts = partition(workload, shares)
  assert.equal(at(parts, shares - 1).length, 0, 'the extra share is the empty one this test is about')
  const results = parts.map((part, index) =>
    part.length === 0 ? null : { share: index, cells: part.map(label), failures: [] },
  )
  const failures = problems(workload, shares, results)
  assert.ok(
    failures.some((failure) => /no cells|zero cells|empty/i.test(failure)),
    `an empty share has to fail the run naming the share; got: ${failures.join(' | ') || '(nothing)'}`,
  )
})

test('a share whose results are missing fails the aggregate', () => {
  const workload = exported<() => readonly Cell[]>('visualWorkload')()
  const label = exported<(cell: Cell) => string>('cellLabel')
  const partition = exported<(cells: readonly Cell[], shares: number) => readonly (readonly Cell[])[]>('partitionWorkload')
  const problems = exported<(cells: readonly Cell[], shares: number, results: readonly (ShardResult | null)[]) => string[]>(
    'shardFailures',
  )

  const parts = partition(workload, 4)
  const results = parts.map((part, index) =>
    index === 2 ? null : { share: index, cells: part.map(label), failures: [] },
  )
  const failures = problems(workload, 4, results)
  assert.ok(
    failures.some((failure) => /share 3|no result|never measured/i.test(failure)),
    `a share that never wrote its result must fail the aggregate; got: ${failures.join(' | ') || '(nothing)'}`,
  )

  // The survival half: a share that reports fewer cells than it was assigned is
  // "checked less", and the aggregate has to name the cell nobody measured.
  const short = parts.map((part, index) => ({
    share: index,
    cells: index === 1 ? part.slice(1).map(label) : part.map(label),
    failures: [],
  }))
  const dropped = label(at(at(parts, 1), 0))
  const missing = problems(workload, 4, short)
  assert.ok(
    missing.some((failure) => failure.includes(dropped)),
    `a cell dropped from a share's results must be named in the aggregate; wanted ${dropped}, got: ${missing.join(' | ') || '(nothing)'}`,
  )
})

test('a failing cell in a later share reaches the job output verbatim', () => {
  const workload = exported<() => readonly Cell[]>('visualWorkload')()
  const label = exported<(cell: Cell) => string>('cellLabel')
  const partition = exported<(cells: readonly Cell[], shares: number) => readonly (readonly Cell[])[]>('partitionWorkload')
  const problems = exported<(cells: readonly Cell[], shares: number, results: readonly (ShardResult | null)[]) => string[]>(
    'shardFailures',
  )

  const parts = partition(workload, 4)
  const failing = `${label(at(at(parts, 1), 0))}: element outside the viewport: div.card`
  const results = parts.map((part, index) => ({
    share: index,
    cells: part.map(label),
    failures: index === 1 ? [failing] : [],
  }))
  const failures = problems(workload, 4, results)
  assert.ok(
    failures.includes(failing),
    'a failure raised inside a share must appear in the aggregate job output unchanged — an artifact alone is not a red gate',
  )
})

test('the runner takes its share from the partition instead of a second list', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(script, /visualWorkload\(\)/, 'the runner must build its workload from the shared lists')
  assert.match(script, /partitionWorkload\(/, 'the runner must take its share from the partition')
  assert.match(script, /shardFailures\(/, 'the aggregate must be checked by the shared guard, not by counting processes')
  assert.match(script, /--share/, 'a share has to be selectable from the command line so the job can run one per core')
})

// The card's third non-negotiable: `visual` keeps its name and its place in the
// required set. Whatever sits inside it, `ci-ok` and the main-health reporter
// keep depending on a check called `visual`.
test('the visual check keeps its name and its place in the required set', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(ci, /^ {2}visual:\n {4}name: visual$/m, 'the job must stay the required check `visual`')
  const needsOnVisual = ci.split('\n').filter((line) => /\bneeds:/.test(line) && /\bvisual\b/.test(line))
  assert.ok(
    needsOnVisual.length >= 2,
    `ci-ok and main-health both name visual in their needs; found ${String(needsOnVisual.length)} line(s)`,
  )
})
