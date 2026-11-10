import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

test('a superadmin can inspect and retry a failed webhook delivery', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'webhook-admin', status: 'approved', superadmin: true })
    const session = sessionFor(built, admin)
    store.claimWebhookDelivery('delivery-retry', 'ping', '', { payloadJson: '{"zen":"keep it simple"}', repositoryFullName: 'o/r', installationId: null })
    store.finishWebhookDelivery('delivery-retry', 'failed', 'temporary failure')

    const page = await built.app.inject({ method: 'GET', url: '/admin/webhooks', headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /delivery-retry|ping|temporary failure/)

    const retry = await built.app.inject({
      method: 'POST',
      url: '/admin/webhooks/delivery-retry/retry',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(retry.statusCode, 302)
    assert.equal(store.getWebhookDelivery('delivery-retry')?.status, 'processed')
    const audit = store.searchAudit(null, { action: 'admin.webhook_retry' }, 10, 0)
    assert.equal(audit.length, 1)
  } finally {
    await built.close()
  }
})
