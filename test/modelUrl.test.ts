import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeModelUrl } from '../src/gateway/modelUrl.js'

test('private and HTTP model URLs require explicit opt-in', async () => {
  await assert.rejects(() => assertSafeModelUrl('http://192.168.1.5:11434/v1', false))
  assert.equal(await assertSafeModelUrl('http://192.168.1.5:11434/v1', true), 'http://192.168.1.5:11434/v1')

  await assert.rejects(() => assertSafeModelUrl('https://127.0.0.1:8443/v1', false))
  assert.equal(await assertSafeModelUrl('https://127.0.0.1:8443/v1', true), 'https://127.0.0.1:8443/v1')

  await assert.rejects(() => assertSafeModelUrl('http://localhost:11434/v1', false))
  assert.equal(await assertSafeModelUrl('http://localhost:11434/v1', true), 'http://localhost:11434/v1')
})
