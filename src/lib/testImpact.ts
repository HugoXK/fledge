// #378: which tests a change has to run. The selection is a claim about impact,
// so every selected test carries the reason it was picked, and a change nothing
// maps to says so instead of pretending the whole suite is the answer.
export type ImpactReason = 'direct' | 'convention' | 'importer'

export interface SelectedTest {
  path: string
  reason: ImpactReason
}

export interface TestImpact {
  state: 'mapped' | 'no impact map'
  changed: string[]
  selected: SelectedTest[]
  // Bounded: the list is capped, and a cut is recorded rather than silently
  // shortened, the same way the path guard records a truncated file walk.
  truncated: boolean
  limit: number
}

export interface ImpactInput {
  changed: string[]
  testFiles: string[]
  // A repository-provided import graph (`test path -> imported paths`). Without
  // it there is nothing to read imports from, so only naming convention applies.
  imports?: Record<string, string[]>
  limit?: number
}

export const IMPACT_LIMIT = 50

const TEST_FILE = /(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/

function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

export function isTestFilePath(path: string): boolean {
  return TEST_FILE.test(path)
}

// The repository convention Fledge documents: a test for `src/foo.ts` lives at
// `test/foo.test.ts`. The directory is dropped on purpose — the suites are flat —
// and the extension is kept so `foo.ts` and `foo.mjs` never share a test by
// accident.
export function conventionalTestPath(source: string): string {
  const name = toPosix(source).split('/').pop() ?? ''
  return `test/${name.replace(/\.[^./]+$/, '')}.test.${name.slice(name.lastIndexOf('.') + 1)}`
}

function normalized(path: string): string {
  return toPosix(path).replace(/^\.\//, '')
}

export function selectTests(input: ImpactInput): TestImpact {
  const limit = input.limit ?? IMPACT_LIMIT
  const changed = input.changed.map(normalized).filter((path) => path !== '')
  const changedSet = new Set(changed)
  const testFiles = input.testFiles.map(normalized).filter((path) => path !== '')
  const testSet = new Set(testFiles)
  const imports = input.imports ?? {}

  // Strongest reason wins: a changed test is direct, a naming convention hit is
  // next, and an importer is the weakest because it depends on a graph the
  // repository supplied.
  const chosen = new Map<string, ImpactReason>()
  const rank: Record<ImpactReason, number> = { direct: 3, convention: 2, importer: 1 }
  const pick = (path: string, reason: ImpactReason): void => {
    const current = chosen.get(path)
    if (current === undefined || rank[reason] > rank[current]) chosen.set(path, reason)
  }

  for (const path of changed) if (testSet.has(path) && isTestFilePath(path)) pick(path, 'direct')
  for (const source of changed) {
    if (isTestFilePath(source)) continue
    const candidate = conventionalTestPath(source)
    if (testSet.has(candidate)) pick(candidate, 'convention')
  }
  for (const [testPath, imported] of Object.entries(imports)) {
    if (!testSet.has(normalized(testPath))) continue
    if (!imported.some((entry) => changedSet.has(normalized(entry)))) continue
    pick(normalized(testPath), 'importer')
  }

  const selected = [...chosen.entries()]
    .map(([path, reason]) => ({ path, reason }))
    .sort((left, right) => left.path.localeCompare(right.path))
  return {
    state: selected.length === 0 ? 'no impact map' : 'mapped',
    changed,
    selected: selected.slice(0, Math.max(1, limit)),
    truncated: selected.length > limit,
    limit,
  }
}
