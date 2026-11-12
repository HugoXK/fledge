import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { MemoryMailer, testConfig } from './helpers.js'
import { resetMetrics } from '../src/lib/metrics.js'

test('metrics require the configured token and expose Prometheus text', async () => {
  resetMetrics()
  const config = testConfig({ metrics: { token: 'metrics-secret' } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const denied = await built.app.inject({ method: 'GET', url: '/metrics' })
    assert.equal(denied.statusCode, 401)
    const allowed = await built.app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-secret' } })
    assert.equal(allowed.statusCode, 200)
    assert.match(allowed.body, /fledge_http_requests_total/)
  } finally {
    await built.close()
  }
})
