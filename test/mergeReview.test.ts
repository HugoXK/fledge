import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewMergeBlock } from '../src/lib/mergeReview.js'

test('a changes_requested work item blocks an automatic merge', () => {
  assert.deepEqual(reviewMergeBlock({ state: 'changes_requested', score: 95, minScore: 80 }), { kind: 'changes_requested' })
})

test('a score below the threshold blocks an automatic merge', () => {
  assert.deepEqual(reviewMergeBlock({ state: 'pr_ready', score: 79, minScore: 80 }), { kind: 'score', score: 79, minScore: 80 })
})

test('a score at the threshold and a missing score do not block', () => {
  assert.equal(reviewMergeBlock({ state: 'pr_ready', score: 80, minScore: 80 }), null)
  assert.equal(reviewMergeBlock({ state: 'pr_ready', score: null, minScore: 80 }), null)
  assert.equal(reviewMergeBlock({ state: undefined, score: undefined, minScore: 80 }), null)
})
