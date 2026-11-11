import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The risk job used to pick `origin/<base.ref>` on `pull_request` and `HEAD~1`
// for everything else — including `merge_group`, where `HEAD~1` is the queue's
// synthetic merge commit and not the base the diff must be measured against.
// A merge-group run therefore classified whatever the last commit happened to
// touch. These tests pin the choice itself, not the diff: the tier consequence
// is modelled from the same classifier the gate uses.

const workflowPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url))
const riskModule = (await import('../scripts/lib/risk.mjs')) as {
  chooseBase?: (eventName: string, event: Record<string, unknown>) => { ref: string; fetch: string }
  loadRules: () => unknown
  tierForFiles: (files: string[], rules: unknown) => { tier: string; basis?: string; files?: string[] }
}

const BASE_SHA = '9f'.repeat(20)

function choose(eventName: string, event: Record<string, unknown>): { ref: string; fetch: string } {
  assert.equal(typeof riskModule.chooseBase, 'function', 'scripts/lib/risk.mjs must export chooseBase so the base choice is testable off the event')
  return riskModule.chooseBase!(eventName, event)
}

test('a merge_group run measures against the merge group base sha, never HEAD~1', () => {
  const chosen = choose('merge_group', { merge_group: { base_sha: BASE_SHA, base_ref: 'refs/heads/main' } })
  assert.equal(chosen.ref, BASE_SHA)
  assert.notEqual(chosen.ref, 'HEAD~1', 'HEAD~1 in a merge group is the synthetic merge commit, not the base')
  // The sha has to exist locally before risk-gate can diff it.
  assert.equal(chosen.fetch, 'refs/heads/main')
})

test('a merge_group event without base_sha falls back to the base ref', () => {
  const chosen = choose('merge_group', { merge_group: { base_ref: 'refs/heads/main' } })
  assert.equal(chosen.ref, 'origin/main')
  assert.equal(chosen.fetch, 'main')
})

test('a pull_request run measures against its base branch', () => {
  const chosen = choose('pull_request', { pull_request: { base: { ref: 'release/2.x' } } })
  assert.equal(chosen.ref, 'origin/release/2.x')
  assert.equal(chosen.fetch, 'release/2.x')
})

test('only a real push falls back to HEAD~1', () => {
  const pushed = choose('push', {})
  assert.equal(pushed.ref, 'HEAD~1')
  assert.equal(pushed.fetch, '')
})

test('a scheduled or manual run measures the branch against its default branch, never HEAD~1', () => {
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    const chosen = choose(eventName, { repository: { default_branch: 'main' } })
    assert.equal(chosen.ref, 'origin/main')
    assert.equal(chosen.fetch, 'main')
    assert.notEqual(chosen.ref, 'HEAD~1', `${eventName} has no previous commit of its own to measure`)
  }
  // The default branch is read from the event, not hard-coded.
  const custom = choose('workflow_dispatch', { repository: { default_branch: 'trunk' } })
  assert.equal(custom.ref, 'origin/trunk')
  assert.equal(custom.fetch, 'trunk')
})

test('the base decides whether a T3 change is seen at all', () => {
  const rules = riskModule.loadRules()
  // What the merge-group base sees: this PR's own .github change.
  assert.equal(riskModule.tierForFiles(['.github/workflows/ci.yml'], rules).tier, 'T3')
  // What a HEAD~1 diff of the same branch sees: only the last commit's files.
  assert.equal(riskModule.tierForFiles(['src/views/pages.ts'], rules).tier, 'T2')
})

test('the risk job asks the shared script for its base instead of branching in YAML', () => {
  const workflow = readFileSync(workflowPath, 'utf8')
  assert.match(workflow, /--print-base/, 'the risk job must take its base from the script that the tests exercise')
  assert.doesNotMatch(workflow, /ref=HEAD~1/, 'the HEAD~1 decision belongs in scripts/lib/risk.mjs, not in the workflow')
})

// The tier is computed per file and the strictest one wins. The old loop
// returned the first tier in which any single file matched, so one docs file in
// a mixed diff made the whole change T0 — and `AGENTS.md` promises that a path
// no rule names is T2, never silently T0/T1.
test('a diff mixing an unnamed path with a docs file is T2, not T0', () => {
  const rules = riskModule.loadRules()
  const result = riskModule.tierForFiles(['.env.example', 'docs/deploy.md'], rules)
  assert.equal(result.tier, 'T2', 'the strictest per-file tier must win over every path')
  assert.equal(result.basis, '.env.example', 'the unnamed path is what decides, by being T2')
})

test('per-file tiering keeps the single-file answers the old loop got right', () => {
  const rules = riskModule.loadRules()
  const tier = (files: string[]): string => riskModule.tierForFiles(files, rules).tier
  assert.equal(tier(['docs/deploy.md']), 'T0')
  assert.equal(tier(['src/views/pages.ts', 'docs/deploy.md']), 'T2')
  assert.equal(tier(['.github/workflows/ci.yml', 'src/views/pages.ts']), 'T3')
})

test('a path no rule names is T2 on its own, with itself as the basis', () => {
  const rules = riskModule.loadRules()
  const result = riskModule.tierForFiles(['notes/unlisted.md'], rules)
  assert.equal(result.tier, 'T2')
  assert.equal(result.basis, 'notes/unlisted.md')
})

test('the winning tier still lists every file that justifies it', () => {
  const rules = riskModule.loadRules()
  const result = riskModule.tierForFiles(['src/app.ts', '.env.example', 'docs/deploy.md'], rules)
  assert.equal(result.tier, 'T2')
  assert.deepEqual(result.files, ['src/app.ts', '.env.example'], 'the report keeps the matched files, it just stops deciding from the first one')
})
