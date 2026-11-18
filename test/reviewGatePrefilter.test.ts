import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseConclusion } from '../scripts/lib/review-gate.mjs'

// #931: the comment prefilter and the verdict parser must accept the same
// shapes. They drifted once — the workflow listed `Review`/`review` while the
// parser matches case-insensitively — so a `## REVIEW — PASS` comment started no
// job and the gate never ran. The fix removes the shape test from the job's
// `if:` and lets the guard step call the parser itself, so there is one
// expression rather than two; this test reads the workflow and pins that.

const WORKFLOW = readFileSync(new URL('../.github/workflows/review-gate.yml', import.meta.url), 'utf8')

function jobBlock(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:`)
  assert.notEqual(start, -1, `the workflow has a ${name} job`)
  const rest = WORKFLOW.slice(start + 1)
  const next = /^\s{2}[a-z][\w-]*:$/m.exec(rest.slice(1))
  return next === null ? rest : rest.slice(0, next.index + 1)
}

const COMMENT_JOB = jobBlock('review-gate-comment')

function ifLine(job: string): string {
  const match = /^\s{4}if: (.+)$/m.exec(job)
  assert.notEqual(match, null, 'the comment job carries an if: condition')
  return match![1]!
}

function bodyLiterals(condition: string): string[] {
  return [...condition.matchAll(/contains\(github\.event\.comment\.body,\s*'([^']*)'\)/g)].map((match) => match[1]!)
}

// What the job decides, given a comment body: with a body-shape filter in the
// `if:` it is that filter; without one the guard step runs and its answer is the
// parser's, provided the step actually calls the parser.
function prefilterAccepts(body: string): boolean {
  const literals = bodyLiterals(ifLine(COMMENT_JOB))
  if (literals.length > 0) return literals.some((literal) => body.includes(literal))
  assert.match(COMMENT_JOB, /parseConclusion/, 'without a body filter in if:, the guard step is what decides, and it must use the parser')
  return true
}

// The shapes the parser accepts, one per branch of its two expressions, plus the
// case variants that broke parity.
// The heading form carries its sha anywhere in the body, so these samples do too.
const SHA = '1f6f091b470524ca6e10998e3065e7b4d19dc8de'
const ACCEPTED = [
  `Verdict: PASS at ${SHA}`,
  'verdict: REQUEST_CHANGES at abc1234',
  `## Review — PASS\n\nVerified ${SHA}`,
  `## review - FAIL\n\nVerified ${SHA}`,
  `## REVIEW — PASS\n\nVerified ${SHA}`,
  `## ReView: INC\n\nVerified ${SHA}`,
]

test('the comment prefilter starts a job for every shape the parser accepts', () => {
  for (const body of ACCEPTED) {
    assert.notEqual(parseConclusion(body), null, `the parser accepts ${JSON.stringify(body)}`)
    assert.equal(prefilterAccepts(body), true, `the prefilter must not skip ${JSON.stringify(body)}`)
  }
})

test('the comment job keeps its cheap guards and holds no second shape test', () => {
  const condition = ifLine(COMMENT_JOB)
  assert.match(condition, /github\.event_name == 'issue_comment'/, 'the job stays comment-only')
  assert.match(condition, /github\.event\.issue\.pull_request != null/, 'and pull-request-only')
  assert.match(condition, /author_association/, 'and restricted to an owner, member or collaborator')
  const literals = bodyLiterals(condition)
  assert.deepEqual(literals, [], 'a body-word filter in if: is a second verdict definition; the parser must be the only one')
})

test('the guard runs against the base tree, so a pull request cannot weaken it', () => {
  const checkout = COMMENT_JOB.indexOf('actions/checkout@')
  const guard = COMMENT_JOB.indexOf('parseConclusion')
  assert.notEqual(checkout, -1, 'the comment job checks the repository out')
  assert.notEqual(guard, -1, 'the guard step reads the parser')
  assert.ok(checkout < guard, 'the checkout precedes the guard, so it imports the default branch rather than the pull request')
  assert.match(COMMENT_JOB.slice(checkout, guard), /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, 'the checkout names the default branch explicitly')
})
