import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import type { Config } from '../src/config.js'
import { MemoryMailer, testConfig } from './helpers.js'

async function build(overrides: Partial<Config> = {}) {
  const config = testConfig(overrides)
  const store = new Store(':memory:')
  return buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
}

async function healthz(overrides: Partial<Config> = {}): Promise<Record<string, unknown>> {
  const built = await build(overrides)
  try {
    const response = await built.app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(response.statusCode, 200)
    return response.json() as Record<string, unknown>
  } finally {
    await built.close()
  }
}

// #183: an instance that reports only `version` cannot name the commit it runs,
// so two different `main` builds are indistinguishable from outside and every
// "is fix X deployed?" question costs a hand-written probe. Silence is the
// failure: both fields must always be present, `unknown` when nothing stamped
// them, so a missing field can never be mistaken for a match.
test('/healthz always names its build: `commit` is a 12-char sha or `unknown`, `builtAt` is a UTC stamp or `unknown`', async () => {
  const payload = await healthz()
  assert.equal(typeof payload.commit, 'string', '`commit` must be present; an absent field reads as a match')
  assert.equal(typeof payload.builtAt, 'string', '`builtAt` must be present')
  assert.match(String(payload.commit), /^(unknown|[0-9a-f]{12})$/)
  assert.match(String(payload.builtAt), /^(unknown|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/)
})

// The contract above is satisfiable by a hardcoded `unknown`; this half is what
// stops that. The values are build-time environment (`GIT_SHA`, `BUILD_TIME`),
// never `git rev-parse` at runtime — the runtime image has no `.git`.
test('the build identity is read from GIT_SHA and BUILD_TIME at boot and echoed verbatim', async () => {
  const saved = { sha: process.env.GIT_SHA, time: process.env.BUILD_TIME }
  try {
    process.env.GIT_SHA = '0123456789ab'
    process.env.BUILD_TIME = '2026-11-10T00:00:00Z'
    const stamped = await healthz()
    assert.equal(stamped.commit, '0123456789ab')
    assert.equal(stamped.builtAt, '2026-11-10T00:00:00Z')

    delete process.env.GIT_SHA
    delete process.env.BUILD_TIME
    const unstamped = await healthz()
    assert.equal(unstamped.commit, 'unknown', 'a local `npm run dev` build has no stamp and must say so')
    assert.equal(unstamped.builtAt, 'unknown')
  } finally {
    if (saved.sha === undefined) delete process.env.GIT_SHA
    else process.env.GIT_SHA = saved.sha
    if (saved.time === undefined) delete process.env.BUILD_TIME
    else process.env.BUILD_TIME = saved.time
  }
})

// A build stamp that arrives in a shape nobody can compare is as good as absent.
// The release workflow passes a full sha; the contract is the 12-char short form.
test('a full 40-char GIT_SHA is shortened to 12 and anything unusable answers `unknown`', async () => {
  const saved = { sha: process.env.GIT_SHA, time: process.env.BUILD_TIME }
  try {
    process.env.GIT_SHA = '0123456789abcdef0123456789abcdef01234567'
    process.env.BUILD_TIME = '2026-11-10T00:00:00Z'
    const shortened = await healthz()
    assert.equal(shortened.commit, '0123456789ab')

    process.env.GIT_SHA = 'not-a-sha'
    process.env.BUILD_TIME = 'yesterday'
    const garbage = await healthz()
    assert.equal(garbage.commit, 'unknown')
    assert.equal(garbage.builtAt, 'unknown')
  } finally {
    if (saved.sha === undefined) delete process.env.GIT_SHA
    else process.env.GIT_SHA = saved.sha
    if (saved.time === undefined) delete process.env.BUILD_TIME
    else process.env.BUILD_TIME = saved.time
  }
})
