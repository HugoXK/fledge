import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkArchitecture, checkFileSizes, checkImports } from '../scripts/lib/arch-boundaries.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function files(...entries: Array<[string, string]>) {
  return entries.map(([path, content]) => ({ path, content }))
}

test('a view may import a db row type but not the store', () => {
  assert.deepEqual(
    checkImports({ files: files(['src/views/page.ts', "import type { JobRow } from '../db.js'\n"]) }),
    [],
  )
  const violations = checkImports({ files: files(['src/views/page.ts', "import { store } from '../db.js'\n"]) })
  assert.equal(violations.length, 1)
  assert.equal(violations[0]?.rule, 'views-no-store')
  assert.match(String(violations[0]?.reason), /row types/)
})

test('the store must not import the composition root, views or jobs', () => {
  for (const target of ['src/app.ts', 'src/views/pages.ts', 'src/jobs/service.ts']) {
    const specifier = `./${target.slice('src/'.length).replace(/\.ts$/, '.js')}`
    const violations = checkImports({ files: files(['src/db.ts', `import { x } from '${specifier}'\n`]) })
    assert.equal(violations.length, 1, target)
    assert.equal(violations[0]?.rule, 'db-no-outer')
  }
})

test('jobs must not import views, and views may only use the allowed job helpers', () => {
  const fromJobs = checkImports({ files: files(['src/jobs/x.ts', "import { page } from '../views/pages.js'\n"]) })
  assert.equal(fromJobs.length, 1)
  assert.equal(fromJobs[0]?.rule, 'jobs-no-views')

  assert.deepEqual(
    checkImports({ files: files(['src/views/x.ts', "import { carryOverHeaderText } from '../jobs/continuity.js'\n"]) }),
    [],
  )
  const fromService = checkImports({ files: files(['src/views/x.ts', "import { Jobs } from '../jobs/service.js'\n"]) })
  assert.equal(fromService.length, 1)
  assert.equal(fromService[0]?.rule, 'views-no-jobs-service')
})

test('a type-only import from the job service is not runtime coupling', () => {
  assert.deepEqual(
    checkImports({ files: files(['src/views/x.ts', "import type { PlatformStopRecord } from '../jobs/service.js'\n"]) }),
    [],
  )
})

test('external and unresolved imports are not judged', () => {
  assert.deepEqual(
    checkImports({
      files: files(['src/views/x.ts', "import { fastify } from 'fastify'\nimport { gone } from './not-there.js'\n"]),
    }),
    [],
  )
})

test('a new file over the line limit fails, and a grandfathered one may not grow', () => {
  const body = (lines: number): string => 'x\n'.repeat(lines)
  assert.deepEqual(checkFileSizes({ files: files(['src/new.ts', body(1200)]) }), [])
  assert.equal(checkFileSizes({ files: files(['src/new.ts', body(1201)]) })[0]?.rule, 'file-too-large')

  assert.deepEqual(
    checkFileSizes({ files: files(['src/db.ts', body(3)]), grandfather: { 'src/db.ts': 3 }, maxLines: 2 }),
    [],
  )
  assert.equal(
    checkFileSizes({ files: files(['src/db.ts', body(4)]), grandfather: { 'src/db.ts': 3 }, maxLines: 2 })[0]?.rule,
    'grandfathered-growth',
  )
})

test('a grandfathered file at or below the limit must remove its entry', () => {
  const stale = checkFileSizes({ files: files(['src/db.ts', 'x\n'.repeat(1200)]), grandfather: { 'src/db.ts': 1300 } })
  assert.equal(stale[0]?.rule, 'stale-grandfather')
})

test('a runtime import is found at the line that starts it', () => {
  const violations = checkImports({
    files: files(['src/views/x.ts', "// header\n\nimport {\n  store,\n} from '../db.js'\n"]),
  })
  assert.equal(violations[0]?.line, 3)
})

test('the current tree passes the boundary and size gate', () => {
  const run = spawnSync(process.execPath, ['scripts/arch-boundaries.mjs'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr || run.stdout)
})

test('checkArchitecture reports the sizes it checked', () => {
  const result = checkArchitecture({
    files: files(['src/db.ts', 'x\n'.repeat(3)], ['src/app.ts', "import { x } from './db.js'\n"]),
    grandfather: { 'src/db.ts': 3 },
    maxLines: 2,
  })
  assert.deepEqual(result.violations, [])
  assert.equal(result.checked.files, 2)
  assert.equal(result.checked.imports, 1)
  assert.equal(result.checked.grandfathered, 1)
})
