import test from 'node:test'
import assert from 'node:assert/strict'
import { log } from '../src/lib/log.js'
import { redact } from '../src/lib/secrets.js'

// #694: an account identifier must not reach a log sink, but it has to stay in
// the row and on the page, because that is where an operator acts on it. The two
// surfaces are therefore deliberately different and both are asserted here: the
// sink masks, `redact()` — which cleans what is stored and shown — does not grow
// a second job.
function captureLog(): { text: () => string; restore: () => void } {
  let captured = ''
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  const tap = (write: typeof process.stdout.write): typeof process.stdout.write =>
    ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return (write as unknown as (value: string | Uint8Array, ...args: unknown[]) => boolean)(chunk, ...rest)
    }) as unknown as typeof process.stdout.write
  process.stdout.write = tap(stdout.bind(process.stdout))
  process.stderr.write = tap(stderr.bind(process.stderr))
  return {
    text: () => captured,
    restore: () => {
      process.stdout.write = stdout
      process.stderr.write = stderr
    },
  }
}

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(3)}`

test('the log sink masks an email, a login, a user id and a token in every field', () => {
  const capture = captureLog()
  try {
    log.info('sign-in for alice@example.com', {
      email: 'alice@example.com',
      login: 'alicegh',
      userId: 'usr_abc123',
      token: TOKEN,
    })
  } finally {
    capture.restore()
  }
  const output = capture.text()
  for (const raw of ['alice@example.com', 'alicegh', 'usr_abc123', TOKEN]) {
    assert.ok(!output.includes(raw), `sink still carries ${raw}: ${output}`)
  }
  // Masked, not blanked: the operator can still tell two accounts apart.
  assert.match(output, /a\*\*\*@example\.com/)
  assert.match(output, /\[redacted-github-token\]/)
})

test('the log sink masks an email and a user id inside the message text', () => {
  const capture = captureLog()
  try {
    log.info('owner alice@example.com removed account usr_abc123 from the repo')
  } finally {
    capture.restore()
  }
  const output = capture.text()
  assert.ok(!output.includes('alice@example.com'), output)
  assert.ok(!output.includes('usr_abc123'), output)
  assert.match(output, /a\*\*\*@example\.com/)
})

test('the log sink masks an address but leaves a job id and a repo id alone', () => {
  const capture = captureLog()
  try {
    log.info('job finished', { jobId: 'job_01HXY', repoId: 'repo_42', ip: '203.0.113.7' })
  } finally {
    capture.restore()
  }
  const output = capture.text()
  assert.match(output, /job_01HXY/)
  assert.match(output, /repo_42/)
  assert.ok(!output.includes('203.0.113.7'), output)
  assert.match(output, /203\.0\.113\.0/)
})

test('what is stored and shown keeps the real identifier: redact() does not mask it', () => {
  // The row writer and the page read through `redact()`; masking there would
  // blank the account in the inbox, the job page and the stored row (#694).
  assert.equal(redact('alice@example.com'), 'alice@example.com')
})

// #694 review: the key table is an optimisation, not the contract. These four
// cases are the ones the first tip missed — an unlisted key, a nested object, an
// array and the live approval line — and each fails on the pre-review sink
// because it decided a string only by its key.
test('an unlisted field is masked by the shape of its value', () => {
  const capture = captureLog()
  try {
    log.info('approval requested', { user: 'alicegh', admin: 'root-admin@example.com' })
    log.info('owner removed', { note: 'contact alice@example.com about usr_abc123' })
  } finally {
    capture.restore()
  }
  const output = capture.text()
  for (const raw of ['root-admin@example.com', 'alice@example.com', 'usr_abc123', 'alicegh']) {
    assert.ok(!output.includes(raw), `sink still carries ${raw}: ${output}`)
  }
  assert.match(output, /r\*\*\*@example\.com/)
  assert.match(output, /"user":"a\*\*\*"/)
})

test('a nested object and an array cannot carry an identifier past the sink', () => {
  const capture = captureLog()
  try {
    log.info('account touched', {
      user: { email: 'alice@example.com', login: 'alicegh', id: 'usr_abc123' },
      repos: ['alicegh/fledge', 'bob/flybot'],
      meta: { contact: { to: 'bob@example.com' } },
    })
  } finally {
    capture.restore()
  }
  const output = capture.text()
  for (const raw of ['alice@example.com', 'alicegh', 'bob/flybot', 'bob@example.com', 'usr_abc123']) {
    assert.ok(!output.includes(raw), `sink still carries ${raw}: ${output}`)
  }
  assert.match(output, /a\*\*\*@example\.com/)
  assert.match(output, /a\*\*\*\/fledge/)
})

test('a repository field keeps the name and masks the owner login', () => {
  const capture = captureLog()
  try {
    log.info('job finished', { repo: 'alicegh/fledge', repository: 'bob/flybot', repoId: 'repo_42' })
  } finally {
    capture.restore()
  }
  const output = capture.text()
  assert.ok(!output.includes('alicegh'), output)
  assert.ok(!output.includes('bob/flybot'), output)
  assert.match(output, /a\*\*\*\/fledge/)
  assert.match(output, /b\*\*\*\/flybot/)
  assert.match(output, /repo_42/, 'a repository id is not an account identifier')
})

test('a cyclic field is cut, not thrown', () => {
  const capture = captureLog()
  const cyclic: Record<string, unknown> = { email: 'alice@example.com' }
  cyclic.self = cyclic
  try {
    log.info('cycle', { user: cyclic })
  } finally {
    capture.restore()
  }
  const output = capture.text()
  assert.ok(!output.includes('alice@example.com'), output)
  assert.match(output, /"self":"\[circular\]"/)
})
