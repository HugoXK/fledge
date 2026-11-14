import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireGithubBudget, configureGithubBudget, noteGithubRateLimit, resetGithubBudget } from '../src/lib/githubBudget.js'

// `acquireGithubBudget` waits by sleeping until its bucket refills, so both tests
// below drive it on Node's mock clock: `setTimeout` and `Date` advance together,
// and every assertion reads the gate instead of how long the host took.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('github budget holds a rate-limited token until the retry window expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  resetGithubBudget()
  configureGithubBudget(60000)
  await acquireGithubBudget('token-a', 60000)
  noteGithubRateLimit('token-a', 5)

  let resolved = false
  const pending = acquireGithubBudget('token-a', 60000).then(() => {
    resolved = true
  })
  await flush()
  assert.equal(resolved, false, 'the acquire must wait while the pause is live')
  t.mock.timers.tick(4)
  await flush()
  assert.equal(resolved, false, 'the acquire must not resolve before the pause expires')
  t.mock.timers.tick(1)
  await pending
  assert.equal(resolved, true, 'the acquire resolves once the pause has expired')
  resetGithubBudget()
})

test('github budget refills a spent bucket at the configured rate', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  resetGithubBudget()
  // One token per minute, so the second acquire has to wait a full minute.
  configureGithubBudget(1)
  await acquireGithubBudget('token-b', 1)

  let resolved = false
  const pending = acquireGithubBudget('token-b', 1).then(() => {
    resolved = true
  })
  await flush()
  assert.equal(resolved, false, 'a spent bucket has no token to give')
  t.mock.timers.tick(30000)
  await flush()
  assert.equal(resolved, false, 'half a minute refills half a token')
  t.mock.timers.tick(30000)
  await pending
  assert.equal(resolved, true, 'the full minute refills one token')
  resetGithubBudget()
})
