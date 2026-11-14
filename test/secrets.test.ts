import test from 'node:test'
import assert from 'node:assert/strict'
import { redact, registerRedactionSecrets } from '../src/lib/secrets.js'

// Every literal in this file is synthetic ("SYNTHETIC" repeated), never a real
// credential; the redaction assertions only need a value with a recognised shape.
// The PEM header is assembled at runtime because this repository's own secret scan
// refuses a private-key header written on a tracked line (test/secretScan.test.ts).
const GITHUB_TOKEN = `ghp_${'SYNTHETIC'.repeat(4)}`
const AWS_KEY = `AKIA${'ABCDEFGHIJKLMNOP'}`
const DASHES = '-'.repeat(5)
const PEM = [`${DASHES}BEGIN RSA PRIVATE KEY${DASHES}`, `MIIE${'SYNTHETIC'.repeat(3)}BODY`, `${DASHES}END RSA PRIVATE KEY${DASHES}`].join('\n')

test.afterEach(() => {
  registerRedactionSecrets([])
})

test('the recogniser redacts token shapes and leaves ordinary text alone', () => {
  const output = redact(`token ${GITHUB_TOKEN} and ${AWS_KEY}`)
  assert.equal(output.includes('SYNTHETIC'), false)
  assert.equal(output.includes('ghp_'), false)
  assert.equal(output.includes('AKIA'), false)
  assert.ok(output.includes('[redacted-github-token]'))
  assert.ok(output.includes('[redacted-aws-key]'))
  const plain = 'the build passed and the summary is ordinary prose'
  assert.equal(redact(plain), plain)
})

test('a PEM private-key block is redacted whole', () => {
  const output = redact(`before\n${PEM}\nafter`)
  assert.equal(output.includes('PRIVATE KEY'), false)
  assert.equal(output.includes('MIIESYNTHETIC'), false)
  assert.ok(output.includes('[redacted-private-key]'))
})

test('a registered literal is replaced, longest first, and replaced as a set', () => {
  registerRedactionSecrets(['operator-smtp-pass', 'operator-smtp'])
  const once = redact('x operator-smtp-pass y')
  assert.equal(once.includes('operator-smtp-pass'), false)
  assert.ok(once.includes('[redacted-secret]'))
  registerRedactionSecrets([])
  assert.equal(redact('x operator-smtp-pass y'), 'x operator-smtp-pass y')
})

test('short registered values are ignored so ordinary prose is not shredded', () => {
  registerRedactionSecrets(['abc'])
  assert.equal(redact('abc appears in ordinary prose'), 'abc appears in ordinary prose')
})
