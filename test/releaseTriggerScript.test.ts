import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatchRelease } from '../scripts/trigger-release.mjs'

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
