import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import {
  applicationEmail,
  applicationReceivedEmail,
  approvedEmail,
  dailyDigestEmail,
  jobAttentionEmail,
  jobFailedEmail,
  jobSucceededEmail,
  quotaExhaustedEmail,
  rejectedEmail,
  testEmail,
  trialExpiredEmail,
  type DigestInput,
  type JobMailContext,
} from '../src/email/templates.js'
import { makeUser } from './helpers.js'

interface Rendered {
  subject: string
  text: string
  html?: string
}

interface NamedMail {
  name: string
  mail: Rendered
}

function htmlOf(mail: Rendered): string {
  assert.equal(typeof mail.html, 'string', 'the template renders an HTML part')
  return mail.html as string
}

function jobContext(over: Partial<JobMailContext> = {}): JobMailContext {
  return {
    repo: 'Birfy/jitagent',
    jobId: 'job_468',
    kind: 'iterate',
    teamUrl: 'https://fledge.example/repos/repo_1/workspace',
    issueUrl: 'https://github.com/Birfy/jitagent/issues/7',
    prUrl: 'https://github.com/Birfy/jitagent/pull/8',
    summary: 'Added a regression test and opened one pull request.',
    error: '',
    reviewScore: null,
    ...over,
  }
}

function digestInput(over: Partial<DigestInput> = {}): DigestInput {
  return {
    date: '2026-11-11',
    jobs: [],
    usedCny: 0,
    unlimited: true,
    remainingCny: 0,
    nextRuns: [],
    questions: [],
    teamLinks: [],
    ...over,
  }
}

function allTemplates(user: ReturnType<typeof makeUser>): NamedMail[] {
  const base = 'https://fledge.example'
  return [
    { name: 'application', mail: applicationEmail(user, `${base}/approve/token-a`, `${base}/reject/token-b`, base, 3) },
    { name: 'application-received', mail: applicationReceivedEmail(user, 3) },
    { name: 'approved', mail: approvedEmail(user, base) },
    { name: 'rejected', mail: rejectedEmail(user, 'The application was incomplete.') },
    { name: 'trial-expired', mail: trialExpiredEmail(user, base) },
    { name: 'quota-exhausted', mail: quotaExhaustedEmail(user, base) },
    { name: 'job-succeeded', mail: jobSucceededEmail(user, jobContext()) },
    { name: 'job-failed', mail: jobFailedEmail(user, jobContext({ error: 'The tests failed.' })) },
    { name: 'job-attention', mail: jobAttentionEmail(user, { repo: 'Birfy/jitagent', question: 'Accept the plan?', detail: '', options: ['Yes', 'No'], teamUrl: `${base}/repos/repo_1/workspace` }) },
    { name: 'digest', mail: dailyDigestEmail(user, digestInput()) },
    { name: 'test', mail: testEmail(user, base) },
  ]
}

test('every transactional email uses the one shared shell', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'mail-owner', status: 'approved' })
    for (const { name, mail } of allTemplates(user)) {
      const html = htmlOf(mail)
      assert.match(html, /^<!doctype html>/i, `${name}: HTML document`)
      assert.match(html, /name="color-scheme"[^>]*content="light dark"/, `${name}: color-scheme meta`)
      assert.match(html, /name="supported-color-schemes"[^>]*content="light dark"/, `${name}: supported-color-schemes meta`)
      assert.match(html, />Fledge</, `${name}: wordmark text`)
      assert.match(html, /max-width:640px/, `${name}: 640px measure`)
      assert.match(html, /box-sizing:border-box/, `${name}: border-box sizing`)
      assert.match(html, /role="presentation"/, `${name}: layout table`)
      assert.match(html, /href="https:\/\/fledge-docs\.hugoxk\.online\/docs\/"/, `${name}: docs footer link`)
      assert.match(html, /href="https:\/\/hugoxk\.online\/status\/"/, `${name}: status footer link`)
      assert.doesNotMatch(html, /<style\b/i, `${name}: no style block`)
      assert.doesNotMatch(html, /<link\b/i, `${name}: no external stylesheet`)
      assert.doesNotMatch(html, /@import/i, `${name}: no imported CSS`)
      assert.doesNotMatch(html, /<img\b/i, `${name}: no remote image`)
    }
  } finally {
    store.close()
  }
})

test('the shell fits a 360px client without a fixed width or horizontal scroll', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'narrow-owner', status: 'approved' })
    const html = htmlOf(jobSucceededEmail(user, jobContext()))
    assert.match(html, /<table[^>]*width="100%"/, 'the outer table is fluid')
    assert.match(html, /width:100%;max-width:640px/, 'the measured table narrows before 640px')
    assert.match(html, /box-sizing:border-box/, 'padding does not widen the table past its measure')
    assert.doesNotMatch(html, /\bwidth="\d{3,}"/, 'no fixed pixel table width')
    assert.doesNotMatch(html, /\bmin-width:/, 'no minimum width forces the client to scroll')
  } finally {
    store.close()
  }
})

test('the text part keeps the same job and PR facts as the HTML part', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'facts-owner', status: 'approved' })
    const context = jobContext()
    const success = jobSucceededEmail(user, context)
    const failure = jobFailedEmail(user, { ...context, error: 'The tests failed.' })
    for (const [label, mail] of [['success', success], ['failure', failure]] as const) {
      for (const fact of [context.repo, context.jobId, context.issueUrl!, context.prUrl!, context.teamUrl]) {
        assert.ok(mail.text.includes(fact), `${label}: text keeps ${fact}`)
        assert.ok(htmlOf(mail).includes(fact), `${label}: HTML keeps ${fact}`)
      }
    }
    assert.match(success.text, /Added a regression test and opened one pull request\./)
    assert.match(failure.text, /The tests failed\./)
  } finally {
    store.close()
  }
})

test('failure mail keeps the red banner and the subject marker', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'failure-owner', status: 'approved' })
    const failure = jobFailedEmail(user, jobContext({ error: 'The tests failed.' }))
    assert.match(failure.subject, /^\[Fledge\] 任务失败：/)
    assert.match(htmlOf(failure), /#b42318/)
    assert.match(htmlOf(failure), /任务失败/)
    assert.match(failure.text, /没有完成/)

    const digest = dailyDigestEmail(user, digestInput({
      jobs: [{ repo: 'Birfy/jitagent', kind: 'iterate', status: 'failed', summary: 'stalled', prUrl: null, issueUrl: null, reviewScore: null, costUsd: 0 }],
    }))
    assert.match(digest.subject, /\[失败 1\] 今日摘要/)
    assert.match(htmlOf(digest), /#b42318/)
    assert.match(htmlOf(digest), /1 个任务失败/)
    assert.match(digest.text, /⚠/)
  } finally {
    store.close()
  }
})

test('every template escapes interpolated user and repository values', () => {
  const store = new Store(':memory:')
  try {
    const evil = '"><script>alert(1)</script><img src=x>'
    const user = makeUser(store, { login: `owner${evil}`, status: 'approved' })
    const context = jobContext({
      repo: `Birfy/${evil}`,
      jobId: evil,
      teamUrl: `https://fledge.example/?q=${evil}`,
      issueUrl: `https://github.com/Birfy/jitagent/issues/7?x=${evil}`,
      prUrl: `https://github.com/Birfy/jitagent/pull/8?x=${evil}`,
      summary: evil,
      error: evil,
    })
    const mails: NamedMail[] = [
      ...allTemplates(user),
      { name: 'job-succeeded-evil', mail: jobSucceededEmail(user, context) },
      { name: 'job-failed-evil', mail: jobFailedEmail(user, context) },
      { name: 'digest-evil', mail: dailyDigestEmail(user, digestInput({
        jobs: [{ repo: context.repo, kind: 'iterate', status: 'failed', summary: evil, prUrl: context.prUrl, issueUrl: context.issueUrl, reviewScore: null, costUsd: 0 }],
        nextRuns: [{ repo: context.repo, when: evil }],
        questions: [{ repo: context.repo, question: evil }],
        teamLinks: [{ repo: context.repo, url: context.teamUrl }],
      })) },
    ]
    for (const { name, mail } of mails) {
      const html = htmlOf(mail)
      assert.doesNotMatch(html, /<script\b/i, `${name}: no live script tag`)
      assert.doesNotMatch(html, /<img\b/i, `${name}: no injected image`)
      assert.match(html, /&lt;script&gt;/, `${name}: the payload is escaped`)
    }
  } finally {
    store.close()
  }
})
