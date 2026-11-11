import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { dashboardPage, jobPage } from '../src/views/pages.js'
import { FAILURE_CODES, FAILURE_CODE_KIND, failureSentence } from '../src/lib/failure.js'
import { translator } from '../src/i18n.js'
import { makeUser, testConfig } from './helpers.js'

// #231: a backend job failure writes a Chinese sentence into `jobs.error`, and
// the read path had no way to turn it into the reader's language: `localizeMessage`
// is an exact-match dictionary, so a sentence nobody added a row for reached an
// English user verbatim. The boundary is the stable `error_code` the job service
// already speaks (`REPO_CREDENTIAL_INVALID`, `JOB_ACTIVE`, `STAGE_EVIDENCE_MISSING`);
// these cases pin that the code decides the sentence on the job page, the
// dashboard and the notification list, that the Chinese render keeps the text the
// backend wrote, and that a row carrying no code still falls back to the
// dictionary instead of breaking.

const CJK = /[\u3400-\u9fff]/

function failedJob(store: Store, slug: string, error: string, code: string | null): { userId: string; repo: ReturnType<Store['createRepo']>; job: NonNullable<ReturnType<Store['getJob']>> } {
  const user = makeUser(store, { login: `locale-${slug}`, status: 'approved' })
  const repo = store.createRepo({ id: `repo_${slug}`, userId: user.id, owner: 'acme', name: 'demo', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  const job = store.createJob({ id: `job_${slug}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'ascii goal', callbackHash: 'cb', platformTokenHash: '' })
  store.updateJob(job.id, { status: 'failed', error, error_code: code, finished_at: new Date().toISOString() })
  return { userId: user.id, repo, job: store.getJob(job.id)! }
}

function viewer(store: Store, userId: string): { user: NonNullable<ReturnType<Store['userById']>>; csrfToken: string } {
  return { user: store.userById(userId)!, csrfToken: 'csrf' }
}

// The result card's first paragraph is the sentence a user reads; the raw text
// stays in the `Technical detail` block below it, which is the operator's copy.
function resultText(html: string): string {
  return /<h2>(?:Result|结果)<\/h2>[\s\S]*?<p class="[^"]*">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ''
}

function dashboardSummary(html: string): string {
  return /<span data-job-summary-text[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? ''
}

function noticeText(html: string): string {
  return /<div class="notice"><span>(.*?)<\/span>/.exec(html)?.[1] ?? ''
}

function jobPageHtml(store: Store, locale: 'zh' | 'en', userId: string, repo: ReturnType<Store['createRepo']>, job: NonNullable<ReturnType<Store['getJob']>>): string {
  return jobPage({ config: testConfig(), locale, viewer: viewer(store, userId), repo, job, events: [] })
}

function dashboardHtml(store: Store, locale: 'zh' | 'en', userId: string, repo: ReturnType<Store['createRepo']>, job: NonNullable<ReturnType<Store['getJob']>>): string {
  return dashboardPage({ config: testConfig(), locale, viewer: viewer(store, userId), repos: [repo], jobs: [job], notifications: store.listNotifications(userId) })
}

const LEAKS: Array<{ code: string; zh: string; en: RegExp }> = [
  { code: 'REPO_CREDENTIAL_INVALID', zh: 'GitHub token 权限不足，请重新授权这个仓库。', en: /re-authorize|permission/i },
  { code: 'JOB_STALLED', zh: '任务停滞：超过 30 分钟没有心跳。', en: /stall|heartbeat/i },
]

for (const leak of LEAKS) {
  test(`a failure that carries ${leak.code} renders in the reader's language on the job page`, () => {
    const store = new Store(':memory:')
    try {
      const { userId, repo, job } = failedJob(store, `page-${leak.code.toLowerCase()}`, leak.zh, leak.code)

      const en = resultText(jobPageHtml(store, 'en', userId, repo, job))
      assert.doesNotMatch(en, CJK, `the English job page leaked the backend sentence: ${en}`)
      assert.match(en, leak.en, `the English job page lost the failure sentence: ${en}`)

      const zh = resultText(jobPageHtml(store, 'zh', userId, repo, job))
      assert.match(zh, /权限不足|停滞/, `the Chinese render dropped the sentence the backend wrote: ${zh}`)

      // The raw sentence stays readable under the technical-details block.
      const detail = /Technical detail<\/summary><p>([\s\S]*?)<\/p>/.exec(jobPageHtml(store, 'en', userId, repo, job))?.[1] ?? ''
      assert.equal(detail, leak.zh, 'the technical-details copy is the operator text, unchanged')
    } finally {
      store.close()
    }
  })

  test(`a failure that carries ${leak.code} renders in the reader's language on the dashboard`, () => {
    const store = new Store(':memory:')
    try {
      const { userId, repo, job } = failedJob(store, `dash-${leak.code.toLowerCase()}`, leak.zh, leak.code)
      const en = dashboardSummary(dashboardHtml(store, 'en', userId, repo, job))
      assert.doesNotMatch(en, CJK, `the English dashboard leaked the backend sentence: ${en}`)
      assert.match(en, leak.en)
      const zh = dashboardSummary(dashboardHtml(store, 'zh', userId, repo, job))
      assert.match(zh, /权限不足|停滞/)
    } finally {
      store.close()
    }
  })

  test(`a job notification that carries ${leak.code} is a whole English sentence`, () => {
    const store = new Store(':memory:')
    try {
      const { userId, repo, job } = failedJob(store, `note-${leak.code.toLowerCase()}`, leak.zh, leak.code)
      store.notify(userId, 'job', `任务 ${job.id} 失败：${leak.zh}`, leak.code)

      const en = noticeText(dashboardHtml(store, 'en', userId, repo, job))
      assert.doesNotMatch(en, CJK, `the English notification mixed languages: ${en}`)
      assert.match(en, leak.en, `the English notification lost the failure sentence: ${en}`)

      const zh = noticeText(dashboardHtml(store, 'zh', userId, repo, job))
      assert.match(zh, /权限不足|停滞/, 'the Chinese notification keeps the text the backend wrote')
      assert.equal(store.listNotifications(userId)[0]?.message, `任务 ${job.id} 失败：${leak.zh}`, 'the stored row keeps the operator text')
    } finally {
      store.close()
    }
  })
}

test('every failure class the issue names has a code and a sentence in both languages', () => {
  const required = ['REPO_CREDENTIAL_INVALID', 'JOB_STALLED', 'QUOTA_EXHAUSTED', 'JOB_BUDGET_EXCEEDED', 'DUPLICATE_WORK', 'STAGE_EVIDENCE_MISSING', 'JOB_TIMEOUT', 'BRIDGE_ERROR']
  for (const code of required) {
    assert.ok((FAILURE_CODES as readonly string[]).includes(code), `${code} is not in FAILURE_CODES`)
    assert.ok(FAILURE_CODE_KIND[code as keyof typeof FAILURE_CODE_KIND] !== undefined, `${code} has no failure kind`)
    const zh = failureSentence(translator('zh'), code) ?? ''
    const en = failureSentence(translator('en'), code) ?? ''
    assert.match(zh, CJK, `${code} has no Chinese sentence`)
    assert.doesNotMatch(en, CJK, `${code} has no English sentence: ${en}`)
  }
})

test('a failure row with no code falls back to the dictionary instead of guessing', () => {
  const store = new Store(':memory:')
  try {
    const { userId, repo, job } = failedJob(store, 'legacy', '计划任务已排队，不会写代码或开 PR。', null)
    const en = resultText(jobPageHtml(store, 'en', userId, repo, job))
    assert.match(en, /Plan queued/i, 'the dictionary still localizes a sentence it knows')
    assert.doesNotMatch(en, CJK)
    assert.equal(job.error_code, null)
  } finally {
    store.close()
  }
})
