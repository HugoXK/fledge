import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { resetMetrics } from '../src/lib/metrics.js'
import { json, makeUser, readBody, startFakeServer, testConfig } from './helpers.js'

// #758 slice 2: the measured offset is used, not only reported. Slice 1 made the
// skew visible on /readyz and /metrics; this file pins the decision that follows
// from it — readiness fails above 120 s, `enqueue` refuses before writing a row,
// and the App JWT signs only from a measurement inside the reuse window. The host
// clock cannot be fixed by a commit, so the platform's answer is to stop acting
// on a clock it cannot trust.

const keyDir = mkdtempSync(join(tmpdir(), 'fledge-clock-fail-'))
const keyPath = join(keyDir, 'app.pem')
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
writeFileSync(keyPath, privateKey)

interface Options {
  /** Seconds the faked GitHub clock is behind, i.e. how far ahead the process is. */
  aheadSeconds?: number
  /** Skip the fake server; the App is configured but GitHub is unreachable. */
  unreachable?: boolean
  /** No App on this deployment, as on a self-hosted instance without one. */
  unconfigured?: boolean
}

async function harness(options: Options = {}) {
  const calls: string[] = []
  const server = options.unreachable === true
    ? null
    : await startFakeServer(async (request, response) => {
      await readBody(request)
      calls.push(request.url ?? '')
      const date = new Date(Date.now() - (options.aheadSeconds ?? 5) * 1000).toUTCString()
      if ((request.url ?? '').endsWith('/app')) return json(response, 200, { id: 123456, slug: 'fledge-clock', name: 'fledge-clock' }, { date })
      return json(response, 200, { resources: {} }, { date })
    })
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: server === null ? 'http://127.0.0.1:9' : server.url },
    githubApp: {
      id: options.unconfigured === true ? '' : '123456',
      slug: 'fledge-clock',
      privateKeyPath: options.unconfigured === true ? '' : keyPath,
      webhookSecret: '',
      useUserToken: false,
    },
  })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: undefined, runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'clock-skew-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_clock',
    userId: user.id,
    owner: 'acme',
    name: 'clock',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: 'ship it',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return {
    built,
    store,
    user,
    repo,
    calls,
    stopGithub: async () => {
      if (server !== null) await server.close()
    },
    close: async () => {
      await built.close()
      if (server !== null) await server.close()
    },
  }
}

test('a clock outside the threshold fails readiness, refuses work and refuses to sign', async () => {
  resetMetrics()
  const h = await harness({ aheadSeconds: 28 * 60 })
  try {
    const measured = await h.built.githubApp.measureSkew()
    assert.ok(measured !== null && Math.abs(measured - 1680) <= 2, `measured ${String(measured)}`)
    const state = h.built.githubApp.clockState()
    assert.equal(state.state, 'fail')
    assert.equal(state.thresholdSeconds, 120)
    assert.ok(typeof state.skewSeconds === 'number' && Math.abs(state.skewSeconds - 1680) <= 2)
    assert.ok(state.measuredAt !== null && !Number.isNaN(Date.parse(state.measuredAt)))

    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(ready.statusCode, 503, '/readyz stayed 200 on a clock 28 minutes ahead')
    const body = ready.json() as { ok?: boolean; clock?: { state?: string; thresholdSeconds?: number; skewSeconds?: number | null; source?: string } }
    assert.equal(body.ok, false)
    assert.equal(body.clock?.state, 'fail')
    assert.equal(body.clock?.thresholdSeconds, 120)
    assert.equal(body.clock?.source, 'github')
    assert.ok(typeof body.clock?.skewSeconds === 'number' && Math.abs(body.clock.skewSeconds - 1680) <= 2)

    const refused = await h.built.jobs.enqueue(h.repo, 'manual', 'ship it')
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'CLOCK_SKEW')
    assert.match(String(refused.detail), /^16\d\d$/)
    assert.equal(h.store.listJobsForRepo(h.repo.id, 50).length, 0, 'a job row was written under a bad clock')

    const callsBefore = h.calls.length
    await assert.rejects(async () => { await h.built.githubApp.getApp() }, /CLOCK_SKEW_EXCEEDED/)
    assert.equal(h.calls.length, callsBefore, 'a JWT was minted from a clock above the threshold')
  } finally {
    await h.close()
  }
})

test('a clock inside the threshold keeps readiness and work green', async () => {
  resetMetrics()
  const h = await harness({ aheadSeconds: 5 })
  try {
    const measured = await h.built.githubApp.measureSkew()
    assert.ok(measured !== null && Math.abs(measured - 5) <= 1, `measured ${String(measured)}`)
    assert.equal(h.built.githubApp.clockState().state, 'ok')

    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(ready.statusCode, 200)
    const body = ready.json() as { ok?: boolean; clock?: { state?: string } }
    assert.equal(body.ok, true)
    assert.equal(body.clock?.state, 'ok')

    const accepted = await h.built.jobs.enqueue(h.repo, 'manual', 'ship it')
    assert.equal(accepted.ok, true, `enqueue refused a good clock: ${String(accepted.code)}`)
    assert.equal(h.store.listJobsForRepo(h.repo.id, 50).length, 1)
  } finally {
    await h.close()
  }
})

test('120 seconds is inside the threshold and 121 is outside it', async () => {
  resetMetrics()
  const inside = await harness({ aheadSeconds: 120 })
  const outside = await harness({ aheadSeconds: 121 })
  // `Date` headers carry whole seconds, so an unfrozen clock measures 120.0-120.9 s
  // at this boundary and rounds either way; the assertion is about the comparison,
  // not about network latency, so both readings are taken at one frozen instant.
  const realNow = Date.now
  const measuredAt = 1_800_000_000_000
  try {
    Date.now = () => measuredAt
    assert.equal(await inside.built.githubApp.measureSkew(), 120)
    assert.equal(inside.built.githubApp.clockState().state, 'ok')
    const ready = await inside.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(ready.statusCode, 200, '120 s is the threshold, not past it')
    assert.equal((ready.json() as { clock?: { state?: string } }).clock?.state, 'ok')

    assert.equal(await outside.built.githubApp.measureSkew(), 121)
    assert.equal(outside.built.githubApp.clockState().state, 'fail')
    const refused = await outside.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(refused.statusCode, 503)
    assert.equal((refused.json() as { clock?: { state?: string } }).clock?.state, 'fail')
  } finally {
    Date.now = realNow
    await inside.close()
    await outside.close()
  }
})

test('a failed refresh keeps the last reading for fifteen minutes, then turns unverified', async () => {
  resetMetrics()
  const h = await harness({ aheadSeconds: 5 })
  const realNow = Date.now
  const measuredAt = 1_800_000_000_000
  try {
    Date.now = () => measuredAt
    assert.equal(await h.built.githubApp.measureSkew(), 5)

    // GitHub stops answering. A refresh failure is not a reading, and the last
    // successful one is still inside the window, so the clock stays usable.
    await h.stopGithub()
    Date.now = () => measuredAt + 14 * 60_000
    assert.equal(await h.built.githubApp.measureSkew(), null)
    assert.equal(h.built.githubApp.clockState().state, 'ok', 'a failed refresh inside the window stopped trusting the reading')
    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(ready.statusCode, 200, 'an outage was read as a clock verdict')

    // Past the window the reading is no longer evidence: unknown, not "fine".
    Date.now = () => measuredAt + 16 * 60_000
    assert.equal(h.built.githubApp.clockState().state, 'unknown')
    const stale = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(stale.statusCode, 200)
    assert.equal((stale.json() as { clock?: { state?: string } }).clock?.state, 'unknown')
    await assert.rejects(async () => { await h.built.githubApp.getApp() }, /CLOCK_SKEW_UNVERIFIED/)
  } finally {
    Date.now = realNow
    await h.close()
  }
})

test('a deployment with no App is not a clock verdict', async () => {
  resetMetrics()
  const h = await harness({ unconfigured: true })
  try {
    assert.equal(await h.built.githubApp.measureSkew(), null)
    const state = h.built.githubApp.clockState()
    assert.equal(state.state, 'not-configured')
    assert.equal(state.skewSeconds, null)

    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(ready.statusCode, 200, 'a deployment without an App was failed for a clock it never measures')
    const body = ready.json() as { ok?: boolean; clock?: { state?: string; skewSeconds?: number | null } }
    assert.equal(body.ok, true)
    assert.equal(body.clock?.state, 'not-configured')
    assert.equal(body.clock?.skewSeconds, null)

    const accepted = await h.built.jobs.enqueue(h.repo, 'manual', 'ship it')
    assert.equal(accepted.ok, true, `enqueue refused a deployment that has no App: ${String(accepted.code)}`)
  } finally {
    await h.close()
  }
})
