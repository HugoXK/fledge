import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireGithubBudget, configureGithubBudget, noteGithubRateLimit, resetGithubBudget } from '../src/lib/githubBudget.js'

test('github budget consumes and pauses a token bucket', async () => {
  resetGithubBudget()
  configureGithubBudget(60000)
  await acquireGithubBudget('token-a', 60000)
  noteGithubRateLimit('token-a', 5)
  const started = Date.now()
  await acquireGithubBudget('token-a', 60000)
  assert.ok(Date.now() - started >= 3)
  resetGithubBudget()
})
