import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { policyIdentity, parsePolicyIdentity, refreshDecision } from '../scripts/lib/ci-ok-refresh.mjs'
import { REQUIRED_JOBS } from '../scripts/ci-ok.mjs'
import { checkRunPayload } from '../scripts/lib/ci-ok-run.mjs'

// #1116: a green `ci-ok` is a statement about the policy of the moment it was
// computed. Nothing recomputes it when the required set grows, so a merge can use
// a verdict that outlived its policy — and a head that renames `name: CI` never
// gets a publisher verdict at all (#1108 hole 2). The out-of-band scanner on
// `push: [main]` answers both: it enumerates open pull request heads and
// publishes a red `ci-ok` where the newest *published* verdict was computed under
// a different policy, or where a finished CI run has no published verdict at all.
//
// The fixture is the measured `#1016` shape: head `c5f7860b…` carries a green
// `ci-ok` computed when `mock-check` did not exist, and `mock-check` is required
// now.
//
// The tree the fixtures describe is the live one: `.github/workflows/ci.yml:808`
// still declares a job named `ci-ok`, so two check runs can carry that name after
// CI completes — the in-run aggregate (no policy line, and not evidence since
// #855) and the verdict `ci-ok-publish.yml` writes (policy line). Only the second
// one is a verdict; the aggregate is what the old fixture mistook for one.

const GATE = '0123456789abcdef0123456789abcdef01234567'
// The required list as it stood when that verdict was computed: everything but
// `mock-check`, which reached `main` afterwards.
const BEFORE = REQUIRED_JOBS.filter((name) => name !== 'mock-check')

function identity(required = REQUIRED_JOBS, gateSha = GATE) {
  return policyIdentity({ required, gateSha })
}

function summaryOf(policy: { text: string }, required: string[] = REQUIRED_JOBS) {
  return [
    "Verdict computed from the default branch's copy of the gate, not from the pull request's `ci.yml` (run #134914778359).",
    '',
    policy.text,
    '',
    '```',
    ...required.map((name) => `${name}: success`),
    '```',
  ].join('\n')
}

/** A verdict published by `ci-ok-publish.yml`: it names the policy it used. */
function check(over = {}) {
  return {
    name: 'ci-ok',
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-11-18T15:31:14Z',
    output: { title: 'every required job passed (19 required)', summary: summaryOf(identity(BEFORE), BEFORE) },
    ...over,
  }
}

/**
 * The aggregate job in `.github/workflows/ci.yml`: a second producer of the same
 * check name, finished before the publisher, with no policy line (#855 removed
 * it as evidence; the publisher's verdict is the only verdict).
 */
function aggregate(over = {}) {
  return {
    name: 'ci-ok',
    status: 'completed',
    conclusion: 'success',
    completed_at: '2026-11-18T15:30:40Z',
    output: { title: 'ci-ok', summary: '' },
    ...over,
  }
}

test('#1116: the policy identity is the required list and the gate blob, and it round-trips', () => {
  const policy = identity()
  assert.match(policy.text, /^policy: required=[0-9a-f]{12} gate=0123456789abcdef0123456789abcdef01234567$/)
  assert.deepEqual(parsePolicyIdentity(policy.text), { requiredHash: policy.requiredHash, gateSha: GATE })
  // The same list in a different order is a different policy: order is the
  // publisher's own, and a reorder changes which job the reader sees first.
  const reordered = identity([...REQUIRED_JOBS].reverse())
  assert.notEqual(reordered.requiredHash, policy.requiredHash)
  // Adding a required job changes it; that is the whole point of the hash.
  assert.notEqual(identity([...REQUIRED_JOBS, 'extra-check']).requiredHash, policy.requiredHash)
  assert.equal(parsePolicyIdentity('no policy line here'), null)
})

test('#1116: a verdict computed before mock-check became required stops being satisfying', () => {
  const decision = refreshDecision({
    headSha: 'c5f7860b103f8fb2e43c0c323318db42e945f01f',
    policy: identity(),
    checks: [check()],
    ciCompleted: true,
    publisherPending: false,
  })
  assert.equal(decision.publish, true)
  assert.equal(decision.reason, 'stale-policy')
  assert.match(decision.detail, /mock-check/, 'the detail names the job the stale verdict never ran')
  assert.match(decision.detail, new RegExp(identity().requiredHash))
  assert.match(decision.detail, new RegExp(identity(BEFORE).requiredHash))
})

test('#1116: a verdict computed against the current policy stays green, with no red published', () => {
  const decision = refreshDecision({
    headSha: 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00',
    policy: identity(),
    checks: [check({ output: { title: 'every required job passed (20 required)', summary: summaryOf(identity()) } })],
    ciCompleted: true,
    publisherPending: false,
  })
  assert.equal(decision.publish, false)
  assert.equal(decision.reason, 'current-policy')
})

test('#1116: the aggregate alone is not a verdict while the publisher is queued, so a legal head is left alone', () => {
  // The window the seat reproduced: CI has completed (so the aggregate exists)
  // and `ci-ok-publish.yml` has not written its verdict yet. The aggregate is the
  // newest `ci-ok`, but it names no policy and is not evidence, so judging it
  // would redden a head that is doing exactly the right thing.
  const decision = refreshDecision({
    headSha: '7c88dc7d19a6299bb7292a1a43c416c38fe9d86a',
    policy: identity(),
    checks: [aggregate()],
    ciCompleted: true,
    publisherPending: true,
  })
  assert.equal(decision.publish, false, 'no red may be published while the publisher run is queued or in progress')
  assert.equal(decision.reason, 'publisher-pending')
  assert.match(decision.detail, /queued or in progress/)
})

test('#1116: the aggregate is not a verdict, so a head the publisher never reaches is a missing verdict (#1108 hole 2)', () => {
  // The head renamed `name: CI`: `ci-ok-publish.yml` never matched it, no
  // publisher run is queued, and the only `ci-ok` is the in-run aggregate. That
  // is a missing verdict, not a head still warming up — and it is reachable at
  // the live tree rather than only after a `ci-ok-head` rename.
  const decision = refreshDecision({
    headSha: 'bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11',
    policy: identity(),
    checks: [aggregate()],
    ciCompleted: true,
    publisherPending: false,
  })
  assert.equal(decision.publish, true)
  assert.equal(decision.reason, 'no-published-verdict')
  assert.match(decision.detail, /in-run aggregate/, 'the detail says why the ci-ok it found is not a verdict')
})

test('#1116: a head with no ci-ok at all and no pending publisher is the same missing verdict', () => {
  const decision = refreshDecision({
    headSha: 'bb22cc33dd44ee55ff66aa77bb88cc99dd00ee12',
    policy: identity(),
    checks: [],
    ciCompleted: true,
    publisherPending: false,
  })
  assert.equal(decision.publish, true)
  assert.equal(decision.reason, 'no-published-verdict')
})

test('#1116: a head whose CI has not finished yet is left alone', () => {
  const decision = refreshDecision({
    headSha: 'cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22',
    policy: identity(),
    checks: [],
    ciCompleted: false,
    publisherPending: false,
  })
  assert.equal(decision.publish, false)
  assert.equal(decision.reason, 'awaiting-ci')
})

test('#1116: the newest verdict that names a policy is the one judged, not a newer aggregate', () => {
  // After a second CI run its aggregate can be newer than the verdict published
  // for the first run. Filtering by policy line keeps the comparison on the
  // evidence, so a current-policy verdict is not outranked by a policy-less one.
  const decision = refreshDecision({
    headSha: 'dd44ee55ff66aa77bb88cc99dd00ee11ff223344',
    policy: identity(),
    checks: [
      check({ completed_at: '2026-11-18T15:31:14Z', output: { title: 'current', summary: summaryOf(identity()) } }),
      aggregate({ completed_at: '2026-11-19T09:00:00Z' }),
    ],
    ciCompleted: true,
    publisherPending: false,
  })
  assert.equal(decision.publish, false)
  assert.equal(decision.reason, 'current-policy')
})

test('#1116: the scanner is idempotent: its own red already carries the current policy', () => {
  const decision = refreshDecision({
    headSha: 'ee55ff66aa77bb88cc99dd00ee11ff2233445566',
    policy: identity(),
    checks: [
      check({
        conclusion: 'failure',
        completed_at: '2026-11-19T12:00:00Z',
        output: { title: 'computed under a superseded required set', summary: summaryOf(identity()) },
      }),
    ],
    ciCompleted: true,
    publisherPending: false,
  })
  assert.equal(decision.publish, false)
  assert.equal(decision.reason, 'already-refreshed')
})

test('#1116: the publisher writes the policy it computed under, so a later change is a hash mismatch', () => {
  const result = { needs: {}, lines: ['lint: success'], problems: [], ok: true }
  const withPolicy = checkRunPayload({ headSha: 'a'.repeat(40), result, runId: 7, policy: identity() })
  assert.match(withPolicy.output.summary, new RegExp(`^${identity().text}$`, 'm'))
  assert.deepEqual(parsePolicyIdentity(withPolicy.output.summary), { requiredHash: identity().requiredHash, gateSha: GATE })
  // A verdict that names no policy is still publishable (the field is optional for
  // the legacy producers), but the scanner does not treat it as a verdict.
  const withoutPolicy = checkRunPayload({ headSha: 'a'.repeat(40), result, runId: 8 })
  assert.equal(parsePolicyIdentity(withoutPolicy.output.summary), null)
  assert.throws(() => checkRunPayload({ headSha: 'a'.repeat(40), result, runId: 9, policy: { requiredHash: 'deadbeefcafe', gateSha: GATE, text: 'policy: nonsense' } }), /well-formed policy line/)
})

test('#1116: the scanner is out of band on push-to-main, least privilege, and runs the tested script', () => {
  const workflow = readFileSync('.github/workflows/ci-ok-refresh.yml', 'utf8')
  assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:/m)
  assert.doesNotMatch(workflow, /pull_request_target/)
  assert.match(workflow, /checks: write/)
  assert.match(workflow, /run: node scripts\/ci-ok-refresh\.mjs --repo \./)
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, 'the gate is the default branch, never the pull request tree')
  const unpinned = [...workflow.matchAll(/uses:\s*(\S+)/g)].filter((match) => !/@[0-9a-f]{40}$/.test(match[1] ?? ''))
  assert.deepEqual(unpinned.map((match) => match[1]), [], 'every action is pinned to a full commit sha')

  const script = readFileSync('scripts/ci-ok-refresh.mjs', 'utf8')
  assert.match(script, /CI_WORKFLOW_PATH = '\.github\/workflows\/ci\.yml'/, 'the workflow is recognised by path, because its name is the head\'s to change')
  assert.match(script, /PUBLISH_WORKFLOW_PATH = '\.github\/workflows\/ci-ok-publish\.yml'/, 'the publisher is recognised by the same path rule')
  assert.match(script, /check-runs\?check_name=ci-ok/, 'the head is judged on its published ci-ok runs')
  assert.match(script, /publisherPending/, 'the sweep tells the decision whether a publisher run is in flight')
  assert.match(script, /method: 'POST', body: JSON\.stringify\(payload\)/, 'the sweep publishes check runs and nothing else')
  assert.doesNotMatch(script, /--force|git push|pulls\/\$\{[^}]*\}\/merge/, 'it must not push or merge')
})
