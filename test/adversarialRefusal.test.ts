import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_DIFF_CHARS,
  adversarialPrompt,
  assembleAdversarialPacket,
} from '../src/lib/adversarialReview.js'

// #556 Slice A: a diff that was cut is not a reviewed diff. The packet has to
// say so, and the prompt has to say so, because a model that is handed a partial
// diff and told nothing answers "No concrete risk" with the same confidence it
// would after reading the whole change.
const sha = (letter: string): string => letter.repeat(40)

const real = 'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-const a = 0\n+const a = 1\n'
const decoy = 'diff --git a/src/decoy.ts b/src/decoy.ts\n@@ -1 +1 @@\n+' + 'x'.repeat(MAX_DIFF_CHARS)

function packet(diff: string) {
  return assembleAdversarialPacket({
    baseSha: sha('a'),
    tipSha: sha('b'),
    diff,
    verifier: 'ci-ok 22/22, review-gate PASS at bbbb',
    policy: ['T2 needs a PASS at the tip', 'auto-merge only after checks are green'],
  })
}

test('the cut point is exported so the caller can say what it left out', () => {
  // Reading the cut is what lets the pass report omitted bytes instead of
  // guessing, and a private constant forced the caller to re-derive it.
  assert.equal(typeof MAX_DIFF_CHARS, 'number')
  assert.equal(MAX_DIFF_CHARS, 60_000)
})

test('a diff longer than the cut is marked truncated with the bytes it lost', () => {
  const long = packet(real + decoy)
  assert.equal(long.truncated, true, 'a cut diff is reported as truncated')
  assert.ok(long.omittedBytes > 0, 'the packet says how many bytes the cut dropped')
  assert.equal(long.diff.length, MAX_DIFF_CHARS)
  assert.ok(long.omittedFiles.includes('src/decoy.ts'), 'the omitted file is named, not just counted')
})

test('a diff that fits is not marked truncated and names nothing as omitted', () => {
  const short = packet(real)
  assert.equal(short.truncated, false)
  assert.equal(short.omittedBytes, 0)
  assert.deepEqual(short.omittedFiles, [])
})

test('the prompt tells the model the diff is partial, so it cannot answer "no risk"', () => {
  const partial = adversarialPrompt(packet(real + decoy)).text
  assert.match(partial, /partial/i)
  assert.match(partial, /truncated/i)
  assert.match(partial, /src\/decoy\.ts/)
  assert.match(partial, /cannot judge|do not answer "No concrete risk"/i)

  // The whole-diff prompt must not carry the caveat, or every review reads as
  // partial and the caveat stops meaning anything.
  const whole = adversarialPrompt(packet(real)).text
  assert.doesNotMatch(whole, /truncated/i)
})
