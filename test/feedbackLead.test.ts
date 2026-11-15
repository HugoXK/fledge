import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { buildTriagePacket, deliverFeedbackToLead, publicIssueDraft, triageToken } from '../src/feedback/lead.js'
import { notifyReleasedFeedback } from '../src/feedback/notify.js'
import { json, makeUser, MemoryMailer, readBody, startFakeServer, testConfig } from './helpers.js'

function fixture() {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'reporter', status: 'approved' })
  const feedback = store.createFeedback({ id: 'fb_lead', userId: user.id, kind: 'feedback', message: 'The schedule page says unknown', page: '/settings' })
  const triage = store.createFeedbackTriage({ ref: feedback.id, userId: user.id, userLogin: user.login, kind: 'feedback', publishConsent: true })
  return { store, user, feedback, triage }
}

test('the packet names the ref, consent and signed triage endpoints', () => {
  const f = fixture()
  try {
    const config = testConfig()
    const packet = buildTriagePacket({ config, triage: f.triage, feedback: f.feedback })
    assert.match(packet, /ref: fb_lead/)
    assert.match(packet, /publishConsent: yes/)
    assert.match(packet, /\/api\/feedback\/fb_lead/)
    assert.match(packet, new RegExp(triageToken(config.sessionSecret, 'fb_lead')))
    assert.match(packet, /Never paste the raw message, stack, email or token/)
  } finally {
    f.store.close()
  }
})


test('the public issue draft mentions the reporter only with publication consent', () => {
  const f = fixture()
  try {
    const draft = publicIssueDraft(f.triage)
    assert.match(draft.body, /@reporter/)
    assert.match(draft.body, /fb_lead/)
    const noConsent = publicIssueDraft({ ...f.triage, publish_consent: 0 })
    assert.doesNotMatch(noConsent.body, /@reporter/)
    assert.equal(noConsent.mention, '')
  } finally {
    f.store.close()
  }
})

test('a configured repo target sends through the instance manager', async () => {
  const f = fixture()
  try {
    const base = testConfig()
    const config = testConfig({ feedback: { ...base.feedback, leadRepoId: 'repo_fledge' } })
    let captured: { repo: string; target: string; text: string } | undefined
    const instances = {
      async sendGuidance(repo: string, target: string, text: string) { captured = { repo, target, text } },
    }
    const result = await deliverFeedbackToLead({ config, instances, triage: f.triage, feedback: f.feedback })
    assert.deepEqual(result, { ok: true, mode: 'repo' })
    assert.equal(captured?.repo, 'repo_fledge')
    assert.equal(captured?.target, 'lead')
    assert.match(captured?.text ?? '', /ref: fb_lead/)
  } finally {
    f.store.close()
  }
})

test('a configured bridge target posts a send to the configured session', async () => {
  const f = fixture()
  const server = await startFakeServer(async (request, response) => {
    const body = JSON.parse((await readBody(request)).toString('utf8')) as { endpoint: string; payload: { sessionId: string; text: string } }
    assert.equal(request.headers.authorization, 'Bearer bridge-token')
    assert.equal(body.endpoint, 'send')
    assert.equal(body.payload.sessionId, 'lead-session')
    assert.match(body.payload.text, /ref: fb_lead/)
    json(response, 200, { ok: true })
  })
  try {
    const base = testConfig()
    const config = testConfig({ feedback: { ...base.feedback, leadRepoId: '', leadBridgeUrl: server.url, leadBridgeToken: 'bridge-token', leadSessionId: 'lead-session' } })
    const result = await deliverFeedbackToLead({ config, instances: undefined, triage: f.triage, feedback: f.feedback })
    assert.deepEqual(result, { ok: true, mode: 'bridge' })
  } finally {
    f.store.close()
    await server.close()
  }
})

test('the triage API reads and writes with the per-ref token and notifies the reporter', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'api-reporter', status: 'approved' })
    const feedback = store.createFeedback({ id: 'fb_api', userId: user.id, kind: 'bug', message: 'boom', page: '/dashboard' })
    store.createFeedbackTriage({ ref: feedback.id, userId: user.id, userLogin: user.login, kind: 'bug', publishConsent: true })
    const token = triageToken(config.sessionSecret, feedback.id)
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

    const read = await built.app.inject({ method: 'GET', url: '/api/feedback/fb_api', headers })
    assert.equal(read.statusCode, 200)
    const readBodyJson = read.json() as { triage: { ref: string }, issueDraft: { body: string } }
    assert.equal(readBodyJson.triage.ref, 'fb_api')
    assert.match(readBodyJson.issueDraft.body, /fb_api/)

    const written = await built.app.inject({
      method: 'POST',
      url: '/api/feedback/fb_api/triage',
      headers,
      payload: { status: 'fixed', user_message: 'The schedule fix is ready.', issue_url: 'https://github.com/HugoXK/fledge/issues/1', pr_url: 'https://github.com/HugoXK/fledge/pull/2', fixed_version: '0.3.6' },
    })
    assert.equal(written.statusCode, 200)
    const row = store.feedbackTriageByRef('fb_api')
    assert.equal(row?.status, 'fixed')
    assert.equal(row?.fixed_version, '0.3.6')
    assert.equal(row?.issue_url, 'https://github.com/HugoXK/fledge/issues/1')
    assert.equal(store.listFeedbackEvents('fb_api')[0]?.status, 'fixed')
    assert.ok(store.listNotifications(user.id).some((n) => n.kind === 'feedback'))
    assert.equal(mailer.messages.filter((m) => /反馈更新/.test(m.subject)).length, 1)

    const badToken = await built.app.inject({ method: 'GET', url: '/api/feedback/fb_api', headers: { authorization: 'Bearer nope' } })
    assert.equal(badToken.statusCode, 401)
    const badStatus = await built.app.inject({ method: 'POST', url: '/api/feedback/fb_api/triage', headers, payload: { status: 'made_up' } })
    assert.equal(badStatus.statusCode, 400)
  } finally {
    await built.close()
  }
})

test('a fixed record is notified once when the running version catches up', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  try {
    const user = makeUser(store, { login: 'release-reporter', status: 'approved' })
    const feedback = store.createFeedback({ id: 'fb_release', userId: user.id, kind: 'bug', message: 'boom', page: '/dashboard' })
    store.createFeedbackTriage({ ref: feedback.id, userId: user.id, userLogin: user.login, kind: 'bug', publishConsent: true })
    store.updateFeedbackTriage('fb_release', { status: 'fixed', fixed_version: '0.0.1', issue_url: 'https://github.com/HugoXK/fledge/issues/1', pr_url: 'https://github.com/HugoXK/fledge/pull/2' })

    assert.equal(await notifyReleasedFeedback({ store, mailer, currentVersion: '0.3.6' }), 1)
    assert.equal(store.feedbackTriageByRef('fb_release')?.status, 'released')
    assert.equal(store.feedbackTriageByRef('fb_release')?.released_version, '0.3.6')
    assert.ok(store.listNotifications(user.id).some((n) => /0\.3\.6/.test(n.message)))
    assert.equal(mailer.messages.filter((m) => /反馈更新/.test(m.subject)).length, 1)
    assert.equal(await notifyReleasedFeedback({ store, mailer, currentVersion: '0.3.6' }), 0, 'a re-deploy of the same version is silent')
  } finally {
    store.close()
  }
})

test('a feedback post with public-issue consent records it on the triage row', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'consent-reporter', status: 'approved' })
    const session = await import('./helpers.js').then(({ sessionFor }) => sessionFor(built, user))
    const response = await built.app.inject({
      method: 'POST',
      url: '/feedback',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
      payload: new URLSearchParams({ csrf: session.csrf, kind: 'feedback', message: 'A real note', publishConsent: '1' }).toString(),
    })
    assert.equal(response.statusCode, 302)
    const row = store.listFeedback(1)[0]
    assert.ok(row)
    assert.equal(store.feedbackTriageByRef(row.id)?.publish_consent, 1)
  } finally {
    await built.close()
  }
})


test('settings shows the reporter own feedback status, links and version', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'history-reporter', status: 'approved' })
    const feedback = store.createFeedback({ id: 'fb_history', userId: user.id, kind: 'bug', message: 'boom', page: '/dashboard' })
    store.createFeedbackTriage({ ref: feedback.id, userId: user.id, userLogin: user.login, kind: 'bug', publishConsent: true })
    store.updateFeedbackTriage('fb_history', { status: 'fixed', fixed_version: '0.3.6', issue_url: 'https://github.com/HugoXK/fledge/issues/1', pr_url: 'https://github.com/HugoXK/fledge/pull/2' })
    const session = await import('./helpers.js').then(({ sessionFor }) => sessionFor(built, user))
    const page = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-feedback-history/)
    assert.match(page.body, /fb_history/)
    assert.match(page.body, /Fixed/)
    assert.match(page.body, /issues\/1/)
    assert.match(page.body, /pull\/2/)
  } finally {
    await built.close()
  }
})
