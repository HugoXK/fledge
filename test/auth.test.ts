import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { MemoryMailer, testConfig } from './helpers.js'

test('token login is disabled once OAuth is configured', async () => {
  const config = testConfig({ allowTokenLoginOnly: false })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const response = await built.app.inject({ method: 'POST', url: '/auth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'token=abc' })
    assert.equal(response.statusCode, 403)
    assert.match(String(response.headers['content-type']), /text\/html/)
    assert.match(response.body, /OAuth 已启用/)
  } finally {
    await built.close()
  }
})
