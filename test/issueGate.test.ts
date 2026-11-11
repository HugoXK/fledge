import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { startFakeServer } from './helpers.js'

const execFileAsync = promisify(execFile)
const gateScript = fileURLToPath(new URL('../scripts/issue-gate.mjs', import.meta.url))

// The gate's whole subject is one number: sha256 over the *whole decoded body*,
// first 12 hex. Computing it here with node:crypto and never from the script
// keeps the expectation independent of the thing under test.
function bodyHash(body: string): string {
  return createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 12)
}

interface Verdict {
  kind: 'PASS' | 'CHANGES'
  hash: string
  login: string
  issue?: number
  extra?: string
}

function verdictComment({ kind, hash, login, issue = 76, extra }: Verdict): { body: string; user: { login: string } } {
  const first = `Issue-review: ${kind} at issue #${issue} body ${hash}`
  return { body: extra === undefined ? `${first}\n` : `${first}\n${extra}\n`, user: { login } }
}

interface Fixture {
  body: string
  comments: { body: string; user: { login: string } }[]
  labels?: string[]
  // Serve the issue body as raw bytes instead of a JSON string, so a multi-byte
  // character can be split across two chunks on purpose.
  rawBodyChunks?: Buffer[]
  // Split comments into pages of this size and emit Link: rel="next" between them.
  pageSize?: number
}

interface Result {
  code: number
  stdout: string
  stderr: string
}

async function runGate(fixture: Fixture): Promise<Result> {
  const comments = fixture.comments
  const pageSize = fixture.pageSize ?? 100
  const server = await startFakeServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const issueMatch = /^\/repos\/o\/r\/issues\/76$/.exec(url.pathname)
    if (issueMatch !== null) {
      if (fixture.rawBodyChunks !== undefined) {
        response.writeHead(200, { 'content-type': 'application/json' })
        for (const chunk of fixture.rawBodyChunks) response.write(chunk)
        response.end()
        return
      }
      const payload = JSON.stringify({ number: 76, body: fixture.body, labels: (fixture.labels ?? []).map((name) => ({ name })) })
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) })
      response.end(payload)
      return
    }
    const commentsMatch = /^\/repos\/o\/r\/issues\/76\/comments$/.exec(url.pathname)
    if (commentsMatch !== null) {
      const page = Number(url.searchParams.get('page') ?? '1')
      const start = (page - 1) * pageSize
      const slice = comments.slice(start, start + pageSize)
      const payload = JSON.stringify(slice)
      const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
      if (start + pageSize < comments.length) {
        headers.link = `<${server.url}/repos/o/r/issues/76/comments?per_page=${pageSize}&page=${page + 1}>; rel="next"`
      }
      response.writeHead(200, headers)
      response.end(payload)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ message: 'not found' }))
  })

  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: 'o/r' }
  // The tests never carry a token: --api-base points at the fake server, which
  // is the whole reason the flag exists.
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  try {
    try {
      const result = await execFileAsync(process.execPath, [gateScript, '--issue', '76', '--api-base', server.url], { env, encoding: 'utf8' })
      return { code: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string }
      return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
    }
  } finally {
    await server.close()
  }
}

// The bug this issue exists for: the body was edited after the PASS and nothing
// noticed. One character is enough.
test('an edited body is a stale pass', async () => {
  const passed = 'Expected behaviour: the gate recomputes the hash.\n'
  const edited = 'Expected behaviour: the gate recomputes the hash!\n'
  const before = bodyHash(passed)
  const after = bodyHash(edited)
  assert.notEqual(before, after)

  const result = await runGate({ body: edited, comments: [verdictComment({ kind: 'PASS', hash: before, login: 'HugoXK-bot' })] })

  assert.equal(result.code, 1)
  assert.equal(result.stdout, `issue-gate: stale-pass #76 passed=${before} current=${after}\n`)
})

test('a pass that names the live body is quiet', async () => {
  const body = 'Goal: one machine line per card.\n'
  const hash = bodyHash(body)

  const result = await runGate({ body, comments: [verdictComment({ kind: 'PASS', hash, login: 'HugoXK-bot' })] })

  assert.equal(result.code, 0)
  assert.equal(result.stdout, `issue-gate: ok #76 ${hash}\n`)
})

test('a card with no verdict at all has no pass', async () => {
  const result = await runGate({ body: 'A card nobody reviewed.\n', comments: [] })

  assert.equal(result.code, 2)
  assert.equal(result.stdout, 'issue-gate: no-pass #76\n')
})

// Only requiredPass may approve. A PASS written by the author is the case the
// policy calls out, and it must not be accepted as one.
test('a pass from an identity that is not the reviewer is refused', async () => {
  const body = 'Body under test.\n'
  const hash = bodyHash(body)

  const result = await runGate({ body, comments: [verdictComment({ kind: 'PASS', hash, login: 'HugoXK' })] })

  assert.equal(result.code, 3)
  assert.equal(result.stdout, `issue-gate: bad-passer #76 HugoXK\n`)
})

// The Lead's rule is "add agent-ready only after ok", so a CHANGES verdict at
// the live body has to block, even when an older PASS at the same hash exists.
test('a later changes at the live body beats an earlier pass and blocks agent-ready', async () => {
  const body = 'Body under test.\n'
  const hash = bodyHash(body)

  const result = await runGate({
    body,
    labels: ['agent-ready', 'review:changes'],
    comments: [
      verdictComment({ kind: 'PASS', hash, login: 'HugoXK-bot' }),
      verdictComment({ kind: 'CHANGES', hash, login: 'HugoXK-bot', extra: 'Findings - required changes: the exit code table is incomplete' }),
    ],
  })

  assert.equal(result.code, 4)
  assert.equal(result.stdout, `issue-gate: changes #76 ${hash}\n`)
  assert.match(result.stderr, /agent-ready/)
})

// A quoted verdict is not a verdict. The first line is the contract.
test('a verdict quoted inside a longer comment does not count', async () => {
  const body = 'Body under test.\n'
  const hash = bodyHash(body)
  const quoted = {
    body: `I am reposting the earlier review for context:\nIssue-review: PASS at issue #76 body ${hash}\n`,
    user: { login: 'HugoXK-bot' },
  }

  const result = await runGate({ body, comments: [quoted] })

  assert.equal(result.code, 2)
  assert.equal(result.stdout, 'issue-gate: no-pass #76\n')
})

// A PASS for another issue must not satisfy this one, which is why the line
// carries the issue number at all.
test('a pass naming another issue does not count', async () => {
  const body = 'Body under test.\n'
  const hash = bodyHash(body)

  const result = await runGate({ body, comments: [verdictComment({ kind: 'PASS', hash, login: 'HugoXK-bot', issue: 61 })] })

  assert.equal(result.code, 2)
  assert.equal(result.stdout, 'issue-gate: no-pass #76\n')
})

// The documented limit, pinned in both directions: the gate compares published
// hashes with the live body, so a byte-for-byte revert is accepted again. It is
// not revert-proof and the docs say so.
test('an edit voids the pass and a byte-identical revert revives it', async () => {
  const body = 'Version A.\n'
  const edited = 'Version B.\n'
  const pass = verdictComment({ kind: 'PASS', hash: bodyHash(body), login: 'HugoXK-bot' })

  const stale = await runGate({ body: edited, comments: [pass] })
  assert.equal(stale.code, 1)
  assert.equal(stale.stdout, `issue-gate: stale-pass #76 passed=${bodyHash(body)} current=${bodyHash(edited)}\n`)

  const revived = await runGate({ body, comments: [pass] })
  assert.equal(revived.code, 0)
  assert.equal(revived.stdout, `issue-gate: ok #76 ${bodyHash(body)}\n`)
})

// The newest verdict lives on the last page: a single-page read would return an
// older verdict with no error, so following Link: rel="next" is load-bearing.
test('the newest verdict is found past the first comments page', async () => {
  const body = 'Body under test.\n'
  const hash = bodyHash(body)
  const noise = (index: number) => ({ body: `Filler comment ${index}.\n`, user: { login: 'HugoXK' } })
  const comments = Array.from({ length: 34 }, (_unused, index) => noise(index))
  comments.push(verdictComment({ kind: 'PASS', hash, login: 'HugoXK-bot' }))

  const result = await runGate({ body, comments, pageSize: 30 })

  assert.equal(result.code, 0)
  assert.equal(result.stdout, `issue-gate: ok #76 ${hash}\n`)
})

test('an older verdict on page one does not win over a newer one on page two', async () => {
  const body = 'Body under test.\n'
  const hash = bodyHash(body)
  const comments = [verdictComment({ kind: 'PASS', hash: '0123456789ab', login: 'HugoXK-bot' })]
  for (let index = 0; index < 30; index += 1) comments.push({ body: `Filler comment ${index}.\n`, user: { login: 'HugoXK' } })
  comments.push(verdictComment({ kind: 'PASS', hash, login: 'HugoXK-bot' }))

  const result = await runGate({ body, comments, pageSize: 30 })

  assert.equal(result.code, 0)
  assert.equal(result.stdout, `issue-gate: ok #76 ${hash}\n`)
})

// A multi-byte character split across two chunks of the response stream must
// hash exactly like the whole-body decode. Decoding each chunk separately turns
// the split character into U+FFFD and shifts the hash, which is the defect the
// issue records.
test('a character split across chunks hashes like the whole body', async () => {
  const body = `Body with CJK: 备份状态与清单。 and more text after it.\n`
  const bytes = Buffer.from(JSON.stringify({ number: 76, body, labels: [] }), 'utf8')
  const splitAt = bytes.indexOf(Buffer.from('备', 'utf8')) + 1
  assert.ok(splitAt > 1, 'the fixture must contain the character it splits')

  const result = await runGate({
    body,
    comments: [verdictComment({ kind: 'PASS', hash: bodyHash(body), login: 'HugoXK-bot' })],
    rawBodyChunks: [bytes.subarray(0, splitAt), bytes.subarray(splitAt)],
  })

  assert.equal(result.code, 0)
  assert.equal(result.stdout, `issue-gate: ok #76 ${bodyHash(body)}\n`)
})

// A body that decodes with U+FFFD cannot be hashed reproducibly, so the gate
// refuses to print a hash at all rather than print one nobody can reproduce.
test('a body that decodes with a replacement character is refused, with no hash printed', async () => {
  const bytes = Buffer.concat([
    Buffer.from('{"number":76,"body":"broken ', 'utf8'),
    Buffer.from([0xff]),
    Buffer.from(' bytes","labels":[]}', 'utf8'),
  ])

  const result = await runGate({ body: '', comments: [], rawBodyChunks: [bytes] })

  assert.equal(result.code, 5)
  assert.equal(result.stdout, 'issue-gate: corrupt-body #76\n')
  assert.doesNotMatch(result.stdout, /[0-9a-f]{12}/)
})
