import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { Approvals } from '../src/users/approval.js'
import { MockRunner } from '../src/jobs/mock.js'
import { humanTimeShort } from '../src/lib/time.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #1088: the approval page has to name the instant the queue orders by. An
// account exists from the first sign-in, and the application can arrive days
// later, so `created_at` and `application_submitted_at` diverge. The admin's
// pending table and the queue position already use the submission time; the
// approval mail's link page must answer the same question with the same instant.
const SIGNED_IN = '2026-11-01T09:12:44.000Z'
const APPLIED = '2026-11-10T08:00:00.000Z'

async function renderApprovalPage(input: { locale: 'zh' | 'en'; created: string; submitted: string | null }) {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const applicant = makeUser(store, { login: 'applied-later', status: 'pending' })
    store.db.exec(
      `UPDATE users SET created_at = '${input.created}', application_submitted_at = ${input.submitted === null ? 'NULL' : `'${input.submitted}'`} WHERE id = '${applicant.id}'`,
    )
    const user = store.userById(applicant.id)
    assert.ok(user)
    const sent = await new Approvals(store, config, mailer).request(user)
    assert.equal(sent.sent, true, 'the approval mail must be sent for a pending application')
    const token = sent.approveUrl?.split('/approve/')[1]
    assert.ok(token, 'the mail carries an approval link')
    const page = await built.app.inject({
      method: 'GET',
      url: `/approve/${token}`,
      headers: { cookie: `fledge_lang=${input.locale}` },
    })
    assert.equal(page.statusCode, 200)
    return page.body
  } finally {
    await built.app.close()
  }
}

test('#1088: the approval page names the application time, not the sign-in time', async (t) => {
  assert.notEqual(humanTimeShort(SIGNED_IN), humanTimeShort(APPLIED), 'the two instants must render differently or the assertion proves nothing')
  const applied = humanTimeShort(APPLIED)
  const signedIn = humanTimeShort(SIGNED_IN)

  await t.test('zh arm', async () => {
    const body = await renderApprovalPage({ locale: 'zh', created: SIGNED_IN, submitted: APPLIED })
    assert.match(body, new RegExp(`申请时间 ${applied.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the zh page must show the submission instant')
    assert.equal(body.includes(signedIn), false, 'the zh page must not show the account creation instant as the application time')
  })

  await t.test('en arm', async () => {
    const body = await renderApprovalPage({ locale: 'en', created: SIGNED_IN, submitted: APPLIED })
    assert.match(body, new RegExp(`Applied ${applied.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the en page must show the submission instant')
    assert.equal(body.includes(signedIn), false, 'the en page must not show the account creation instant as the application time')
  })

  await t.test('legacy pending row without a submission time still shows one instant', async () => {
    // Rows that predate `application_submitted_at` have no submission instant;
    // the page must fall back to the creation time rather than print a dash.
    const body = await renderApprovalPage({ locale: 'zh', created: SIGNED_IN, submitted: null })
    assert.match(body, new RegExp(`申请时间 ${humanTimeShort(SIGNED_IN).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the fallback names the creation instant')
  })
})
