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
const policyPath = fileURLToPath(new URL('../.github/agent/review-policy.json', import.meta.url))
const PASSER = 'HugoXK-bot'

// The gate's subject here is resolution, so the fixture is a small tree served
// at a pin: refs are checked against these lines, never against live main.
const MAIN = 'dcf6698a202b080a5fb233f98df393bc2c63b65f'
const PIN = '3d4b1a6bcf86ab258aead0fc1568778c3f3dd9c4'
const OTHER_PIN = '94a80523a75586f5d00d1f0470e9b9c219669f38'

const PAGES_LINES = [
  "import { localizeNotification, localizeMessage } from '../i18n.js'",
  '',
  'export function render(): string {',
  '  return noticeBlock(\'x\')',
  '}',
  '',
]
// Line 20 is the definition the failing fixture cites, and it is *not* the
// symbol that fixture claims lives there.
while (PAGES_LINES.length < 19) PAGES_LINES.push(`// filler ${String(PAGES_LINES.length + 1)}`)
PAGES_LINES.push('export function noticeText(locale: string, notice: string): string {')
while (PAGES_LINES.length < 60) PAGES_LINES.push(`  // trailing ${String(PAGES_LINES.length + 1)}`)
const NOTICE_TEXT_LINE = PAGES_LINES.indexOf('export function noticeText(locale: string, notice: string): string {') + 1

const SERVICE_LINES: string[] = []
while (SERVICE_LINES.length < 1014) SERVICE_LINES.push(`  // step ${String(SERVICE_LINES.length + 1)}`)
SERVICE_LINES.push("    throw new Error('任务的产出的是盘点/清账类 issue')")
while (SERVICE_LINES.length < 1100) SERVICE_LINES.push(`  // tail ${String(SERVICE_LINES.length + 1)}`)

const TREE: Record<string, string[]> = {
  'src/views/pages.ts': PAGES_LINES,
  'src/jobs/service.ts': SERVICE_LINES,
  'test/notificationsLocale.test.ts': ['// test file', 'export const marker = 1'],
  'src/i18n.ts': ['// i18n', 'export function localizeMessage(key: string): string { return key }'],
  'src/price.ts': [
    "import { format } from './format.js'",
    '',
    'export function price$(amount: number): string {',
    '  return format(amount)',
    '}',
  ],
}
const PATHS = Object.keys(TREE)

function bodyHash(body: string): string {
  return createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').slice(0, 12)
}

interface Fixture {
  body: string
  pass: boolean
  labels?: string[]
  ancestor?: (pin: string) => boolean
}

interface Result {
  code: number
  stdout: string
  stderr: string
  requests: string[]
}

async function runGate(fixture: Fixture): Promise<Result> {
  const hash = bodyHash(fixture.body)
  const verdict = fixture.pass
    ? [{ body: `Issue-review: PASS at issue #76 body ${hash}\n`, user: { login: PASSER } }]
    : []
  const requests: string[] = []
  const server = await startFakeServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(url.pathname + url.search)
    const send = (payload: unknown): void => {
      const text = JSON.stringify(payload)
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
      response.end(text)
    }
    if (/^\/repos\/o\/r\/issues\/76$/.test(url.pathname)) {
      send({ number: 76, body: fixture.body, labels: (fixture.labels ?? []).map((name) => ({ name })) })
      return
    }
    if (/^\/repos\/o\/r\/issues\/76\/comments$/.test(url.pathname)) {
      send(verdict)
      return
    }
    if (/^\/repos\/o\/r\/commits\/main$/.test(url.pathname)) {
      send({ sha: MAIN })
      return
    }
    const compare = /^\/repos\/o\/r\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/.exec(url.pathname)
    if (compare !== null) {
      const pin = compare[1] ?? ''
      const ancestor = fixture.ancestor === undefined ? pin !== OTHER_PIN : fixture.ancestor(pin)
      send({ status: ancestor ? 'ahead' : 'diverged' })
      return
    }
    const tree = /^\/repos\/o\/r\/git\/trees\/([0-9a-f]+)$/.exec(url.pathname)
    if (tree !== null) {
      send({ sha: tree[1] ?? '', tree: PATHS.map((path) => ({ path, type: 'blob' })) })
      return
    }
    const contents = /^\/repos\/o\/r\/contents\/(.+)$/.exec(url.pathname)
    if (contents !== null) {
      const path = decodeURIComponent(contents[1] ?? '')
      const lines = TREE[path]
      if (lines === undefined) {
        const text = JSON.stringify({ message: 'Not Found' })
        response.writeHead(404, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
        response.end(text)
        return
      }
      send({ type: 'file', encoding: 'base64', content: Buffer.from(lines.join('\n'), 'utf8').toString('base64') })
      return
    }
    const text = JSON.stringify({ message: 'Not Found' })
    response.writeHead(404, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
    response.end(text)
  })
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [gateScript, '--issue', '76', '--repo', 'o/r', '--api-base', server.url, '--policy', policyPath])
    return { code: 0, stdout, stderr, requests }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: Number(failure.code ?? 1), stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? ''), requests }
  } finally {
    await server.close()
  }
}

function bodyWith(text: string): string {
  return `main = \`${PIN}\`\n\n${text}\n`
}

test('a cited line past the end of the file is bad evidence', async () => {
  const result = await runGate({ body: bodyWith('See `src/views/pages.ts:99999` for the helper.'), pass: true })
  assert.equal(result.code, 8)
  assert.match(result.stdout, /^issue-gate: bad-evidence #76 [0-9a-f]{12} ref=src\/views\/pages\.ts:99999 expected=line<=60 found=none$/m)
  // The reason names the ref and the file's real length at the pin.
  assert.match(result.stderr, /src\/views\/pages\.ts has 60 lines at 3d4b1a6/)
})

test('a symbol claimed as defined at a line that defines something else is bad evidence', async () => {
  const result = await runGate({ body: bodyWith('The console uses `localizeMessage` defined at `src/views/pages.ts:' + String(NOTICE_TEXT_LINE) + '`.'), pass: true })
  assert.equal(result.code, 8)
  assert.match(result.stdout, /^issue-gate: bad-evidence #76 [0-9a-f]{12} ref=localizeMessage expected=defined at src\/views\/pages\.ts:\d+ found=line$/m)
  // An occurrence-in-file rule would have passed this: the identifier is imported
  // on line 1. The gate reports what the cited line actually is instead.
  assert.match(result.stderr, /is `export function noticeText\(locale: string, notice: string\): string \{`/)
  assert.match(result.stderr, /`localizeMessage` is not defined in src\/views\/pages\.ts/)
})

test('a ref baked into the pin resolves even when the live line has moved', async () => {
  // This file is long enough at the pin that :1015 lands inside it; the point is
  // that resolution happens at the pin, not at live main.
  const result = await runGate({ body: bodyWith('The defect throws at `src/jobs/service.ts:1015` with `任务的产出的是盘点/清账类 issue`.'), pass: true })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^issue-gate: ok #76 [0-9a-f]{12}$/m)
})

test('a body that cites no evidence needs no pin and is judged as before', async () => {
  const result = await runGate({ body: 'A card that cites nothing at all.\n', pass: true })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^issue-gate: ok #76 [0-9a-f]{12}$/m)
  // No evidence work is done when there is nothing to resolve.
  assert.equal(result.requests.filter((path) => path.includes('/commits/main')).length, 0)
})

test('a ref-bearing body with no pin is bad evidence', async () => {
  const result = await runGate({ body: 'See `src/views/pages.ts:3` for the helper.\n', pass: true })
  assert.equal(result.code, 8)
  assert.match(result.stdout, /^issue-gate: bad-evidence #76 [0-9a-f]{12} ref=src\/views\/pages\.ts:3 expected=main=<sha> pin found=none$/m)
  assert.match(result.stderr, /names no `main` = <sha> pin/)
})

test('a pin that is not an ancestor of the live main is bad evidence', async () => {
  const body = `main = \`${OTHER_PIN}\`\n\nSee \`src/views/pages.ts:3\` for the helper.\n`
  const result = await runGate({ body, pass: true, ancestor: () => false })
  assert.equal(result.code, 8)
  assert.match(result.stdout, /^issue-gate: bad-evidence #76 [0-9a-f]{12} ref=94a80523a75586f5d00d1f0470e9b9c219669f38 expected=ancestor of live main found=none$/m)
  assert.match(result.stderr, /is not an ancestor of main dcf6698a/)
})

test('a file that is absent from the pinned tree is bad evidence', async () => {
  const result = await runGate({ body: bodyWith('See `test/workspace.test.ts:13`, which never renders the list.'), pass: true })
  assert.equal(result.code, 8)
  assert.match(result.stdout, /^issue-gate: bad-evidence #76 [0-9a-f]{12} ref=test\/workspace\.test\.ts:13 expected=file in the pinned tree found=none$/m)
})

test('the pinned tree and each file are read once, not once per ref', async () => {
  const result = await runGate({
    body: bodyWith('Refs `src/views/pages.ts:3`, `src/views/pages.ts:20` and `src/views/pages.ts:40` all point at one file.'),
    pass: true,
  })
  assert.equal(result.code, 0)
  const trees = result.requests.filter((path) => path.includes('/git/trees/'))
  const contents = result.requests.filter((path) => path.includes('/contents/'))
  assert.equal(trees.length, 1)
  assert.equal(contents.length, 1)
})

test('a card with no PASS at the live body still reports no-pass, whatever it cites', async () => {
  const result = await runGate({ body: bodyWith('See `src/views/pages.ts:99999` for the helper.'), pass: false })
  assert.equal(result.code, 2)
  assert.match(result.stdout, /^issue-gate: no-pass #76$/m)
  // Exit 8 comes after the hash check: nothing is resolved here.
  assert.equal(result.requests.filter((path) => path.includes('/git/trees/')).length, 0)
})

test('hold still wins over the evidence check', async () => {
  const result = await runGate({ body: bodyWith('See `src/views/pages.ts:99999` for the helper.'), pass: true, labels: ['hold'] })
  assert.equal(result.code, 7)
  assert.match(result.stdout, /^issue-gate: hold #76 [0-9a-f]{12}$/m)
})

test('a definition whose name ends in `$` is a definition, not bad evidence', async () => {
  // `$` is the one regex metacharacter an issue body can actually put in a
  // symbol. Escaping it for the pattern while every shape ended in `\b` made the
  // gate refuse a definition that is plainly there: `$` is a non-word character,
  // so `price\$\b` cannot match `price$(`. Comparing declaration tokens instead
  // of building a pattern removes the edge rather than re-escaping around it.
  const result = await runGate({ body: bodyWith('The formatter is `price$` defined at `src/price.ts:3`.'), pass: true })
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^issue-gate: ok #76 [0-9a-f]{12}$/m)
})
