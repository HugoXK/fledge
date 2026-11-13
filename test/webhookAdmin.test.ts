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

// #412: a delivery's stored state is an internal code. The console names the
// three states in the reader's language and keeps the code only as the filter
// value, so `?status=processed` still links and filters as before.
test('the webhook delivery states are named in the console language', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'webhook-labels', status: 'approved', superadmin: true })
    const session = sessionFor(built, admin)
    const seed = { payloadJson: '{}', repositoryFullName: 'o/r', installationId: null }
    store.claimWebhookDelivery('delivery-processing', 'ping', null, seed)
    store.claimWebhookDelivery('delivery-processed', 'push', null, seed)
    store.finishWebhookDelivery('delivery-processed', 'processed', null)
    store.claimWebhookDelivery('delivery-failed', 'check_run', null, seed)
    store.finishWebhookDelivery('delivery-failed', 'failed', 'temporary failure')

    const zh = await built.app.inject({ method: 'GET', url: '/admin/webhooks', headers: { cookie: `${session.cookie}; fledge_lang=zh` } })
    assert.equal(zh.statusCode, 200)
    assert.match(zh.body, /<span class="badge busy">处理中<\/span>/, 'the processing row badge is Chinese')
    assert.match(zh.body, /<span class="badge good">已处理<\/span>/, 'the processed row badge is Chinese')
    assert.match(zh.body, /<span class="badge bad">失败<\/span>/, 'the failed row badge is Chinese')
    assert.match(zh.body, /<option value="processing">处理中<\/option>/, 'the filter labels processing in Chinese and keeps the code as its value')
    assert.match(zh.body, /<option value="processed">已处理<\/option>/, 'the filter labels processed in Chinese and keeps the code as its value')
    assert.match(zh.body, /<option value="failed">失败<\/option>/, 'the filter labels failed in Chinese and keeps the code as its value')
    assert.doesNotMatch(zh.body, />\s*(processing|processed|failed)\s*</, 'the Chinese page shows no raw delivery state')

    const en = await built.app.inject({ method: 'GET', url: '/admin/webhooks', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    assert.match(en.body, /<span class="badge busy">Processing<\/span>/, 'the English badge set is translated too')
    assert.match(en.body, /<span class="badge good">Processed<\/span>/)
    assert.match(en.body, /<span class="badge bad">Failed<\/span>/)
    assert.match(en.body, /<option value="failed">Failed<\/option>/, 'the English filter keeps the code as its value')

    const filtered = await built.app.inject({ method: 'GET', url: '/admin/webhooks?status=failed', headers: { cookie: `${session.cookie}; fledge_lang=zh` } })
    assert.match(filtered.body, /<option value="failed" selected>失败<\/option>/, 'a pre-selected filter reads in the console language')
  } finally {
    await built.close()
  }
})
