import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatchRelease, dispatchWithProof } from '../scripts/trigger-release.mjs'

function fakeFetch(status: number, body = '') {
  const calls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = []
  return {
    calls,
    async fetchImpl(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
      calls.push({ url, init })
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
      }
    },
  }
}

test('the external trigger dispatches the release workflow with dry_run=false and never returns the token', async () => {
  const fake = fakeFetch(204)
  const result = await dispatchRelease({ repo: 'HugoXK/fledge', token: 'secret-token', fetchImpl: fake.fetchImpl })
  assert.equal(result.ok, true)
  assert.equal(fake.calls.length, 1)
  const call = fake.calls[0]
  assert.ok(call !== undefined)
  assert.ok(call.init.headers !== undefined)
  assert.equal(call.url, 'https://api.github.com/repos/HugoXK/fledge/actions/workflows/daily-release.yml/dispatches')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.authorization, 'Bearer secret-token')
  assert.deepEqual(JSON.parse(call.init.body ?? ''), { ref: 'main', inputs: { dry_run: 'false' } })
  assert.doesNotMatch(JSON.stringify(result), /secret-token/)
})

test('the external trigger refuses a missing repo or token before any request', async () => {
  await assert.rejects(() => dispatchRelease({ repo: '', token: 'x' }), /GITHUB_REPOSITORY/)
  await assert.rejects(() => dispatchRelease({ repo: 'HugoXK/fledge', token: '' }), /GITHUB_TOKEN/)
})

test('a non-2xx dispatch is an error, not a quiet success', async () => {
  const fake = fakeFetch(403, 'Resource not accessible by integration')
  await assert.rejects(
    () => dispatchRelease({ repo: 'HugoXK/fledge', token: 'secret-token', fetchImpl: fake.fetchImpl }),
    /403.*Resource not accessible/,
  )
})

// #881: the host cron runs on a clock that is ~28 minutes ahead (#758), so at its
// `0 2 * * *` the API still reads 01:32Z. Dispatching then creates a release
// commit that belongs to the previous day's slot. The trigger now refuses to
// dispatch before the 02:00Z boundary of its own UTC day; GitHub's `schedule`
// stays the fallback for the slot.
test('#881: the external trigger refuses to dispatch before the 02:00Z boundary', async () => {
  const fake = fakeFetch(204)
  const result = await dispatchWithProof({
    repo: 'HugoXK/fledge',
    token: 'secret-token',
    fetchImpl: fake.fetchImpl,
    clock: () => '2026-11-16T01:32:00Z',
  })
  if (result.ok !== false) assert.fail('an early dispatch must be refused, not dispatched')
  assert.match(result.reason, /before-boundary/)
  assert.equal(fake.calls.length, 0, 'an early dispatch must not create a release commit')
  assert.doesNotMatch(JSON.stringify(result), /secret-token/)
})

test('#881: the same trigger dispatches once the boundary has passed', async () => {
  const fake = fakeFetch(204)
  const result = await dispatchWithProof({
    repo: 'HugoXK/fledge',
    token: 'secret-token',
    fetchImpl: fake.fetchImpl,
    clock: () => '2026-11-16T02:00:00Z',
  })
  assert.equal(result.ok, true)
  assert.equal(fake.calls.filter((call) => call.init.method === 'POST').length, 1)
})
