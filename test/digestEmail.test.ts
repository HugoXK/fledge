import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { dailyDigestEmail, type DigestInput } from '../src/email/templates.js'
import { makeUser } from './helpers.js'

function input(over: Partial<DigestInput> = {}): DigestInput {
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

function job(over: DigestInput['jobs'][number] extends infer T ? Partial<T> : never = {}) {
  return {
    repo: 'Birfy/jitagent',
    kind: 'review',
    status: 'failed',
    summary: '任务停滞：超过 30 分钟没有心跳。',
    prUrl: null,
    issueUrl: null,
    reviewScore: null,
    costUsd: 0,
    ...over,
  }
}

test('a failed job puts the count in the subject and a red banner at the top', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'digest-owner', status: 'approved' })
    const mail = dailyDigestEmail(user, input({
      jobs: [
        job(),
        job({ repo: 'o/r', kind: 'iterate', status: 'succeeded', summary: 'done' }),
      ],
    }))
    assert.match(mail.subject, /^\[Fledge\] \[失败 1\] 今日摘要 · 2026-11-11$/)
    assert.match(mail.html, /color:#b42318/)
    assert.match(mail.html, /1 个任务失败/)
    assert.match(mail.text, /失败 1/)
    assert.match(mail.text, /⚠/)
  } finally {
    store.close()
  }
})

test('a clean day keeps the original subject and no failure banner', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'digest-clean', status: 'approved' })
    const mail = dailyDigestEmail(user, input({ jobs: [job({ status: 'succeeded', summary: 'done' })] }))
    assert.equal(mail.subject, '[Fledge] 今日摘要 · 2026-11-11')
    assert.doesNotMatch(mail.html, /color:#b42318/)
    assert.doesNotMatch(mail.text, /个任务失败/)
  } finally {
    store.close()
  }
})
