import test from 'node:test'
import assert from 'node:assert/strict'
import { MIN_FEATURES, MIN_PRS, planRelease } from '../scripts/release-plan.mjs'
import type { ReleasePlanInput, ReleasePlanPr } from '../scripts/release-plan.mjs'

function merged(number: number, title: string, labels: string[] = [], mergedAt = '2026-11-07T00:00:00Z'): ReleasePlanPr {
  return { number, title, labels, mergedAt }
}

function feat(number: number): ReleasePlanPr {
  return merged(number, `feat: thing ${number}`)
}

function fix(number: number): ReleasePlanPr {
  return merged(number, `fix: thing ${number}`)
}

function input(over: Partial<ReleasePlanInput> = {}): ReleasePlanInput {
  return {
    lastTag: 'v0.2.4',
    packageVersion: '0.2.4',
    prs: [],
    fragments: ['changelog.d/80-daily-release.added.md'],
    openReleasePr: false,
    existingTags: ['v0.2.4'],
    crossCheck: { logPrNumbers: [] },
    ...over,
  }
}

test('9 merged PRs with 5 features is one short and does not release', () => {
  const plan = planRelease(input({ prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9)] }))
  assert.equal(plan.total, 9)
  assert.equal(plan.features, 5)
  assert.equal(plan.shouldRelease, false)
})

test('10 merged PRs with 5 features releases the next minor', () => {
  const plan = planRelease(input({ prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10)] }))
  assert.equal(plan.total, 10)
  assert.equal(plan.features, 5)
  assert.equal(plan.nextVersion, '0.3.0')
  assert.equal(plan.shouldRelease, true)
  assert.equal(MIN_PRS, 10)
  assert.equal(MIN_FEATURES, 5)
})

test('4 features in 10 merged PRs does not release', () => {
  const plan = planRelease(input({ prs: [feat(1), feat(2), feat(3), feat(4), fix(5), fix(6), fix(7), fix(8), fix(9), fix(10)] }))
  assert.equal(plan.total, 10)
  assert.equal(plan.features, 4)
  assert.equal(plan.shouldRelease, false)
})

test('scoped feature titles and the enhancement label both count as features', () => {
  const plan = planRelease(
    input({
      prs: [
        merged(1, 'feat(ui): stack the job table'),
        merged(2, 'feature: daily release'),
        merged(3, 'feature(api): expose the plan'),
        merged(4, 'docs: rewrite the guide', ['enhancement']),
        merged(5, 'feat: another one'),
        fix(6),
        fix(7),
        fix(8),
        fix(9),
        fix(10),
      ],
    }),
  )
  assert.equal(plan.total, 10)
  assert.equal(plan.features, 5)
  assert.equal(plan.shouldRelease, true)
})

test('no changelog fragment blocks the release and the count is still reported', () => {
  const plan = planRelease(input({ prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10)], fragments: [] }))
  assert.equal(plan.fragments, 0)
  assert.equal(plan.total, 10)
  assert.equal(plan.features, 5)
  assert.equal(plan.shouldRelease, false)
  assert.equal(plan.reason, 'no-fragments')
})

test('an open release PR blocks a second one', () => {
  const plan = planRelease(input({ prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10)], openReleasePr: true }))
  assert.equal(plan.shouldRelease, false)
  assert.equal(plan.reason, 'open-release-pr')
})

test('a duplicated PR number is counted once', () => {
  const plan = planRelease(input({ prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(9)] }))
  assert.equal(plan.total, 9)
  assert.equal(plan.shouldRelease, false)
})

test('a repeated PR number keeps its first sighting, so the feature count is stable', () => {
  const plan = planRelease(
    input({
      prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10), merged(1, 'fix: the same PR seen again')],
    }),
  )
  assert.equal(plan.total, 10)
  assert.equal(plan.features, 5)
  assert.equal(plan.shouldRelease, true)
})

test('a revert-only PR counts in the total and not in the features', () => {
  const plan = planRelease(
    input({
      prs: [
        feat(1),
        feat(2),
        feat(3),
        feat(4),
        feat(5),
        fix(6),
        fix(7),
        fix(8),
        fix(9),
        merged(10, 'revert: undo the thing'),
        merged(11, 'Revert "feat: thing 1"'),
      ],
    }),
  )
  assert.equal(plan.total, 11)
  assert.equal(plan.features, 5)
  assert.equal(plan.shouldRelease, true)
})

test('reverting a feature does not free its feature slot', () => {
  const plan = planRelease(
    input({
      prs: [feat(1), feat(2), feat(3), feat(4), fix(5), fix(6), fix(7), fix(8), fix(9), merged(10, 'revert: undo feat 1')],
    }),
  )
  assert.equal(plan.total, 10)
  assert.equal(plan.features, 4)
  assert.equal(plan.shouldRelease, false)
})

test('a revert carrying the enhancement label still counts as a revert, not a feature', () => {
  const plan = planRelease(
    input({
      prs: [feat(1), feat(2), feat(3), feat(4), fix(5), fix(6), fix(7), fix(8), fix(9), merged(10, 'revert: undo the rollout', ['enhancement'])],
    }),
  )
  assert.equal(plan.total, 10)
  assert.equal(plan.features, 4)
  assert.equal(plan.shouldRelease, false)
})

test('the previous release PR is not counted in the total', () => {
  const plan = planRelease(
    input({
      lastTag: 'v0.2.4',
      prs: [merged(1, 'release: v0.2.4'), feat(2), feat(3), feat(4), feat(5), feat(6), fix(7), fix(8), fix(9), fix(10)],
    }),
  )
  assert.equal(plan.total, 9)
  assert.equal(plan.shouldRelease, false)
})

test('a package version that disagrees with the last tag fails closed', () => {
  const plan = planRelease(input({ packageVersion: '0.2.5', prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10)] }))
  assert.equal(plan.shouldRelease, false)
  assert.equal(plan.reason, 'version-tag-mismatch')
})

test('a log/API disagreement adds a reason line and does not block the night', () => {
  const plan = planRelease(
    input({
      prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10)],
      crossCheck: { logPrNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99] },
    }),
  )
  assert.equal(plan.shouldRelease, true)
  assert.match(plan.reason, /log-only-prs=99/)
})

test('PRs merged before the last tag are ignored when the tag time is known', () => {
  const plan = planRelease(
    input({
      lastTagCommittedAt: '2026-11-06T00:00:00Z',
      prs: [merged(1, 'feat: before the tag', [], '2026-11-05T00:00:00Z'), feat(2), feat(3), feat(4), feat(5), feat(6), fix(7), fix(8), fix(9), fix(10)],
    }),
  )
  assert.equal(plan.total, 9)
  assert.equal(plan.shouldRelease, false)
})

test('an existing next version tag blocks the release', () => {
  const plan = planRelease(
    input({
      prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10)],
      existingTags: ['v0.2.4', 'v0.3.0'],
    }),
  )
  assert.equal(plan.shouldRelease, false)
  assert.equal(plan.reason, 'tag-exists')
})

test('an unparsable package version fails closed instead of guessing', () => {
  const plan = planRelease(input({ lastTag: 'v0.3', packageVersion: '0.3' }))
  assert.equal(plan.shouldRelease, false)
  assert.equal(plan.reason, 'invalid-version')
})

test('the next version is always the next minor, never a patch bump', () => {
  const ten = [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10)]
  assert.equal(planRelease(input({ prs: ten })).nextVersion, '0.3.0')
  assert.equal(planRelease(input({ lastTag: 'v1.9.3', packageVersion: '1.9.3', existingTags: ['v1.9.3'], prs: ten })).nextVersion, '1.10.0')
})

test('the plan is pure: the same input twice gives the same output and the input is not mutated', () => {
  const source = input({ prs: [feat(1), feat(2), feat(3), feat(4), feat(5), fix(6), fix(7), fix(8), fix(9), fix(10)] })
  const snapshot = JSON.stringify(source)
  const first = planRelease(source)
  const second = planRelease(source)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(source), snapshot)
})
