import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { randomToken } from '../src/lib/secrets.js'
import { log } from '../src/lib/log.js'
import { flashOf, formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

async function fixture(config = testConfig()) {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'feedback-user', status: 'approved' })
  const session = sessionFor(built, user)
  return { built, store, mailer, user, session, cookie: `${session.cookie}; fledge_lang=en` }
}

test('the settings page offers feedback and a Star link', async () => {
  const f = await fixture()
  try {
    const response = await f.built.app.inject({ method: 'GET', url: '/settings', headers: { cookie: f.cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /id="feedback"/)
    assert.match(response.body, /action="\/feedback"/)
    assert.match(response.body, /Star Fledge on GitHub/)
    assert.match(response.body, /About Fledge/)
  } finally {
    await f.built.close()
  }
})

test('feedback is stored, audited and mailed to the fallback admin address', async () => {
  const f = await fixture()
  try {
    const response = await f.built.app.inject({
      method: 'POST',
      url: '/feedback',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: f.cookie },
      payload: formBody({ csrf: f.session.csrf, kind: 'bug', message: 'The schedule page shows an unknown value.', page: '/repos/repo/ schedule' }),
    })
    assert.equal(response.statusCode, 302)
    assert.match(String(response.headers.location), /#feedback/)
    const rows = f.store.listFeedback(10)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.kind, 'bug')
    assert.equal(rows[0]?.page, '/repos/repo/ schedule')
    assert.match(rows[0]?.message ?? '', /unknown value/)
    const mail = f.mailer.messages.find((message) => /用户反馈/.test(message.subject))
    assert.ok(mail, 'the feedback mail was sent')
    assert.equal(mail.to, 'admin@example.com')
    assert.match(mail.text, /feedback-user/)
    assert.match(mail.text, /unknown value/)
    assert.ok(f.store.listAudit(20).some((row) => row.action === 'feedback.created'))
    const flash = flashOf(response)
    assert.match(flash?.notice?.text ?? '', /反馈已发送/)
  } finally {
    await f.built.close()
  }
})

test('empty feedback is refused and CSRF is required', async () => {
  const f = await fixture()
  try {
    const empty = await f.built.app.inject({
      method: 'POST',
      url: '/feedback',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: f.cookie },
      payload: formBody({ csrf: f.session.csrf, kind: 'feedback', message: '   ' }),
    })
    assert.equal(empty.statusCode, 302)
    assert.match(flashOf(empty)?.error?.text ?? '', /请填写反馈内容/)
    assert.equal(f.store.listFeedback(10).length, 0)

    const noCsrf = await f.built.app.inject({
      method: 'POST',
      url: '/feedback',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: f.cookie },
      payload: formBody({ kind: 'feedback', message: 'hello' }),
    })
    assert.equal(noCsrf.statusCode, 403)
    assert.equal(f.store.listFeedback(10).length, 0)
  } finally {
    await f.built.close()
  }
})

test('FEEDBACK_EMAIL overrides the fallback destination', async () => {
  const base = testConfig()
  const config = testConfig({ mail: { ...base.mail, feedbackEmail: 'feedback@example.com' } })
  const f = await fixture(config)
  try {
    await f.built.app.inject({
      method: 'POST',
      url: '/feedback',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: f.cookie },
      payload: formBody({ csrf: f.session.csrf, kind: 'feedback', message: 'route it to feedback' }),
    })
    assert.equal(f.mailer.messages.find((message) => /用户反馈/.test(message.subject))?.to, 'feedback@example.com')
  } finally {
    await f.built.close()
  }
})

test('a 5xx error captures a ref, one click reports it, and a 4xx has no report button', async () => {
  const f = await fixture()
  const originalListRepos = f.store.listRepos.bind(f.store)
  try {
    Object.defineProperty(f.store, 'listRepos', { value: () => { throw new Error('boom') }, configurable: true })
    const broken = await f.built.app.inject({ method: 'GET', url: '/console?token=secret', headers: { cookie: f.cookie } })
    assert.equal(broken.statusCode, 500)
    assert.match(broken.body, /Report to the maintainer/)
    const ref = /action="\/errors\/([A-Za-z0-9_-]+)\/report"/.exec(broken.body)?.[1]
    assert.ok(ref, 'the error page carries the report ref')
    const report = f.store.errorReportByRef(ref)
    assert.ok(report)
    assert.equal(report.status_code, 500)
    assert.equal(report.path, '/console', 'the query string is not stored')
    assert.equal(report.user_login, 'feedback-user')
    assert.equal(report.error_message, 'boom')

    const noConsent = await f.built.app.inject({ method: 'POST', url: `/errors/${ref}/report`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: formBody({}) })
    assert.equal(noConsent.statusCode, 400)
    assert.equal(f.store.errorReportByRef(ref)?.status, 'captured', 'consent is required before the report is sent')
    assert.equal(f.mailer.messages.filter((message) => /异常报告/.test(message.subject)).length, 0)

    const first = await f.built.app.inject({ method: 'POST', url: `/errors/${ref}/report`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: formBody({ consent: '1' }) })
    assert.equal(first.statusCode, 200)
    assert.equal(f.store.errorReportByRef(ref)?.status, 'reported')
    assert.equal(f.store.errorReportByRef(ref)?.consent_version, '2026-11-15')
    assert.ok(f.store.errorReportByRef(ref)?.consented_at)
    assert.equal(f.mailer.messages.filter((message) => /异常报告/.test(message.subject)).length, 1)
    assert.ok(f.store.listAudit(20).some((row) => row.action === 'error.reported'))

    const second = await f.built.app.inject({ method: 'POST', url: `/errors/${ref}/report`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: formBody({ consent: '1' }) })
    assert.equal(second.statusCode, 200)
    assert.equal(f.mailer.messages.filter((message) => /异常报告/.test(message.subject)).length, 1, 'a second click does not mail twice')
  } finally {
    Object.defineProperty(f.store, 'listRepos', { value: originalListRepos, configurable: true })
    await f.built.close()
  }
})

test('a 4xx page does not offer an error report', async () => {
  const f = await fixture()
  try {
    const missing = await f.built.app.inject({ method: 'GET', url: '/does-not-exist', headers: { cookie: f.cookie } })
    assert.equal(missing.statusCode, 404)
    assert.doesNotMatch(missing.body, /Report to the maintainer/)
  } finally {
    await f.built.close()
  }
})

// #845: /approve/:token carries the whole approval capability in the path. A 5xx
// used to store the concrete URL in error_reports.path, which reaches the
// maintainer mail, the audit row and the triage endpoint, so the route pattern is
// the only safe capture.
test('a 5xx on an approval link stores the route pattern, never the live token', async () => {
  const f = await fixture()
  const originalFind = f.store.findApprovalToken.bind(f.store)
  const originalLogError = log.error
  const logged: Array<Record<string, unknown>> = []
  try {
    const token = randomToken(32)
    Object.defineProperty(f.store, 'findApprovalToken', { value: () => { throw new Error('boom') }, configurable: true })
    log.error = (message: string, fields?: Record<string, unknown>) => { logged.push({ message, ...fields }) }
    const broken = await f.built.app.inject({ method: 'GET', url: `/approve/${token}`, headers: { cookie: f.cookie } })
    assert.equal(broken.statusCode, 500)
    const ref = /action="\/errors\/([A-Za-z0-9_-]+)\/report"/.exec(broken.body)?.[1]
    assert.ok(ref, 'the error page carries the report ref')
    const report = f.store.errorReportByRef(ref)
    assert.ok(report)
    assert.equal(report.path, '/approve/:token', 'the stored path must be the matched route pattern')
    assert.equal(JSON.stringify(report).includes(token), false, 'the report row must not carry the token')
    assert.deepEqual(logged.filter((fields) => JSON.stringify(fields).includes(token)), [], 'the log line must not carry the token')
    assert.ok(logged.some((fields) => fields.url === '/approve/:token'), 'the log line must name the pattern')

    const post = await f.built.app.inject({
      method: 'POST',
      url: `/approve/${token}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({}),
    })
    assert.equal(post.statusCode, 500)
    const postRef = /action="\/errors\/([A-Za-z0-9_-]+)\/report"/.exec(post.body)?.[1]
    assert.ok(postRef)
    assert.equal(f.store.errorReportByRef(postRef)?.path, '/approve/:token', 'the POST route stores its pattern too')

    const reported = await f.built.app.inject({
      method: 'POST',
      url: `/errors/${ref}/report`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ consent: '1' }),
    })
    assert.equal(reported.statusCode, 200)
    const mails = f.mailer.messages.filter((message) => /异常报告/.test(message.subject))
    assert.ok(mails.length >= 1, 'the report is mailed')
    for (const mail of mails) assert.equal(mail.text.includes(token), false, 'the mail must not carry the token')
    assert.equal(JSON.stringify(f.store.listAudit(50)).includes(token), false, 'no audit row may carry the token')
  } finally {
    log.error = originalLogError
    Object.defineProperty(f.store, 'findApprovalToken', { value: originalFind, configurable: true })
    await f.built.close()
  }
})
