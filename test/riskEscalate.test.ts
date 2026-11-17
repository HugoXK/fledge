import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// #869: a T1 tip — tests, public assets — needed no independent PASS, so a
// test-only pull request could delete or weaken an assertion while `ci-ok` stayed
// green and changed-lines coverage stayed flat, and a `public/` change could ship
// client-side script the same way. The path rule alone cannot see that, so the
// rules now raise a tier by what the diff does to a file, and both readers — the
// CI job over `git diff` and the gates over the pull-request file list — go
// through the same classifier.

const rulesPath = fileURLToPath(new URL('../.github/agent/risk-rules.json', import.meta.url))
const riskModule = (await import('../scripts/lib/risk.mjs')) as {
  classify: (files: string[], diffText: string, rules?: unknown) => { tier: string; basis: string }
  tierForChanges: (changes: Array<{ path: string; patch?: string }>, rules?: unknown) => { tier: string; basis: string }
  tierForFiles: (files: string[], rules?: unknown) => { tier: string; basis: string }
}

const rules = JSON.parse(readFileSync(rulesPath, 'utf8')) as unknown

/** A `git diff --unified=0` block for one file, from removed and added lines. */
function unifiedDiff(path: string, removed: string[], added: string[]): string {
  const body = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${String(removed.length)} +1,${String(added.length)} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ]
  return body.join('\n')
}

/** The patch shape the pull-request files API returns for one file. */
function apiPatch(removed: string[], added: string[]): string {
  return [
    `@@ -1,${String(removed.length)} +1,${String(added.length)} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join('\n')
}

test('a test-only diff that deletes an assertion is T2, so it needs a PASS', () => {
  const diff = unifiedDiff('test/example.test.ts', [
    "  assert.equal(page.statusCode, 200)",
    "  assert.equal(store.scheduleForRepo(repo.id)?.status, 'paused')",
  ], [
    "  assert.equal(page.statusCode, 200)",
  ])
  const result = riskModule.classify(['test/example.test.ts'], diff, rules)
  assert.equal(result.tier, 'T2', 'a deleted assertion must not merge without a review')
  assert.match(result.basis, /test\/example\.test\.ts/)
})

test('a test-only diff that adds an always-true assertion is T2', () => {
  const diff = unifiedDiff('test/example.test.ts', [], [
    "test('it works', () => {",
    "  assert.ok(true)",
    "})",
  ])
  const result = riskModule.classify(['test/example.test.ts'], diff, rules)
  assert.equal(result.tier, 'T2', 'assert.ok(true) proves nothing and must be reviewed')
})

test('a test-only diff that only adds a fixture or a new case stays T1', () => {
  const diff = unifiedDiff('test/example.test.ts', [], [
    "  const fixture = { name: 'x', status: 'paused' }",
    "  assert.equal(fixture.status, 'paused')",
  ])
  const result = riskModule.classify(['test/example.test.ts'], diff, rules)
  assert.equal(result.tier, 'T1', 'pure test data and new assertions keep the cheap tier')
})

test('a client-side script under public/ is T2 by path', () => {
  assert.equal(riskModule.tierForFiles(['public/app.js'], rules).tier, 'T2')
  assert.equal(riskModule.tierForFiles(['public/theme/app.mjs'], rules).tier, 'T2')
  assert.equal(riskModule.tierForFiles(['public/site.css'], rules).tier, 'T1', 'styles stay T1')
})

test('a public/ page that adds an inline script is T2', () => {
  const result = riskModule.tierForChanges([{
    path: 'public/index.html',
    patch: apiPatch(['<div id="app"></div>'], ['<div id="app"></div>', '<script>location.hash = "#x"</script>']),
  }], rules)
  assert.equal(result.tier, 'T2', 'an inline script runs in a browser and needs a review')
})

test('a test file the API returned no patch for cannot be raised, and is not guessed', () => {
  const result = riskModule.tierForChanges([{ path: 'test/example.test.ts' }], rules)
  assert.equal(result.tier, 'T1', 'nothing is inferred from lines nobody read')
})

test('the gates read the pull-request patches, not the file list alone', () => {
  const deleting = riskModule.tierForChanges([{
    path: 'test/example.test.ts',
    patch: apiPatch(["  assert.equal(a, 1)"], []),
  }], rules)
  assert.equal(deleting.tier, 'T2')

  const fixtureOnly = riskModule.tierForChanges([{
    path: 'test/example.test.ts',
    patch: apiPatch([], ["  const fixture = 1"]),
  }], rules)
  assert.equal(fixtureOnly.tier, 'T1')
})

test('a src/ change keeps its own tier and the strictest file still wins', () => {
  const mixed = riskModule.tierForChanges([
    { path: 'docs/deploy.md', patch: apiPatch(['old'], ['new']) },
    { path: 'test/example.test.ts', patch: apiPatch([], ["  const fixture = 1"]) },
  ], rules)
  assert.equal(mixed.tier, 'T1', 'docs plus a fixture is still T1')

  const withSource = riskModule.tierForChanges([
    { path: 'test/example.test.ts', patch: apiPatch([], ["  const fixture = 1"]) },
    { path: 'src/app.ts', patch: apiPatch(['old'], ['new']) },
  ], rules)
  assert.equal(withSource.tier, 'T2', 'a src file decides its own tier')
})
