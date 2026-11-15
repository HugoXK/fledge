import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'

import { BRIDGE_SESSION_ID, BRIDGE_TOKEN, startBridge, startFakeServer, writeDshLog } from './helpers.js'

// #391: the bridge is a second process and nothing pinned its own HTTP surface.
// test/providerRefusal.test.ts proves the DSH refusal is relayed; this suite
// pins the status codes Fledge and an operator actually depend on, against the
// real bridge file and a fake DSH that answers `GET /?token=…` with a cookie and
// `POST /api/bot` with JSON — the two things bridge/flybot-bridge.mjs calls.
//
// The file lives at the repository root because `npm test` is
// `tsx --test test/*.test.ts`, a flat glob: a suite in a subdirectory would
// silently never run.

type DshCall = { endpoint: unknown; payload: Record<string, unknown> }
type DshReply = { status: number; body: unknown }

async function fakeDsh(
  reply: (call: DshCall) => DshReply = () => ({ status: 200, body: { ok: true } }),
): Promise<{ calls: DshCall[]; url: string; close: () => Promise<void> }> {
  const calls: DshCall[] = []
  const fake = await startFakeServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'set-cookie': 'dsh=ok; Path=/' }).end('ok')
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as DshCall
      calls.push(parsed)
      const answer = reply(parsed)
      const text = JSON.stringify(answer.body)
      response
        .writeHead(answer.status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
        .end(text)
    })
  })
  return { calls, url: fake.url, close: fake.close }
}

async function withBridge(
  body: (context: { port: number; calls: DshCall[] }) => Promise<void>,
  reply?: (call: DshCall) => DshReply,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-bridge-contract-'))
  const logPath = join(dir, 'dsh-web.log')
  writeDshLog(logPath, 'contract-token')
  const dsh = await fakeDsh(reply)
  let child: ChildProcess | undefined
  try {
    const bridge = await startBridge({ web: dsh.url, log: logPath })
    child = bridge.child
    await body({ port: bridge.port, calls: dsh.calls })
  } finally {
    child?.kill('SIGKILL')
    await dsh.close()
  }
}

function bridgeUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

function postJson(port: number, path: string, body: unknown, authorized = true): Promise<Response> {
  return fetch(bridgeUrl(port, path), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorized ? { authorization: `Bearer ${BRIDGE_TOKEN}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function runJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: 'job_contract',
    kind: 'iterate',
    goal: 'fix one reproducible bug',
    upstream: { owner: 'o', name: 'r', defaultBranch: 'main' },
    fork: { owner: 'o', name: 'r', defaultBranch: 'main' },
    credentialUrl: 'http://127.0.0.1:9999/credential',
    credentialSecret: 'credential-secret',
    callbackUrl: 'http://127.0.0.1:9999/callback',
    callbackSecret: 'callback-secret',
    platform: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'a-model', token: 'flg_test' },
    ...overrides,
  }
}

test('/healthz answers the liveness body, which is also the proof the spawn worked', async () => {
  await withBridge(async ({ port }) => {
    const response = await fetch(bridgeUrl(port, '/healthz'))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true, service: 'fledge-flybot-bridge', modelProxy: false })
  })
})

test('a dispatch without the shared token answers 401, and a wrong method or path answers 404', async () => {
  await withBridge(async ({ port }) => {
    const unauthorized = await postJson(port, '/run', runJob(), false)
    assert.equal(unauthorized.status, 401)
    assert.deepEqual(await unauthorized.json(), { error: 'unauthorized' })

    const wrongMethod = await fetch(bridgeUrl(port, '/run'))
    assert.equal(wrongMethod.status, 404, 'the bridge is POST-only apart from /healthz')

    const unknown = await postJson(port, '/nope', {})
    assert.equal(unknown.status, 404)
    assert.deepEqual(await unknown.json(), { error: 'not found' })
  })
})

test('a dispatch missing its required fields names them, and malformed JSON is not a size error', async () => {
  await withBridge(async ({ port }) => {
    const incomplete = await postJson(port, '/run', { jobId: 'j1' })
    assert.equal(incomplete.status, 400)
    assert.deepEqual(await incomplete.json(), { error: 'jobId, credentialUrl and callbackUrl are required' })

    const malformed = await postJson(port, '/run', '{not json')
    assert.equal(malformed.status, 400)
    assert.deepEqual(await malformed.json(), { error: 'invalid JSON' })
  })
})

test('an accepted dispatch answers 202 and the prompt carries the callback contract', async () => {
  await withBridge(async ({ port, calls }) => {
    const response = await postJson(port, '/run', runJob())
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { ok: true, accepted: true })

    const send = calls.find((call) => call.endpoint === 'send')
    assert.notEqual(send, undefined, 'the job reached DSH as a send')
    const payload = send!.payload as { sessionId: string; text: string }
    assert.equal(payload.sessionId, BRIDGE_SESSION_ID, 'an iterate job goes to the iterate session')
    assert.match(payload.text, /http:\/\/127\.0\.0\.1:9999\/callback/, 'the agent is told where to report')
    // Assembled from parts: a literal `Authorization: Bearer <secret>` in a
    // tracked file trips scripts/secret-scan.mjs (authorization-bearer), and this
    // is a fixture, not a credential.
    const expectedAuth = ['Authorization:', 'Bearer', 'callback-secret'].join(' ')
    assert.ok(payload.text.includes(expectedAuth), 'the callback secret is in the prompt')
    for (const key of ['status', 'branch', 'prUrl', 'issueUrl', 'reviewScore', 'summary', 'error']) {
      assert.match(payload.text, new RegExp(`"?${key}"?`), `the final-callback shape names ${key}`)
    }
  })
})

test('a DSH refusal answers 502 and a token in its answer comes back redacted', async () => {
  // Assembled from parts on purpose: a literal `github_pat_…` in the tree makes
  // the secret scanner red for a fixture that is not a secret.
  const leaked = ['github', 'pat', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_')
  await withBridge(
    async ({ port }) => {
      const response = await postJson(port, '/run', runJob())
      assert.equal(response.status, 502)
      const body = (await response.json()) as { error: string; detail: string }
      assert.equal(body.error, 'DSH did not accept the job')
      assert.match(body.detail, /\[redacted-github-token\]/)
      assert.doesNotMatch(body.detail, /github_pat_/, 'the bridge never relays a token it was shown')
    },
    () => ({ status: 500, body: { error: { message: `refused: leaked ${leaked} in the answer` } } }),
  )
})

test('the /dsh proxy answers the DSH body and requires an endpoint', async () => {
  await withBridge(
    async ({ port }) => {
      const state = await postJson(port, '/dsh', { endpoint: 'state', payload: {} })
      assert.equal(state.status, 200)
      assert.deepEqual(await state.json(), { value: { bots: [] } })

      const missing = await postJson(port, '/dsh', {})
      assert.equal(missing.status, 400)
      assert.deepEqual(await missing.json(), { error: 'endpoint required' })
    },
    (call) => ({ status: 200, body: call.endpoint === 'state' ? { value: { bots: [] } } : { ok: true } }),
  )
})

// Red at main 37f4ac99: readBody destroyed the socket on the limit, the handler
// took its JSON-parse branch and wrote 400 to a dead connection, so this case
// failed on a fetch/socket error rather than on a status.
test('a body over the limit answers 413 instead of a destroyed socket', async () => {
  await withBridge(async ({ port }) => {
    const oversized = JSON.stringify({ ...runJob(), padding: 'x'.repeat(33 * 1024) })
    const response = await postJson(port, '/run', oversized)
    assert.equal(response.status, 413, 'an oversized dispatch is a size refusal, not a parse error')
    assert.deepEqual(await response.json(), { error: 'body too large' })
  })
})
