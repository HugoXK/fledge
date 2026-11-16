import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #544 slice 7: the operator surface of the outbox. The state machine is tested
// without HTTP in `notificationOutbox.test.ts`; these tests pin what a person
// sees and the one action they have: `unknown` must be readable as "may have
// arrived", and a resend must queue the same row under its own idempotency key
// with an audit line.

function seed(store: Store, id: string, state: string, key: string): void {
  const queued = store.enqueueNotification({
    transport: 'email',
    destination: 'owner@example.com',
    userId: null,
    payload: { subject: 'Digest', text: 'Body' },
    idempotencyKey: key,
  })
  store.run(
    "UPDATE notification_outbox SET state = ?, attempts = 2, last_error = 'lease-expired' WHERE id = ?",
    state, queued.row.id,
  )
}

test('a superadmin sees every outbox state in their own language and can resend an unknown row', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'outbox-admin', status: 'approved', superadmin: true })
    const session = sessionFor(built, admin)
    seed(store, 'outbox-unknown', 'unknown', 'digest:one:email')
    seed(store, 'outbox-sent', 'sent', 'digest:two:email')

    const en = await built.app.inject({ method: 'GET', url: '/admin/notifications', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    assert.equal(en.statusCode, 200)
    assert.match(en.body, /Notification outbox/)
    assert.match(en.body, /Unknown 1/)
    assert.match(en.body, /Delivered 1/)
    assert.match(en.body, /o\*\*\*@example\.com/, 'the address is shown masked, never in full')
    assert.doesNotMatch(en.body, /<td>Body<\/td>/, 'the payload body is not rendered')
    assert.match(en.body, /may have arrived/, 'unknown is explained, not shown as a plain failure')

    const resend = await built.app.inject({
      method: 'POST',
      url: `/admin/notifications/${store.listNotificationOutbox({ state: 'unknown' }, 1, 0)[0]!.id}/resend`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(resend.statusCode, 302)
    const queued = store.listNotificationOutbox({ state: 'pending' }, 10, 0)
    assert.equal(queued.length, 1)
    assert.equal(queued[0]?.idempotency_key, 'digest:one:email', 'the resend reuses the same idempotency key')
    assert.equal(queued[0]?.attempts, 2, 'the attempt history survives the resend')
    const audit = store.searchAudit(null, { action: 'notification.resend' }, 10, 0)
    assert.equal(audit.length, 1)

    const sent = store.listNotificationOutbox({ state: 'sent' }, 1, 0)[0]!
    const refused = await built.app.inject({
      method: 'POST',
      url: `/admin/notifications/${sent.id}/resend`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(refused.statusCode, 302)
    assert.equal(store.getNotificationOutbox(sent.id)?.state, 'sent', 'a delivered row is not reopened')
  } finally {
    await built.close()
  }
})

test('the outbox page is superadmin-only', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'plain-admin', status: 'approved', admin: true })
    const session = sessionFor(built, admin)
    seed(store, 'outbox-hidden', 'dead', 'digest:hidden:email')
    const page = await built.app.inject({ method: 'GET', url: '/admin/notifications', headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 403)
  } finally {
    await built.close()
  }
})
