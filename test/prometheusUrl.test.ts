import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runPrometheusQueries } from '../scripts/lib/prometheus-url.mjs'

// The gate's seam: the CLI resolves its base URL and auth header from the
// environment here, and nothing else in it touches `fetch`. These cases call
// the module directly, so no case spawns `scripts/slo-report.mjs` (which imports
// `../dist/lib/slo.js` and would die with ERR_MODULE_NOT_FOUND before `npm test`
// builds) and none needs a build.

const TOKEN = 's3cr3t-token'
const SENTINEL = 'prom-sentinel-4f7c1d'

interface Call {
  url: string
  init: { headers?: Record<string, string>; signal?: unknown } | undefined
}

function recordingFetch(calls: Call[], body: unknown = { status: 'success', data: { result: [] } }, status = 200) {
  return async (url: string, init?: { headers?: Record<string, string>; signal?: unknown }) => {
    calls.push({ url, init })
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
}

function plainFetch(init: Call['init']) {
  return init
}

test('a URL that carries credentials is refused before any fetch', async () => {
  const calls: Call[] = []
  const result = await runPrometheusQueries({
    env: { PROMETHEUS_URL: `http://user:${TOKEN}@prom.example:9090` },
    exprs: ['up'],
    fetchImpl: recordingFetch(calls),
  })
  assert.ok('refusal' in result, 'a credentialed URL must be refused, not fetched')
  const message = String((result as { refusal: string }).refusal)
  assert.match(message, /PROMETHEUS_URL/, 'the refusal names the variable the operator set')
  assert.match(message, /credential/, 'the refusal says what is wrong with it')
  assert.match(message, /PROMETHEUS_AUTH_HEADER/, 'the refusal says where the credential belongs instead')
  assert.doesNotMatch(message, new RegExp(TOKEN), 'the refusal must not echo the password')
  assert.doesNotMatch(message, /user:/, 'the refusal must not echo the username either')
  assert.equal(calls.length, 0, 'nothing is fetched from a refused base')
})

test('the auth header reaches the request and never the URL', async () => {
  const calls: Call[] = []
  const result = await runPrometheusQueries({
    env: { PROMETHEUS_URL: 'https://prom.example:9090', PROMETHEUS_AUTH_HEADER: `Bearer ${TOKEN}` },
    exprs: ['up'],
    fetchImpl: recordingFetch(calls),
  })
  assert.ok(!('refusal' in result), `a clean https base with a header is usable: ${JSON.stringify(result)}`)
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call?.url, 'https://prom.example:9090/api/v1/query?query=up')
  assert.equal(call?.init?.headers?.authorization, `Bearer ${TOKEN}`, 'the header is what carries the token')
  assert.doesNotMatch(String(call?.url), new RegExp(TOKEN), 'the token must not be in the URL')
  assert.ok(plainFetch(call?.init) !== undefined)
})

test('a non-loopback host with an auth header must be https', async () => {
  const calls: Call[] = []
  const result = await runPrometheusQueries({
    env: { PROMETHEUS_URL: 'http://prom.example:9090', PROMETHEUS_AUTH_HEADER: `Bearer ${TOKEN}` },
    exprs: ['up'],
    fetchImpl: recordingFetch(calls),
  })
  assert.ok('refusal' in result, 'a token over cleartext to another host must be refused')
  const message = String((result as { refusal: string }).refusal)
  assert.match(message, /https/i, 'the refusal says what to change')
  assert.match(message, /PROMETHEUS_AUTH_HEADER/, 'the refusal names the header variable')
  assert.doesNotMatch(message, new RegExp(TOKEN), 'the refusal must not echo the token')
  assert.equal(calls.length, 0, 'nothing is fetched in cleartext with a token')
})

test('a loopback base keeps working over http and carries the header', async () => {
  const calls: Call[] = []
  const result = await runPrometheusQueries({
    env: { PROMETHEUS_URL: 'http://127.0.0.1:9090/', PROMETHEUS_AUTH_HEADER: `Bearer ${TOKEN}` },
    exprs: ['up'],
    fetchImpl: recordingFetch(calls),
  })
  assert.ok(!('refusal' in result), `loopback is exempt from the https rule: ${JSON.stringify(result)}`)
  assert.equal(calls[0]?.url, 'http://127.0.0.1:9090/api/v1/query?query=up', 'the base keeps no trailing slash')
  assert.equal(calls[0]?.init?.headers?.authorization, `Bearer ${TOKEN}`)
})

test('a malformed URL is refused without echoing it', async () => {
  const calls: Call[] = []
  const result = await runPrometheusQueries({
    env: { PROMETHEUS_URL: `ht!tp://bad host ${SENTINEL}` },
    exprs: ['up'],
    fetchImpl: recordingFetch(calls),
  })
  assert.ok('refusal' in result, 'a malformed URL must be refused, not handed to fetch')
  const message = String((result as { refusal: string }).refusal)
  assert.match(message, /PROMETHEUS_URL/, 'the refusal names the variable')
  assert.match(message, /not a valid URL/i, 'the refusal names the shape of the problem')
  assert.doesNotMatch(message, new RegExp(SENTINEL), 'the refusal must not echo the raw value Node would print')
  assert.equal(calls.length, 0, 'nothing is fetched from a malformed base')
})

test('a failing query does not echo the URL or the token', async () => {
  const calls: Call[] = []
  await assert.rejects(
    runPrometheusQueries({
      env: { PROMETHEUS_URL: 'https://prom.example:9090', PROMETHEUS_AUTH_HEADER: `Bearer ${TOKEN}` },
      exprs: ['up'],
      fetchImpl: recordingFetch(calls, { status: 'error', error: 'bad_data' }, 503),
    }),
    (error: Error) => {
      assert.match(error.message, /Prometheus 503/)
      assert.doesNotMatch(error.message, new RegExp(TOKEN), 'a thrown error must not carry the token')
      assert.doesNotMatch(error.message, /prom\.example/, 'a thrown error must not carry the base URL')
      return true
    },
  )
})

test('the default base stays the loopback the report used before', async () => {
  const calls: Call[] = []
  const result = await runPrometheusQueries({ env: {}, exprs: ['up'], fetchImpl: recordingFetch(calls) })
  assert.ok(!('refusal' in result))
  assert.equal(calls[0]?.url, 'http://127.0.0.1:9090/api/v1/query?query=up')
  assert.equal(calls[0]?.init?.headers?.authorization, undefined, 'no header is sent when the variable is unset')
})

// The CLI must not build its own request any more: two places that decide what
// goes on the wire are two places that can disagree about credentials.
test('the CLI takes its base and header from the seam, not from its own environment read', () => {
  const source = readFileSync('scripts/slo-report.mjs', 'utf8')
  assert.match(source, /from '\.\/lib\/prometheus-url\.mjs'/, 'the CLI imports the seam')
  assert.doesNotMatch(source, /PROMETHEUS_URL/, 'the CLI does not read the base URL itself')
  assert.doesNotMatch(source, /fetch\(/, 'the CLI does not call fetch itself')
})
