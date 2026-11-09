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
  tierForFiles: (files: string[], rules: unknown) => { tier: string; basis?: string }
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
  for (const eventName of ['schedule', 'workflow_dispatch']) {
    assert.equal(choose(eventName, {}).ref, 'HEAD~1')
  }
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
