import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  allGateChanges,
  classifyChanges,
  isDbPath,
  isDocPath,
  isFrontendPath,
  isSourcePath,
  isWorkflowPath,
} from '../scripts/lib/ciChanges.mjs'

// The classifier answer is still right for the gates that read only their own
// inputs. It is not right for the suite: `test/uiTokens.test.ts` asserts on
// `docs/ui.md`, `test/alertBuckets.test.ts` on `deploy/prometheus/` and
// `test/codeqlGate.test.ts` on `.github/workflows/` — 60 of the 184 files under
// `test/` read those trees. Skipping the suite on `source: false` therefore put a
// green `ci-ok` over a red suite on docs-only (T0) and `public/`-only (T1)
// pull requests, where no verdict reads the tip either.
test('a docs-only diff classifies as documentation and keeps the suite runnable', () => {
  const changes = classifyChanges(['docs/ui.md', 'README.md', 'CHANGELOG.md', 'changelog.d/1.added.md'])
  assert.deepEqual(changes, {
    docsOnly: true,
    source: false,
    frontend: false,
    deps: false,
    db: false,
    docker: false,
    workflows: false,
    codeql: false,
  })

  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
  for (const job of ['test', 'coverage']) {
    const block = jobBlock(workflow, job)
    assert.doesNotMatch(block, /if: needs\.changes\.outputs\./, `${job} must run on every diff, including this one`)
    assert.doesNotMatch(block, /needs: changes/, `${job} must not wait on the classifier that would skip it`)
  }
})

function jobBlock(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:`)
  assert.ok(start !== -1, `ci.yml must declare ${job}`)
  const rest = workflow.slice(start + 1)
  const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

test('a workflow-only diff runs the workflow checks but not the code gates', () => {
  const changes = classifyChanges(['.github/workflows/ci.yml'])
  assert.equal(changes.workflows, true)
  assert.equal(changes.source, false)
  assert.equal(changes.docker, false)
  assert.equal(changes.frontend, false)
  assert.equal(changes.codeql, true)
})

test('a backend source change runs code and Docker but not visual', () => {
  const changes = classifyChanges(['src/jobs/service.ts'])
  assert.equal(changes.source, true)
  assert.equal(changes.docker, true)
  assert.equal(changes.frontend, false)
  assert.equal(changes.db, false)
  assert.equal(changes.codeql, true)
})

test('a view or public change runs visual and Docker', () => {
  const views = classifyChanges(['src/views/pages.ts'])
  assert.equal(views.frontend, true)
  assert.equal(views.source, true)
  assert.equal(views.docker, true)
  assert.equal(views.codeql, true)

  const publicOnly = classifyChanges(['public/app.css'])
  assert.equal(publicOnly.frontend, true)
  assert.equal(publicOnly.source, false)
  assert.equal(publicOnly.docker, true)
  assert.equal(publicOnly.codeql, true)
})

test('a test-only change runs the test gates but not Docker', () => {
  const changes = classifyChanges(['test/ciChanges.test.ts'])
  assert.equal(changes.source, true)
  assert.equal(changes.docker, false)
  assert.equal(changes.frontend, false)
  assert.equal(changes.codeql, true)
})

test('dependency, database and Docker inputs are classified separately', () => {
  assert.equal(classifyChanges(['package.json']).deps, true)
  assert.equal(classifyChanges(['package-lock.json']).deps, true)
  assert.equal(classifyChanges(['src/db.ts']).db, true)
  assert.equal(classifyChanges(['scripts/lib/backup-crypto.mjs']).db, true)

  const dockerfile = classifyChanges(['Dockerfile'])
  assert.equal(dockerfile.docker, true)
  assert.equal(dockerfile.source, false)
  assert.equal(dockerfile.codeql, false)
})

test('an unknown path is code and a Docker input rather than a skip', () => {
  const changes = classifyChanges(['brand-new-area/thing.ts'])
  assert.equal(changes.source, true)
  assert.equal(changes.docker, true)
  assert.equal(changes.workflows, false)
  assert.equal(changes.codeql, true)
})

test('deploy-only changes do not run the app gates', () => {
  const changes = classifyChanges(['deploy/nginx.conf'])
  assert.equal(changes.source, false)
  assert.equal(changes.docker, false)
  assert.equal(changes.workflows, false)
  assert.equal(changes.codeql, false)
})

test('an empty diff runs everything, because an unreadable diff must not shrink the gate', () => {
  assert.deepEqual(classifyChanges([]), allGateChanges())
  assert.deepEqual(allGateChanges(), {
    docsOnly: false,
    source: true,
    frontend: true,
    deps: true,
    db: true,
    docker: true,
    workflows: true,
    codeql: true,
  })
})

test('path predicates recognise the shapes the workflow relies on', () => {
  assert.equal(isDocPath('docs/deploy.md'), true)
  assert.equal(isSourcePath('scripts/ci-ok.mjs'), true)
  assert.equal(isFrontendPath('src/app.ts'), true)
  assert.equal(isWorkflowPath('.github/agent/review-policy.json'), true)
  assert.equal(isDbPath('scripts/restore-drill-ci.mjs'), true)
  assert.equal(isSourcePath('docs/deploy.md'), false)
})
