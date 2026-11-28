import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  commentDecision,
  decisionText,
  headMoveDecision,
  isMaintainer,
  openRequestAt,
  parseReason,
  reportLine,
  rerunAllowed,
} from '../scripts/lib/rereview.mjs'

// #1274: a change request has no re-review trigger. The decision is a pure
// function of the pull request's refs and thread, so the six shapes the card
// names are asserted as exact strings, and the same strings are what the workflow
// log prints.

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)

function changes(sha: string, at = '2026-11-28T05:24:14Z') {
  return { state: 'CHANGES_REQUESTED', commit_id: sha, submitted_at: at }
}

function approved(sha: string, at = '2026-11-28T07:30:00Z') {
  return { state: 'APPROVED', commit_id: sha, submitted_at: at }
}

function botRequest(head: string, at = '2026-11-28T07:00:00Z') {
  return {
    user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `Written-by: Fledge Platform Dev-1\n\nRe-review: the arch ratchet finding is fixed — head ${head}`,
    created_at: at,
  }
}

test('a head move after a change request asks for one re-review', () => {
  const decision = headMoveDecision({ head: NEW, reviews: [changes(OLD)], hasOpenRequest: false })
  assert.equal(decision.kind, 'request')
  assert.equal(decision.code, 'head-moved')
  assert.equal(decisionText(decision), `request head=${NEW}`)
})

test('a maintainer Re-review comment asks at the unchanged head', () => {
  const decision = commentDecision({
    head: NEW,
    association: 'OWNER',
    body: `Re-review: the lint finding is fixed — head ${NEW}`,
    hasOpenRequest: false,
  })
  assert.equal(decision.kind, 'request')
  assert.equal(decision.code, 'maintainer-request')
  assert.equal(decisionText(decision), `request head=${NEW}`)
})

test('a Re-review comment with an empty reason is refused by name', () => {
  const decision = commentDecision({ head: NEW, association: 'MEMBER', body: 'Re-review:   ', hasOpenRequest: false })
  assert.equal(decision.kind, 'refused')
  assert.equal(decision.code, 'no-reason')
  assert.equal(decisionText(decision), 'refused: no reason')
})

test('a comment from someone who is not a maintainer is refused by name', () => {
  const decision = commentDecision({ head: NEW, association: 'NONE', body: `Re-review: please — head ${NEW}`, hasOpenRequest: false })
  assert.equal(decision.kind, 'refused')
  assert.equal(decision.code, 'not-a-maintainer')
  assert.equal(decisionText(decision), 'refused: not a maintainer')
})

test('a second request at the same head is a no-op, not a second conclusion', () => {
  const decision = headMoveDecision({ head: NEW, reviews: [changes(OLD)], hasOpenRequest: true })
  assert.equal(decision.kind, 'no-op')
  assert.equal(decision.code, 'open-request')
  assert.equal(decisionText(decision), `no-op: open request at ${NEW}`)
})

test('a head move with no change request at its base is a no-op', () => {
  const decision = headMoveDecision({ head: NEW, reviews: [], hasOpenRequest: false })
  assert.equal(decision.kind, 'no-op')
  assert.equal(decision.code, 'no-change-request')
  assert.equal(decisionText(decision), 'no-op: no change request')
})

test('a verdict at the head answers the request, so the next trigger asks again', () => {
  assert.equal(openRequestAt([botRequest(NEW)], [approved(NEW)], NEW), null)
  assert.equal(openRequestAt([botRequest(NEW)], [], NEW), NEW)
})

test('a COMMENTED review does not answer: only a verdict state closes a request', () => {
  const codeql = { user: { login: 'github-advanced-security[bot]', type: 'Bot' }, state: 'COMMENTED', commit_id: NEW, submitted_at: '2026-11-28T09:00:00Z' }
  const inlineOnly = { user: { login: 'HugoXK', type: 'User' }, state: 'COMMENTED', commit_id: NEW, submitted_at: '2026-11-28T09:00:00Z' }
  assert.equal(openRequestAt([botRequest(NEW)], [codeql], NEW), NEW)
  assert.equal(openRequestAt([botRequest(NEW)], [inlineOnly], NEW), NEW)
  assert.equal(openRequestAt([botRequest(NEW)], [codeql, approved(NEW, '2026-11-28T09:30:00Z')], NEW), null)
})

test('a change request already at the head is a no head move, not a new request', () => {
  const decision = headMoveDecision({ head: NEW, reviews: [changes(NEW)], hasOpenRequest: false })
  assert.equal(decision.kind, 'no-op')
  assert.equal(decision.code, 'no-head-move')
  assert.equal(decisionText(decision), 'no-op: no head move')
})

test('the marker is accepted on its own line anywhere in the body, as the workflow guard accepts it', () => {
  const body = `Written-by: HugoXK\n\ncontext first\nRe-review: the blocker is fixed — head ${NEW}`
  assert.equal(parseReason(body), 'the blocker is fixed')
  const decision = commentDecision({ head: NEW, association: 'OWNER', body, hasOpenRequest: false })
  assert.equal(decisionText(decision), `request head=${NEW}`)
})

test('only the bot request comment opens a request; a person typing the word does not', () => {
  const human = { user: { login: 'HugoXK', type: 'User' }, body: `Re-review: looks fine — head ${NEW}`, created_at: '2026-11-28T07:00:00Z' }
  assert.equal(openRequestAt([human], [], NEW), null)
})

test('the reason is the marker line without its prefix, and a bare marker has none', () => {
  assert.equal(parseReason(`Written-by: X\n\nRe-review: the blocker is fixed — head ${NEW}`), 'the blocker is fixed')
  assert.equal(parseReason('Re-review:'), null)
  assert.equal(parseReason('no marker here'), null)
  assert.equal(isMaintainer('COLLABORATOR'), true)
  assert.equal(isMaintainer('CONTRIBUTOR'), false)
})

test('the workflow guard and the library accept the same marker contract', () => {
  const workflow = readFileSync(new URL('../.github/workflows/rereview.yml', import.meta.url), 'utf8')
  assert.ok(workflow.includes("contains(github.event.comment.body, 'Re-review:')"), 'the workflow guard must use the same marker contract as scripts/lib/rereview.mjs')
  assert.equal(workflow.includes('startsWith(github.event.comment.body'), false, 'the workflow guard must not require the marker on the first line: the library accepts it on its own line')
})

test('the re-run ceiling is one re-run: attempt 1 only, attempt 2 and above are not re-run', () => {
  assert.equal(rerunAllowed(1), true)
  assert.equal(rerunAllowed(2), false)
  assert.equal(rerunAllowed(3), false)
  assert.equal(rerunAllowed(0), false)
  assert.equal(rerunAllowed(Number.NaN), false)
})

test('the dry-run line names the pull request, the head and the decision', () => {
  const decision = headMoveDecision({ head: NEW, reviews: [changes(OLD)], hasOpenRequest: false })
  assert.equal(reportLine({ number: 7, head: NEW, decision }), `PR 7 head=${NEW} decision=request reason=head-moved`)
})
