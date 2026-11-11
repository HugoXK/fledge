import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { jobPage, repoPage } from '../src/views/pages.js'
import { makeUser, MemoryMailer, formBody, sessionFor, testConfig } from './helpers.js'

// #231 review: the enqueue path refuses before a job row exists, so its answer
// never reaches `jobs.error_code`. The route used to put the service's Chinese
// sentence on the redirect and the banner only ran it through the exact-match
// dictionary, so an English reader got the refusal verbatim: the same leak the
// job page had. The refusal code is now carried on the redirect and the banner
// builds the sentence from it, like every other failure the user reads.
//
// The classes below are the ones that can reach the banner: the credential
// check, the monthly repo budget, the two queue admissions, and the preflight
// branch-missing refusal (which carries the branch name after a colon).

const CJK = /[\u3400-\u9fff]/

function banner(html: string): string {
  return /<div class="banner bad" role="alert">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
}

function fixture(): { store: Store; userId: string; repo: ReturnType<Store['createRepo']> } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `refusal-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, userId: user.id, repo }
}

function repoBanner(store: Store, userId: string, repo: ReturnType<Store['createRepo']>, locale: 'zh' | 'en', error: string): string {
  return banner(repoPage({ config: testConfig(), locale, viewer: { user: store.userById(userId)!, csrfToken: 'csrf' }, repo, jobs: [], error }))
}

const REFUSALS: Array<{ value: string; en: RegExp; zh: RegExp }> = [
  { value: 'REPO_CREDENTIAL_INVALID', en: /re-?authoriz|permission/i, zh: /权限/ },
  { value: 'REPO_BUDGET_EXHAUSTED', en: /monthly budget/i, zh: /预算/ },
  { value: 'QUEUE_FULL', en: /queue is full/i, zh: /队列已满/ },
  { value: 'QUEUE_LIMIT', en: /too many (jobs|tasks) queued/i, zh: /排队/ },
  { value: 'BRANCH_MISSING:main', en: /target branch main/i, zh: /目标分支 main/ },
]

for (const refusal of REFUSALS) {
  test(`the refusal banner for ${refusal.value} is one whole sentence in the reader's language`, () => {
    const { store, userId, repo } = fixture()
    try {
      const en = repoBanner(store, userId, repo, 'en', refusal.value)
      assert.doesNotMatch(en, CJK, `the English refusal banner leaked the backend sentence: ${en}`)
      assert.match(en, refusal.en, `the English refusal banner lost the sentence: ${en}`)
      const zh = repoBanner(store, userId, repo, 'zh', refusal.value)
      assert.match(zh, refusal.zh, `the Chinese refusal banner lost its sentence: ${zh}`)
    } finally {
      store.close()
    }
  })
}

// A refusal code the sentence table does not know yet must not print the service's
// Chinese either: naming the code in the reader's language is the safe default, so
// a future refusal cannot leak before somebody gives it a sentence.
test('an unmapped refusal code renders a localized sentence that names the code', () => {
  const { store, userId, repo } = fixture()
  try {
    const en = repoBanner(store, userId, repo, 'en', 'ROLE_REQUIRED')
    assert.doesNotMatch(en, CJK, `an unmapped code leaked Chinese: ${en}`)
    assert.match(en, /could not start/i)
    assert.match(en, /ROLE_REQUIRED/, 'the banner names the code so an operator can search it')
    const zh = repoBanner(store, userId, repo, 'zh', 'ROLE_REQUIRED')
    assert.match(zh, CJK, 'the Chinese banner is a Chinese sentence')
  } finally {
    store.close()
  }
})

// The dictionary stays the fallback for a value that is not a code, so route
// banners written as text keep rendering as they did.
test('a banner that is not a code still goes through the dictionary', () => {
  const { store, userId, repo } = fixture()
  try {
    const en = repoBanner(store, userId, repo, 'en', '表单已过期，请刷新页面后重试。')
    assert.doesNotMatch(en, CJK, `the dictionary fallback stopped working: ${en}`)
    assert.match(en, /form has expired/i)
  } finally {
    store.close()
  }
})

// Reachability: a real refusal carries its code through the redirect, so the page
// the browser lands on shows the sentence. Queue full is the cheapest to drive:
// two queued-job limits set to zero refuse the very first enqueue.
test('a queue-full refusal carries its code through the redirect', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const base = testConfig()
  const config = { ...base, runner: { ...base.runner, queueDispatch: true, maxQueueDepth: 0 } }
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(built.store, { login: 'queue-full', status: 'approved' })
    const repo = built.store.createRepo({
      id: 'repo_queue_full',
      userId: user.id,
      owner: 'acme',
      name: 'demo',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const prior = built.store.createJob({ id: 'job_queue_full', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    built.store.updateJob(prior.id, { status: 'failed', error: '任务停滞：超过 30 分钟没有心跳。', error_code: 'JOB_STALLED', finished_at: new Date().toISOString() })
    const session = sessionFor(built, user)

    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${prior.id}/retry`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(response.statusCode, 302)
    const location = String(response.headers.location)
    assert.match(location, /[?&]error=QUEUE_FULL$/, `the redirect did not carry the refusal code: ${location}`)

    const page = await built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie, 'accept-language': 'en' } })
    assert.equal(page.statusCode, 200)
    const text = banner(page.body)
    assert.doesNotMatch(text, CJK, `the landing page leaked the refusal: ${text}`)
    assert.match(text, /queue is full/i, `the landing page lost the refusal sentence: ${text}`)
  } finally {
    await built.close()
  }
})

// Review item 3: "Technical detail" was translating `jobs.error` through the
// dictionary while the docs and ADR said it prints the raw text. The raw text is
// the decision: it is the operator's copy, and the sentence a reader gets is
// already on the result card, from the code. This is the reviewer's probe — a
// quota row whose text the dictionary knows — pinned to the raw rendering.
test('technical detail prints the raw text even when the dictionary knows it', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'raw-detail', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_raw_detail', userId: user.id, owner: 'acme', name: 'demo', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_raw_detail', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const raw = '平台额度已用完，请在 Settings → Model 配置自己的模型 API。'
    store.updateJob(job.id, { status: 'quota_exhausted', error: raw, error_code: 'QUOTA_EXHAUSTED', finished_at: new Date().toISOString() })
    const html = jobPage({ config: testConfig(), locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job: store.getJob(job.id)!, events: [] })
    const detail = /Technical detail<\/summary><p>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ''
    assert.equal(detail, raw, 'technical detail is the operator copy, not the reader sentence')
    assert.match(/<h2>Result<\/h2>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '', /quota/i, 'the reader sentence still comes from the code')
  } finally {
    store.close()
  }
})
