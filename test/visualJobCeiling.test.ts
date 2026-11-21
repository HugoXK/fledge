import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// #787: the visual job's cost is a property of the workflow, not of a page, so
// this suite reads the workflow and the runner as text. It loads on the base
// tree (nothing here is imported from a module the fix adds) and every
// assertion below fails there: there is no browser cache, and the runner writes
// no job summary.

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

test('the visual job restores the browser layer under the Playwright version', () => {
  const job = visualJob()
  assert.match(job, /uses: actions\/cache@[0-9a-f]{40}/, 'the visual job does not use actions/cache')
  assert.match(job, /path: ~\/\.cache\/ms-playwright/, 'the cache does not cover the Playwright browser directory')
  assert.match(
    job,
    /key: \$\{\{ runner\.os \}\}-playwright-\$\{\{ steps\.playwright\.outputs\.version \}\}/,
    'the cache key does not name the Playwright version',
  )
  assert.match(
    job,
    /require\('playwright\/package\.json'\)\.version/,
    'the version in the cache key does not come from the installed Playwright',
  )
})

test('a Playwright bump is a cold run rather than a reused browser', () => {
  const job = visualJob()
  assert.doesNotMatch(job, /restore-keys:/, 'a restore-key would hand a new Playwright an older browser')
})

test('a cache hit cannot skip the matrix', () => {
  const job = visualJob()
  assert.match(job, /\n {6}- run: npx playwright install --with-deps chromium\n/, 'the install step is missing or guarded')
  assert.match(job, /\n {6}- run: npm run visual:matrix\n/, 'the matrix step is missing or guarded')
})

test('the runner publishes one row per case to the job summary', () => {
  const runner = read('scripts/visual-matrix.ts')
  assert.match(runner, /GITHUB_STEP_SUMMARY/, 'the runner never reads GITHUB_STEP_SUMMARY')
  assert.match(runner, /appendFileSync\(target, summaryMarkdown\(cases\)\)/, 'the runner does not append the case table')
  assert.match(runner, /process\.exitCode = 1/, 'a failure no longer sets a red exit code')
})

test('the summary names the page, viewport and scheme of every case', async () => {
  const lib = (await import('../src/lib/visualMatrix.js')) as unknown as {
    summaryMarkdown?: (rows: readonly {
      locale: string
      width: number
      scheme: string
      path: string
      ok: boolean
      detail: readonly string[]
    }[]) => string
  }
  const formatter = lib.summaryMarkdown
  assert.ok(formatter !== undefined, 'summaryMarkdown is not exported')
  const out = formatter([
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

test('a reason with a pipe cannot break the table', async () => {
  const lib = (await import('../src/lib/visualMatrix.js')) as unknown as {
    summaryMarkdown?: (rows: readonly {
      locale: string
      width: number
      scheme: string
      path: string
      ok: boolean
      detail: readonly string[]
    }[]) => string
  }
  const formatter = lib.summaryMarkdown
  assert.ok(formatter !== undefined, 'summaryMarkdown is not exported')
  const out = formatter([
    { locale: 'en', width: 1280, scheme: 'host', path: '/', ok: false, detail: ['a | b'] },
  ])
  assert.match(out, /a \\\| b/, 'a pipe in a reason is not escaped')
})

// The cache is worth a shortcut only if a red cell still reaches the required
// check. Three negatives, as the card asks: a broken cell is red, a stale cache
// cannot green a failed cell, and a dropped page or a reused baseline key cannot
// pass. The first two are properties of the workflow and the runner below; the
// third is pinned as pure functions in `test/visualMatrix.test.ts`.
test('a broken cell reaches the required check instead of stopping at the job', () => {
  const job = visualJob()
  assert.match(job, /\n {6}- run: npx playwright install --with-deps chromium\n/, 'the install step is missing')
  assert.match(job, /\n {6}- run: npm run visual:matrix\n/, 'the matrix step is missing')
  assert.doesNotMatch(job, /continue-on-error/, 'a failing matrix must not be allowed to finish green')
  const runner = read('scripts/visual-matrix.ts')
  assert.match(runner, /if \(failures\.length > 0\) \{/, 'the runner no longer checks its failure list')
  assert.match(runner, /process\.exitCode = 1/, 'a failure no longer sets a red exit code')
  const workflow = read('.github/workflows/ci.yml')
  assert.match(
    workflow,
    /needs: \[ci-ok,[^\]]*\bvisual\b[^\]]*\]/,
    'the visual job is not in the aggregate ci-ok needs, so a red matrix would not fail the required check',
  )
})

test('a cache hit restores the browser directory and nothing that can green a cell', () => {
  const job = visualJob()
  const start = job.indexOf('uses: actions/cache@')
  assert.notEqual(start, -1, 'the visual job does not use actions/cache')
  const stepStart = job.lastIndexOf('\n      - ', start)
  const stepEnd = job.indexOf('\n      - ', start)
  assert.ok(stepStart !== -1 && stepEnd > stepStart, 'the cache step is not delimited')
  const step = job.slice(stepStart, stepEnd)
  const paths = [...step.matchAll(/^\s+path: (.+)$/gm)].map((match) => match[1])
  assert.deepEqual(paths, ['~/.cache/ms-playwright'], 'the cache restores more than the browser download')
  // The row's result is taken from the assertions this process ran, so a hit
  // cannot produce a green row for a cell that failed.
  const runner = read('scripts/visual-matrix.ts')
  assert.match(runner, /ok: failures\.length === from/, 'a row no longer takes its result from the failures it produced')
  assert.match(runner, /detail: failures\.slice\(from\)/, 'a row no longer carries its own failures')
})

test('the runner compares what ran against the promised case set', () => {
  const runner = read('scripts/visual-matrix.ts')
  assert.match(runner, /function checkCoverage\(\): void \{/, 'the runner has no coverage check')
  assert.match(runner, /caseCoverage\(expectedCaseKeys\(\), \[\.\.\.recordedKeys\]\)/, 'the coverage check does not compare against the promised set')
  assert.match(runner, /promised case\(s\) never ran/, 'a dropped case does not name itself as a failure')
  assert.match(runner, /case key reused/, 'a reused case key does not fail the run')
  const workflow = read('.github/workflows/ci.yml')
  assert.match(workflow, /actions\/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4\.3\.0/, 'the cache action is not pinned')
})
