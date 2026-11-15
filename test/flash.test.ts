import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeFlash, encodeFlash, readRedirectMessage } from '../src/lib/flash.js'

test('a flash round-trips both messages and their keys', () => {
  const state = {
    error: { text: 'INSTANCE_NOT_READY: the bridge is down', key: 'INSTANCE_NOT_READY:the bridge is down' },
    notice: { text: 'Saved.', key: 'Saved.' },
  }
  assert.deepEqual(decodeFlash(encodeFlash(state)), state)
})

test('decoding rejects a cookie that is not the shape the page wrote', () => {
  const raw = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')
  assert.equal(decodeFlash(undefined), undefined)
  assert.equal(decodeFlash(''), undefined)
  assert.equal(decodeFlash('not base64 !!!'), undefined)
  assert.equal(decodeFlash(raw('[]')), undefined)
  assert.equal(decodeFlash(raw('"text"')), undefined)
  assert.equal(decodeFlash(raw('{"n":{}}')), undefined, 'a message without text is not a message')
  assert.equal(decodeFlash(raw('{"n":{"t":"   "}}')), undefined, 'blank text is not a message')
  assert.equal(decodeFlash(raw(`{"n":{"t":"x"}}`.repeat(1) + ' '.repeat(5000))), undefined, 'an oversized cookie is refused')
  assert.deepEqual(decodeFlash(raw('{"n":{"t":"ok","k":"key"},"extra":"ignored"}')), { notice: { text: 'ok', key: 'key' } })
})

test('decoding caps a field a client could grow', () => {
  const long = 'x'.repeat(900)
  const state = decodeFlash(Buffer.from(JSON.stringify({ n: { t: long, k: long } }), 'utf8').toString('base64url'))
  assert.equal(state?.notice?.text.length, 500)
  assert.equal(state?.notice?.key.length, 80)
})

test('a local redirect moves its message out of Location and keeps the rest of the URL', () => {
  const flashed = readRedirectMessage('/repos/r1?notice=Saved%20it.&order=3#work')
  assert.ok(flashed)
  assert.equal(flashed.location, '/repos/r1?order=3#work')
  assert.deepEqual(flashed.state, { notice: { text: 'Saved it.', key: 'Saved it.' } })
})

test('a refusal keeps its code as the event id and the code leaves the URL with the message', () => {
  const flashed = readRedirectMessage('/repos/r1?error=QUEUE_FULL%3A%20wait&code=QUEUE_FULL')
  assert.ok(flashed)
  assert.equal(flashed.location, '/repos/r1')
  assert.deepEqual(flashed.state, { error: { text: 'QUEUE_FULL: wait', key: 'QUEUE_FULL:QUEUE_FULL: wait' } })
})

test('a redirect with no message is not rewritten, and an external or hostile Location is never read', () => {
  assert.equal(readRedirectMessage('/repos/r1?order=3'), undefined)
  assert.equal(readRedirectMessage('https://github.com/o/r?notice=x'), undefined)
  assert.equal(readRedirectMessage('//evil.example/?notice=x'), undefined)
  assert.equal(readRedirectMessage('repos/r1?notice=x'), undefined)
})

test('a long message is capped before it reaches a cookie', () => {
  const long = 'y'.repeat(900)
  const flashed = readRedirectMessage(`/dashboard?error=${encodeURIComponent(long)}`)
  assert.equal(flashed?.state.error?.text.length, 500)
  assert.equal(flashed?.state.error?.key.length, 500)
})
