import test from 'node:test'
import assert from 'node:assert/strict'
import { redact } from '../src/lib/redact.js'

// Every literal here is synthetic and assembled at runtime, never a real
// credential. The secret scan refuses token-shaped constants in the tree.
const GITHUB_TOKEN = ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'].join('')
const FINE_GRAINED = ['github_pat_', '11ABCDEFGHIJKLMNOP', 'QRSTUVWXYZ'].join('')
const BEARER_TOKEN = ['Bearer ', 'abcdefghijklmnopqrstuvwxyz'].join('')
const JWT = [
  'eyJ',
  'hbGciOiJIUzI1NiJ9',
  '.',
  'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
  '.',
  'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
].join('')
const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('')
const GOOGLE_KEY = ['AIza', 'SyA', '12345678901234567890123456789012'].join('')
const DASHES = '-'.repeat(5)
const PEM = [`${DASHES}BEGIN RSA PRIVATE KEY${DASHES}`, 'MIIESYNTHETICBODY', `${DASHES}END RSA PRIVATE KEY${DASHES}`].join('\n')

test('GitHub tokens lose their shape and their body', () => {
  const output = redact(`classic ${GITHUB_TOKEN} fine ${FINE_GRAINED}`)
  assert.equal(output.includes(GITHUB_TOKEN), false)
  assert.equal(output.includes(FINE_GRAINED), false)
  assert.match(output, /\[redacted-github-token\]/g)
})

test('a bearer header keeps the scheme and drops the credential', () => {
  const output = redact(`authorization: ${BEARER_TOKEN}`)
  assert.equal(output.includes('abcdefghijklmnopqrstuvwxyz'), false)
  assert.match(output, /Bearer \[redacted\]/)
})

test('a JWT is redacted whole, not one segment at a time', () => {
  const output = redact(`cookie ${JWT} done`)
  assert.equal(output.includes('eyJhbGciOiJIUzI1NiJ9'), false)
  assert.equal(output.includes('dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), false)
  assert.match(output, /\[redacted-jwt\]/)
})

test('cloud keys are recognised by their provider shape', () => {
  const output = redact(`aws ${AWS_KEY} google ${GOOGLE_KEY}`)
  assert.equal(output.includes(AWS_KEY), false)
  assert.equal(output.includes(GOOGLE_KEY), false)
  assert.match(output, /\[redacted-aws-key\]/)
  assert.match(output, /\[redacted-google-key\]/)
})

test('a PEM private-key block is redacted whole', () => {
  const output = redact(`before\n${PEM}\nafter`)
  assert.equal(output.includes('PRIVATE KEY'), false)
  assert.equal(output.includes('MIIESYNTHETICBODY'), false)
  assert.match(output, /\[redacted-private-key\]/)
})

test('token= and password= values are redacted where they appear', () => {
  const output = redact('https://example.test/cb?token=synthetic-token-value&x=1 password=synthetic-password')
  assert.equal(output.includes('synthetic-token-value'), false)
  assert.equal(output.includes('synthetic-password'), false)
  assert.match(output, /token=\[redacted\]/)
  assert.match(output, /password=\[redacted\]/)
})

test('credentials in a URL are removed even when no key names them', () => {
  const output = redact('clone https://user:super-secret-pass@example.test/repo.git now')
  assert.equal(output.includes('super-secret-pass'), false)
  assert.equal(output.includes('user:'), false)
  assert.match(output, /https:\/\/\[redacted-credentials\]@example\.test/)
})

test('redaction is deterministic and leaves ordinary text alone', () => {
  const text = `the build passed with ${GITHUB_TOKEN} and ${AWS_KEY}`
  assert.equal(redact(text), redact(text))
  const plain = 'AssertionError: expected 1 to equal 2 at test/foo.test.ts:10:3'
  assert.equal(redact(plain), plain)
})
