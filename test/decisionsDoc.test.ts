import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #1223: a decision record is an audit trail, so the comments it cites have to be
// cited as what they are. ADR 0027 gave comment 7067735330 — the Lead's
// transcription of Gate Security's preliminary read, first line
// `Written-by: Fledge Platform Lead` — the seat's authorship, ended its own
// Security line by saying the verdict was still held, and never named the PASS
// that arrived twelve minutes later (7067905546, first line
// `Security: PASS at a38f35d41127`) even though it is the verdict for the
// exemption the record grants. On :132 it labelled 7067505308, an
// `Issue-review: PASS`, as "the seat's review PASS" for a security section.
//
// This is a pin on one record, not a rule for docs/decisions: a general
// "every cited comment id sits beside its Written-by: line" rule cannot be read
// from the tree, because comment bodies are not in it.
//
// The file wraps long lines, so every assertion reads the flattened text, the
// way test/gateDocs.test.ts and test/deployDoc.test.ts do.

const text = readFileSync(
  new URL('../docs/decisions/0027-preapproved-actions.md', import.meta.url),
  'utf8',
).replace(/\s+/g, ' ')

const TRANSCRIPTION = '7067735330'
const TRANSCRIPTION_AUTHOR = 'Written-by: Fledge Platform Lead'
const ISSUE_REVIEW_PASS = '7067505308'
const ISSUE_REVIEW_PASS_FIRST_LINE = 'Issue-review: PASS at issue #1206 body a38f35d41127'
const SECURITY_PASS = '7067905546'
const SECURITY_PASS_FIRST_LINE = 'Security: PASS at a38f35d41127'

/** True when `anchor` occurs within `window` characters of one occurrence of `needle`. */
function near(needle: string, anchor: string, window = 200): boolean {
  for (let from = 0; ; ) {
    const at = text.indexOf(needle, from)
    if (at === -1) return false
    const start = Math.max(0, at - window)
    const end = Math.min(text.length, at + needle.length + window)
    if (text.slice(start, end).includes(anchor)) return true
    from = at + 1
  }
}

test('the record does not give the Lead transcription the seat authorship', () => {
  assert.equal(
    text.includes('the Gate Security seat\u2019s first pass') ||
      text.includes("the Gate Security seat's first pass"),
    false,
    'the record must not call comment 7067735330 the Gate Security seat\'s first pass: it is `Written-by: Fledge Platform Lead`, the transcription of the seat\'s preliminary read (#1223)',
  )
  assert.equal(
    text.includes('Gate Security\u2019s first pass comment') || text.includes("Gate Security's first pass comment"),
    false,
    'the evidence line must not call comment 7067735330 Gate Security\'s first pass comment (#1223)',
  )
  assert.ok(
    near(TRANSCRIPTION, TRANSCRIPTION_AUTHOR),
    `comment ${TRANSCRIPTION} must be named beside its own first line, \`${TRANSCRIPTION_AUTHOR}\` (#1223)`,
  )
})

test('the record does not say the security verdict is still held, and names the PASS', () => {
  assert.equal(
    text.includes('verdict is held'),
    false,
    'the security verdict is not held: comment 7067905546 is `Security: PASS at a38f35d41127`, posted 2026-11-21T19:16:54Z, before the merge (#1223)',
  )
  assert.ok(
    text.includes(SECURITY_PASS),
    `the record must name the Security PASS, comment ${SECURITY_PASS} (#1223)`,
  )
  assert.ok(
    near(SECURITY_PASS, SECURITY_PASS_FIRST_LINE),
    `comment ${SECURITY_PASS} must be named beside its first line, \`${SECURITY_PASS_FIRST_LINE}\` (#1223)`,
  )
})

test('the issue-review PASS is named as the issue review, not as the security review', () => {
  assert.ok(
    text.includes(ISSUE_REVIEW_PASS),
    `the evidence line keeps comment ${ISSUE_REVIEW_PASS} (#1223)`,
  )
  assert.ok(
    near(ISSUE_REVIEW_PASS, ISSUE_REVIEW_PASS_FIRST_LINE),
    `comment ${ISSUE_REVIEW_PASS} must be named beside its first line, \`${ISSUE_REVIEW_PASS_FIRST_LINE}\` — it is the issue review, a different act from the Security PASS (#1223)`,
  )
  assert.equal(
    text.includes('the seat\u2019s review PASS') || text.includes("the seat's review PASS"),
    false,
    'the evidence line must not call the issue-review PASS "the seat\'s review PASS" for a security section (#1223)',
  )
})
