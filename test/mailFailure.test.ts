import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { Approvals } from '../src/users/approval.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex, randomToken } from '../src/lib/secrets.js'
import type { MailMessage } from '../src/email/mailer.js'
import { formBody, makeUser, sessionFor, testConfig } from './helpers.js'

class FailingMailer {
  messages: MailMessage[] = []
  constructor(private readonly detail = 'connect ECONNREFUSED 127.0.0.1:2525') {}
  async send(message: MailMessage): Promise<void> {
    this.messages.push(message)
    throw new Error(this.detail)
  }
}

test('an approval mail that cannot be sent is visible to the admin and to the applicant', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new FailingMailer()
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'root-admin', superadmin: true, status: 'approved' })
    const applicant = makeUser(store, { login: 'mail-fail', status: 'pending' })

    const approvals = new Approvals(store, config, mailer)
    await assert.rejects(approvals.request(applicant))

    const failure = store.listAudit(20).find((row) => row.action === 'approval.mail_failed')
    assert.ok(failure, 'a failed approval mail writes an approval.mail_failed audit entry')
    assert.equal(failure.user_id, applicant.id)

    const adminSession = sessionFor(built, admin)
    const adminPage = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie: adminSession.cookie } })
    assert.equal(adminPage.statusCode, 200)
    assert.match(adminPage.body, /审批邮件发送失败/)
    assert.match(adminPage.body, /重新发送审批邮件/)

    const applicantSession = sessionFor(built, applicant)
    const statusPage = await built.app.inject({ method: 'GET', url: '/apply/status', headers: { cookie: applicantSession.cookie } })
    assert.equal(statusPage.statusCode, 200)
    assert.match(statusPage.body, /审批邮件未送达管理员/)
  } finally {
    await built.app.close()
  }
})

test('an admin can resend the approval mail from the pending list', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new FailingMailer()
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'root-admin', superadmin: true, status: 'approved' })
    const applicant = makeUser(store, { login: 'mail-retry', status: 'pending' })
    await assert.rejects(new Approvals(store, config, mailer).request(applicant))

    const session = sessionFor(built, admin)
    const resend = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${applicant.id}/resend-approval`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(resend.statusCode, 302)
    assert.equal(store.listAudit(20).filter((row) => row.action === 'approval.mail_failed').length, 2)

    const withoutCsrf = await built.app.inject({
      method: 'POST',
      url: `/admin/users/${applicant.id}/resend-approval`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    })
    assert.equal(withoutCsrf.statusCode, 403)
  } finally {
    await built.app.close()
  }
})

test('an expired approval link is a 404 and does not change the application', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new (class { async send(): Promise<void> {} })(), runner: new MockRunner(), startScheduler: false })
  try {
    const applicant = makeUser(store, { login: 'expired-link', status: 'pending' })
    const token = randomToken(32)
    store.createApprovalToken(sha256Hex(token), applicant.id, 'approve', new Date(Date.now() - 86_400_000).toISOString())

    const page = await built.app.inject({ method: 'GET', url: `/approve/${token}` })
    assert.equal(page.statusCode, 404)
    const action = await built.app.inject({ method: 'POST', url: `/approve/${token}` })
    assert.equal(action.statusCode, 400)
    assert.equal(store.userById(applicant.id)?.status, 'pending')
  } finally {
    await built.app.close()
  }
})

test('a token-shaped string in a mail failure never reaches the audit detail', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const fake = ['ghp', 'a'.repeat(30)].join('_')
  const mailer = new FailingMailer(`smtp auth failed with ${fake}`)
  const applicant = makeUser(store, { login: 'leaky-error', status: 'pending' })

  await assert.rejects(new Approvals(store, config, mailer).request(applicant))

  const failure = store.listAudit(20).find((row) => row.action === 'approval.mail_failed')
  assert.ok(failure)
  const detail = String(failure.detail ?? '')
  assert.equal(detail.includes(fake), false)
  assert.match(detail, /\[redacted-github-token\]/)
})

test('the mail probe reports transport and elapsed time, never the address or a secret', async () => {
  const { probeMail } = await import('../src/lib/mailProbe.js')
  const dataDir = mkdtempSync(join(tmpdir(), 'fledge-probe-'))
  const consoleResult = await probeMail(testConfig({ dataDir, mail: { ...testConfig().mail, transport: 'console' } }), 'ops@example.com')
  assert.equal(consoleResult.ok, true)
  assert.equal(consoleResult.transport, 'console')
  assert.ok(consoleResult.elapsedMs >= 0)
  assert.equal(consoleResult.summary.includes('ops@example.com'), false)
  assert.equal(readdirSync(join(dataDir, 'mail-outbox')).filter((name) => name.endsWith('.eml')).length, 1)

  const refused = await probeMail(
    testConfig({ mail: { ...testConfig().mail, transport: 'smtp', smtp: { host: '127.0.0.1', port: 1, secure: false, user: '', pass: '' } } }),
    'ops@example.com',
  )
  assert.equal(refused.ok, false)
  assert.equal(refused.summary.includes('ops@example.com'), false)
})
