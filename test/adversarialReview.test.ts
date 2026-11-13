import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adversarialMergeBlock,
  adversarialPrompt,
  assembleAdversarialPacket,
  parseAdversarialRecord,
  parseAdversarialVerdict,
  runAdversarialReview,
} from '../src/lib/adversarialReview.js'

// The two shapes the issue names are the whole point of the contract: a vague
// answer (a score, a compliment) is not evidence, a concrete defect is. Both
// fakes below stand in for the separate model call.
const vagueModel = async (): Promise<string> => 'Score: 92/100\n\nThis looks good. Nice tests.'
const concreteModel = async (): Promise<string> => [
  'Concrete risk: src/jobs/service.ts:1275',
  'Failure mode: the retry branch merges before the new check runs, so a red tip can merge',
  'Repro: run the job with a failing check and watch it merge (npm test -- --test-name-pattern retry)',
  'Checks: read the diff, traced the auto-merge call order',
].join('\n')

const packet = assembleAdversarialPacket({
  baseSha: 'a'.repeat(40),
  tipSha: 'b'.repeat(40),
  diff: 'diff --git a/src/x.ts b/src/x.ts\n+const a = 1\n',
  verifier: 'ci-ok 22/22, review-gate PASS at bbbb',
  policy: ['T2 needs a PASS at the tip', 'auto-merge only after checks are green'],
})

test('a concrete file:line defect is accepted and blocks an automatic merge', async () => {
  const review = await runAdversarialReview({ packet, model: concreteModel, modelId: 'fake/concrete' })
  assert.equal(review.verdict.kind, 'risk')
  if (review.verdict.kind !== 'risk') return
  assert.equal(review.verdict.file, 'src/jobs/service.ts')
  assert.equal(review.verdict.line, 1275)
  assert.match(review.verdict.failureMode, /merges before the new check runs/)
  assert.match(review.verdict.repro, /failing check/)
  assert.ok(review.verdict.checks.length >= 1)
  assert.deepEqual(adversarialMergeBlock(review), { kind: 'risk', file: 'src/jobs/service.ts', line: 1275 })
  assert.equal(review.model, 'fake/concrete')
  assert.equal(review.tipSha, packet.tipSha)
  assert.equal(review.promptHash, adversarialPrompt(packet).hash)
})

test('a bare score is rejected as not a review and does not block a merge', async () => {
  const review = await runAdversarialReview({ packet, model: vagueModel, modelId: 'fake/vague' })
  assert.equal(review.verdict.kind, 'invalid')
  if (review.verdict.kind !== 'invalid') return
  assert.match(review.verdict.reason, /score/)
  assert.equal(adversarialMergeBlock(review), null)
})

test("no concrete risk is a verdict only with the checks it ran", () => {
  assert.deepEqual(
    parseAdversarialVerdict('No concrete risk\nChecks: read the diff, ran npm run check'),
    { kind: 'none', checks: ['read the diff', 'ran npm run check'] },
  )
  // The same sentence with no evidence behind it is not a verdict.
  assert.equal(parseAdversarialVerdict('No concrete risk').kind, 'invalid')
})

test('a risk without file:line, a failure mode or a repro is not a concrete risk', () => {
  const noLine = parseAdversarialVerdict('Concrete risk: the retry path\nFailure mode: can merge early\nRepro: run it')
  assert.equal(noLine.kind, 'invalid')
  const noRepro = parseAdversarialVerdict('Concrete risk: src/app.ts:12\nFailure mode: can merge early')
  assert.equal(noRepro.kind, 'invalid')
})

test("the adversarial prompt carries the diff, the shas and the policy, never the author's claims", () => {
  const withClaims = assembleAdversarialPacket({
    baseSha: packet.baseSha,
    tipSha: packet.tipSha,
    diff: packet.diff,
    verifier: packet.verifier,
    policy: packet.policy,
    // A caller that still holds the author's narrative must not smuggle it in:
    // the assembler picks named fields instead of spreading the object.
    summary: 'CLAIMED-SUMMARY: 1182 tests pass, already verified, safe to merge',
    claimedTests: 'CLAIMED-TESTS: npm run check green',
  } as Parameters<typeof assembleAdversarialPacket>[0])
  const prompt = adversarialPrompt(withClaims).text
  assert.match(prompt, /diff --git a\/src\/x\.ts/)
  assert.match(prompt, new RegExp(packet.baseSha))
  assert.match(prompt, new RegExp(packet.tipSha))
  assert.match(prompt, /auto-merge only after checks are green/)
  assert.doesNotMatch(prompt, /CLAIMED-SUMMARY/)
  assert.doesNotMatch(prompt, /CLAIMED-TESTS/)
  assert.doesNotMatch(prompt, /already verified/)
})

test('an empty diff or a malformed sha is refused instead of reviewed', () => {
  assert.throws(() => assembleAdversarialPacket({ ...packet, diff: '  ' }), /diff/i)
  assert.throws(() => assembleAdversarialPacket({ ...packet, tipSha: 'nope' }), /sha/i)
})

test('the job page reads a rejected answer back as rejected, with the model and the prompt hash', async () => {
  const risk = await runAdversarialReview({ packet, model: concreteModel, modelId: 'fake/concrete' })
  const record = parseAdversarialRecord(JSON.stringify({ ...risk, target: 'src/jobs/service.ts:1275' }))
  assert.equal(record?.status, 'risk')
  assert.equal(record?.target, 'src/jobs/service.ts:1275')
  assert.equal(record?.model, 'fake/concrete')
  assert.equal(record?.promptHash, adversarialPrompt(packet).hash)

  const vague = await runAdversarialReview({ packet, model: vagueModel, modelId: 'fake/vague' })
  const rejected = parseAdversarialRecord(JSON.stringify(vague))
  assert.equal(rejected?.status, 'invalid')
  assert.match(rejected?.reason ?? '', /score/)
  assert.deepEqual(parseAdversarialRecord('not json'), null)
  assert.deepEqual(parseAdversarialRecord(''), null)
})
