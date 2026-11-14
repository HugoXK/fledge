import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LOG_EXCERPT_CHARS, boundedLogExcerpt, selectFailedJob, stripAnsi } from '../src/actions/workflowLog.js'

const TOKEN = ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'].join('')

test('a log excerpt is redacted before it is cut and stays bounded', () => {
  const log = `leaked ${TOKEN}\n${'a'.repeat(5000)}\n${'z'.repeat(5000)}`
  const excerpt = boundedLogExcerpt(log)
  assert.equal(excerpt.includes(TOKEN), false)
  assert.match(excerpt, /\[redacted-github-token\]/)
  assert.ok(excerpt.length <= MAX_LOG_EXCERPT_CHARS, `excerpt was ${excerpt.length} characters`)
  assert.ok(excerpt.startsWith('leaked [redacted-github-token]'), 'the head is kept and redacted')
  assert.ok(excerpt.endsWith('z'), 'the tail is kept')
})

test('a short log is returned whole, with ANSI escapes removed', () => {
  const log = `\u001b[31mAssertionError\u001b[0m: expected 1 to equal 2`
  assert.equal(boundedLogExcerpt(log), 'AssertionError: expected 1 to equal 2')
  assert.equal(stripAnsi(log), 'AssertionError: expected 1 to equal 2')
})

test('the failed job is selected by conclusion, not by position', () => {
  const jobs = [
    { id: 1, conclusion: 'success' },
    { id: 2, conclusion: 'failure' },
    { id: 3, conclusion: 'timed_out' },
  ]
  assert.equal(selectFailedJob(jobs)?.id, 2)
  assert.equal(selectFailedJob(jobs.slice(0, 1)), null)
})
