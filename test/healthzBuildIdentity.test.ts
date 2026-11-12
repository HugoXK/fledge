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

// #236: `/healthz` is unauthenticated, so naming the live commit there is a
// timing oracle between "the security fix merged" and "it is deployed". The two
// identity fields are served only on the same rule `/metrics` uses; a caller
// without the credential gets no key at all — `unknown` already means "this
// build carries no stamp", so reusing it for "not authorised" would make an
// unstamped production build and a denied caller indistinguishable.
const PUBLIC_PEER = '203.0.113.9'

async function healthzRequest(overrides: Partial<Config> = {}, options: { remoteAddress?: string; headers?: Record<string, string>; url?: string } = {}) {
  const built = await build(overrides)
  try {
    const response = await built.app.inject({ method: 'GET', url: '/healthz', ...options })
    assert.equal(response.statusCode, 200, '/healthz is a liveness probe: it must never refuse a caller')
    return response.json() as Record<string, unknown>
  } finally {
    await built.close()
  }
}

test('a caller without the bearer gets no `commit` or `builtAt` key at all', async () => {
  const payload = await healthzRequest({ metrics: { token: 'metrics-secret' } }, { remoteAddress: PUBLIC_PEER })
  assert.deepEqual(Object.keys(payload).sort(), ['ok', 'service', 'time', 'version'])
  assert.equal(payload.ok, true, 'the liveness answer itself stays public')
  assert.equal(payload.commit, undefined, 'the commit must be absent, not `unknown` and not empty')
  assert.equal(payload.builtAt, undefined, 'the build time must be absent, not `unknown` and not empty')
})

test('a configured METRICS_TOKEN bearer still sees both identity fields', async () => {
  const payload = await healthzRequest(
    { metrics: { token: 'metrics-secret' } },
    { remoteAddress: PUBLIC_PEER, headers: { authorization: 'Bearer metrics-secret' } },
  )
  assert.equal(typeof payload.commit, 'string')
  assert.equal(typeof payload.builtAt, 'string')
  assert.match(String(payload.commit), /^(unknown|[0-9a-f]{12})$/)
  assert.match(String(payload.builtAt), /^(unknown|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/)
})

test('once a token is configured, loopback also needs it', async () => {
  const loopback = await healthzRequest({ metrics: { token: 'metrics-secret' } })
  assert.equal(loopback.commit, undefined, 'a configured token closes the development fallback, exactly as on /metrics')
})

test('a wrong bearer is refused', async () => {
  const wrongBearer = await healthzRequest(
    { metrics: { token: 'metrics-secret' } },
    { remoteAddress: PUBLIC_PEER, headers: { authorization: 'Bearer nope' } },
  )
  assert.equal(wrongBearer.commit, undefined, 'a wrong token must not reveal the build identity')
})

// The predicate reads only the `Authorization` header. A cache or proxy in front
// of `/healthz` must not be able to turn a credential in the query string into
// one, so the case sends the real query string rather than a wrong header.
test('the query string never authenticates', async () => {
  const viaQuery = await healthzRequest(
    { metrics: { token: 'metrics-secret' } },
    { remoteAddress: PUBLIC_PEER, url: '/healthz?token=metrics-secret' },
  )
  assert.equal(viaQuery.commit, undefined, 'a token in the query string must not reveal the build identity')
  assert.equal(viaQuery.builtAt, undefined)
})

test('without a token outside production, loopback keeps the development fallback', async () => {
  // Assert the config the app is actually built from, not the harness's
  // NODE_ENV: `npm test` under NODE_ENV=production must not fail this case.
  assert.equal(testConfig().env, 'test', 'the test config builds a non-production app, whatever NODE_ENV says')
  const payload = await healthzRequest()
  assert.equal(typeof payload.commit, 'string', 'a local `npm run dev` build still reports its identity')
  assert.equal(typeof payload.builtAt, 'string')
})
