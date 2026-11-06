import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('the review policy pins the required PASS identity', () => {
  const policy = JSON.parse(readFileSync(new URL('../.github/agent/review-policy.json', import.meta.url), 'utf8')) as {
    requiredPass?: string
    requiredPassEmail?: string
    writers?: string[]
    reviewers?: string[]
  }
  assert.equal(policy.requiredPass, 'HugoXK-bot')
  assert.equal(policy.requiredPassEmail, 'hugo2001xk@gmail.com')
  assert.deepEqual(policy.writers, ['HugoXK-bot'])
  assert.deepEqual(policy.reviewers, ['HugoXK-bot'])
})
