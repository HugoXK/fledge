import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { resetMetrics } from '../src/lib/metrics.js'
import { json, readBody, startFakeServer, testConfig } from './helpers.js'

// #758 slice 1: make the GitHub clock skew visible. The host clock cannot be
// fixed by a commit, so this slice is the guard that was missing: the measurement
// the App JWT already performs is exposed on /readyz and /metrics, and a missing
// measurement is `null` — never 0, which would read as "the clock is fine".

function captureLog(): { lines: Array<Record<string, unknown>>; restore: () => void } {
  const lines: Array<Record<string, unknown>> = []
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  const tap = (write: typeof process.stdout.write): typeof process.stdout.write => ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.startsWith('{"ts":"')) continue
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>)
      } catch {}
    }
    return (write as unknown as (value: string | Uint8Array, ...args: unknown[]) => boolean)(chunk, ...rest)
  }) as unknown as typeof process.stdout.write
  process.stdout.write = tap(stdout.bind(process.stdout))
  process.stderr.write = tap(stderr.bind(process.stderr))
  return {
    lines,
    restore: () => {
      process.stdout.write = stdout
      process.stderr.write = stderr
    },
  }
}

interface SkewOptions {
  /** Seconds the faked GitHub clock is behind, i.e. how far ahead the process is. */
  aheadSeconds?: number
  /** Skip the fake server entirely and point at a closed port. */
  unreachable?: boolean
  /** The App id and key path are empty, as on an instance with no App. */
  unconfigured?: boolean
}

async function skewHarness(options: SkewOptions = {}) {
  const calls: string[] = []
  const server = options.unreachable === true
    ? null
    : await startFakeServer(async (request, response) => {
      await readBody(request)
      calls.push(request.url ?? '')
      const date = new Date(Date.now() - (options.aheadSeconds ?? 90) * 1000).toUTCString()
      return json(response, 200, { resources: {} }, { date })
    })
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: server === null ? 'http://127.0.0.1:9' : server.url },
    githubApp: {
      id: options.unconfigured === true ? '' : '123456',
      slug: 'fledge-test',
      privateKeyPath: options.unconfigured === true ? '' : '/tmp/fledge-test-app.pem',
      webhookSecret: '',
      useUserToken: false,
    },
  })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: undefined, runner: new MockRunner(), startScheduler: false })
  return {
    built,
    calls,
    close: async () => {
      await built.close()
      if (server !== null) await server.close()
    },
  }
}

test('a measured 90-second skew is on /readyz and on /metrics', async () => {
  resetMetrics()
  const h = await skewHarness({ aheadSeconds: 90 })
  try {
    const measured = await h.built.githubApp.measureSkew()
    assert.ok(measured !== null && measured >= 88 && measured <= 92, `measured ${String(measured)}`)
    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(ready.statusCode, 200)
    const body = ready.json() as { clock?: { skewSeconds?: number | null; source?: string } }
    assert.ok(body.clock !== undefined, '/readyz carries no clock field')
    assert.equal(body.clock?.source, 'github')
    assert.ok(typeof body.clock?.skewSeconds === 'number' && Math.abs(body.clock.skewSeconds - 90) <= 2, `skewSeconds ${String(body.clock?.skewSeconds)}`)
    const metrics = await h.built.app.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' })
    assert.equal(metrics.statusCode, 200)
    assert.match(metrics.body, /^fledge_clock_skew_seconds 9\d$/m)
  } finally {
    await h.close()
  }
})

test('an unconfigured App answers null, never zero', async () => {
  resetMetrics()
  const h = await skewHarness({ unconfigured: true })
  try {
    assert.equal(await h.built.githubApp.measureSkew(), null)
    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    const body = ready.json() as { clock?: { skewSeconds?: number | null; source?: string } }
    assert.ok(body.clock !== undefined, '/readyz carries no clock field')
    assert.equal(body.clock?.skewSeconds, null, 'a missing measurement read as a number')
    assert.equal(body.clock?.source, 'github')
    const metrics = await h.built.app.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' })
    assert.equal(metrics.statusCode, 200)
    assert.doesNotMatch(metrics.body, /fledge_clock_skew_seconds/, 'an unknown skew was published as a number')
  } finally {
    await h.close()
  }
})

test('an unreachable GitHub answers null, never zero', async () => {
  resetMetrics()
  const h = await skewHarness({ unreachable: true })
  try {
    assert.equal(await h.built.githubApp.measureSkew(), null)
    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    const body = ready.json() as { clock?: { skewSeconds?: number | null } }
    assert.ok(body.clock !== undefined, '/readyz carries no clock field')
    assert.equal(body.clock?.skewSeconds, null, 'a failed measurement read as a good clock')
    const metrics = await h.built.app.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' })
    assert.doesNotMatch(metrics.body, /fledge_clock_skew_seconds/, 'a failed measurement published a number')
  } finally {
    await h.close()
  }
})

test('a skew inside 60 seconds is reported without a log line', async () => {
  resetMetrics()
  const h = await skewHarness({ aheadSeconds: 30 })
  const capture = captureLog()
  try {
    const measured = await h.built.githubApp.measureSkew()
    assert.ok(measured !== null && Math.abs(measured - 30) <= 2, `measured ${String(measured)}`)
    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    const body = ready.json() as { clock?: { skewSeconds?: number | null } }
    assert.ok(typeof body.clock?.skewSeconds === 'number' && body.clock.skewSeconds >= 28)
    const skewLines = capture.lines.filter((line) => line.msg === 'clock.skew')
    assert.deepEqual(skewLines, [], 'a 30-second skew is inside the tolerance and must not log')
  } finally {
    capture.restore()
    await h.close()
  }
})

test('a skew outside 60 seconds logs once per measurement, not once per request', async () => {
  resetMetrics()
  const h = await skewHarness({ aheadSeconds: 600 })
  const capture = captureLog()
  try {
    await h.built.githubApp.measureSkew()
    await h.built.app.inject({ method: 'GET', url: '/readyz' })
    await h.built.app.inject({ method: 'GET', url: '/readyz' })
    const skewLines = capture.lines.filter((line) => line.msg === 'clock.skew')
    assert.equal(skewLines.length, 1, `expected one clock.skew line, saw ${skewLines.length}`)
    assert.ok(typeof skewLines[0]?.skewSeconds === 'number' && Math.abs(Number(skewLines[0].skewSeconds) - 600) <= 2)
  } finally {
    capture.restore()
    await h.close()
  }
})

test('/readyz reads the last measurement instead of calling GitHub', async () => {
  resetMetrics()
  const h = await skewHarness({ aheadSeconds: 90 })
  try {
    await h.built.githubApp.measureSkew()
    const before = h.calls.length
    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    assert.equal(ready.statusCode, 200)
    assert.equal(h.calls.length, before, '/readyz made a GitHub call of its own')
  } finally {
    await h.close()
  }
})
