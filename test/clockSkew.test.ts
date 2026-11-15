import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  /** A key file the JWT can be signed with, when a test needs a real mint. */
  privateKeyPath?: string
}

async function skewHarness(options: SkewOptions = {}) {
  const calls: string[] = []
  const jwtAuthorizations: string[] = []
  // #758 finding: a proxy can rewrite the `Date` header to something that is
  // present but not a date. The fake keeps that switch explicit so the test can
  // flip it between two reads of the same server.
  let rewriteDate = false
  const dateHeader = (): string => (rewriteDate
    ? 'Thursday, 32 Nov 2026 25:61:61 GMT'
    : new Date(Date.now() - (options.aheadSeconds ?? 90) * 1000).toUTCString())
  const server = options.unreachable === true
    ? null
    : await startFakeServer(async (request, response) => {
      await readBody(request)
      const url = request.url ?? ''
      calls.push(url)
      const date = dateHeader()
      if (url.endsWith('/app')) {
        const authorization = request.headers.authorization
        if (authorization !== undefined) jwtAuthorizations.push(authorization)
        return json(response, 200, { id: 123456, slug: 'fledge-test', name: 'fledge-test' }, { date })
      }
      return json(response, 200, { resources: {} }, { date })
    })
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: server === null ? 'http://127.0.0.1:9' : server.url },
    githubApp: {
      id: options.unconfigured === true ? '' : '123456',
      slug: 'fledge-test',
      privateKeyPath: options.unconfigured === true ? '' : (options.privateKeyPath ?? '/tmp/fledge-test-app.pem'),
      webhookSecret: '',
      useUserToken: false,
    },
  })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: undefined, runner: new MockRunner(), startScheduler: false })
  return {
    built,
    calls,
    jwtAuthorizations,
    rewriteDateHeader: () => {
      rewriteDate = true
    },
    close: async () => {
      await built.close()
      if (server !== null) await server.close()
    },
  }
}

function jwtPayload(authorization: string): Record<string, unknown> {
  const token = authorization.replace(/^Bearer\s+/i, '')
  const encoded = token.split('.')[1] ?? ''
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>
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

// #758 finding: a `Date` header that is present but unparseable (a rewriting
// proxy is the realistic case) reached `Date.parse` as `NaN`, and `NaN` travelled
// through the whole chain: `skewSeconds: NaN` on /readyz (serialised as `null` by
// luck), a literal `NaN` gauge on /metrics because `setGauge` never checked
// finiteness, a `Math.abs(NaN) > 60` log test that is false, and an `iat: NaN`
// JWT. A number that was never measured, failing silently. The fourth way to be
// unknown is the same as the other three: no reading, no series.
test('a Date header that is present but unparseable is no measurement, and the JWT keeps its last real correction', async () => {
  resetMetrics()
  const dir = mkdtempSync(join(tmpdir(), 'fledge-clock-skew-'))
  const keyPath = join(dir, 'app.pem')
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  writeFileSync(keyPath, privateKey)
  const h = await skewHarness({ aheadSeconds: 90, privateKeyPath: keyPath })
  const capture = captureLog()
  const realNow = Date.now
  const measuredAt = 1_800_000_000_000
  try {
    // A real reading first. This is the last real correction the JWT may keep.
    Date.now = () => measuredAt
    assert.equal(await h.built.githubApp.measureSkew(), 90, 'the fake clock is 90 seconds behind')

    // The proxy starts rewriting `Date`: present, but not a date.
    h.rewriteDateHeader()
    Date.now = () => measuredAt + 2_500
    const loggedBefore = capture.lines.length
    assert.equal(await h.built.githubApp.measureSkew(), null, 'an unparseable Date was recorded as a measurement')

    const ready = await h.built.app.inject({ method: 'GET', url: '/readyz' })
    const body = ready.json() as { clock?: { skewSeconds?: number | null } }
    assert.equal(body.clock?.skewSeconds, null, 'an unparseable Date read as a number on /readyz')
    const metrics = await h.built.app.inject({ method: 'GET', url: '/metrics', remoteAddress: '127.0.0.1' })
    assert.doesNotMatch(metrics.body, /fledge_clock_skew_seconds/, 'an unparseable Date published a gauge')
    assert.deepEqual(capture.lines.slice(loggedBefore).filter((line) => line.msg === 'clock.skew'), [], 'a NaN skew passed the 60-second log test')

    // The JWT still mints, with the last correction that was really measured.
    // `floor` truncates the half-second toward the past; that is the asserted
    // direction, not a tolerance around the nearest second.
    await h.built.githubApp.getApp()
    assert.equal(h.jwtAuthorizations.length, 1, 'no JWT was minted for /app')
    const payload = jwtPayload(h.jwtAuthorizations[0] ?? '')
    assert.equal(payload.iat, Math.floor((measuredAt + 2_500 - 90_000) / 1000) - 60, 'the JWT dropped its last real correction')
    assert.notEqual(payload.iat, Math.round((measuredAt + 2_500 - 90_000) / 1000) - 60, 'the correction was rounded, not truncated')
    assert.ok(typeof payload.exp === 'number' && Number.isFinite(payload.exp), 'the JWT expiry is not a number')
  } finally {
    Date.now = realNow
    capture.restore()
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
