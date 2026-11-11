import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { jobPage, repoPage } from '../src/views/pages.js'
import { failureBannerSentence } from '../src/lib/failure.js'
import { Jobs } from '../src/jobs/service.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, formBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #231 review: the enqueue path refuses before a job row exists, so its answer
// never reaches `jobs.error_code`. The route used to put the service's Chinese
// sentence on the redirect and the banner only ran it through the exact-match
// dictionary, so an English reader got the refusal verbatim: the same leak the
// job page had. The refusal code is now carried on the redirect and the banner
// builds the sentence from it, like every other failure the user reads.
//
// The classes below are the ones that can reach the banner: the credential
// check, the monthly repo budget, the two queue admissions, the preflight
// branch-missing refusal (which carries the branch name after a colon) and the
// duplicate-work refusal (which carries the pull request URL the same way).

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
  { value: 'DUPLICATE_WORK:https://github.com/acme/demo/pull/9', en: /pull\/9/, zh: /pull\/9/ },
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
    assert.match(location, /[?&]error=QUEUE_FULL(?:%3A|:)/, `the redirect did not carry the refusal code: ${location}`)

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

// Review at `077be4d1`, finding 2: only `/retry`, `/execute`, the work-run and
// the work-scope route carried the refusal code; the four buttons a user presses
// first still put the service's Chinese on the redirect. Queue full is the same
// cheap refusal for all of them, so one loop pins every route.
test('every enqueue button carries the refusal code, not the service sentence', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const base = testConfig()
  const config = { ...base, runner: { ...base.runner, queueDispatch: true, maxQueueDepth: 0 } }
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(built.store, { login: 'enqueue-buttons', status: 'approved' })
    const repo = built.store.createRepo({
      id: 'repo_enqueue_buttons',
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
    // The review button answers `REVIEW_DISABLED` and a stale role before the
    // queue is consulted, so the fixture makes that role current.
    built.store.updateRepo(repo.id, { reviewer_enabled: 1, can_review: 1, role_checked_at: new Date().toISOString() })
    const item = built.store.createWorkItem({ id: 'wi_enqueue', repoId: repo.id, userId: user.id, title: 't', prUrl: 'https://github.com/acme/demo/pull/1' })
    const session = sessionFor(built, user)
    const posting = { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' }
    const routes: Array<[string, string]> = [
      ['run', `/repos/${repo.id}/run`],
      ['plan', `/repos/${repo.id}/plan`],
      ['review', `/repos/${repo.id}/review`],
      ['verify', `/repos/${repo.id}/work/${item.id}/verify`],
    ]
    for (const [name, url] of routes) {
      const response = await built.app.inject({ method: 'POST', url, headers: posting, payload: formBody({ csrf: session.csrf }) })
      assert.equal(response.statusCode, 302, `${name} did not redirect`)
      const location = String(response.headers.location)
      assert.match(location, new RegExp(`[?&]error=QUEUE_FULL(?:%3A|:).*?(?:#work)?$`), `the ${name} redirect did not carry the code and its sentence: ${location}`)
      const page = await built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie, 'accept-language': 'en' } })
      assert.equal(page.statusCode, 200)
      const text = banner(page.body)
      assert.doesNotMatch(text, CJK, `the ${name} landing page leaked the refusal: ${text}`)
      assert.match(text, /queue is full/i, `the ${name} landing page lost the refusal sentence: ${text}`)
    }
  } finally {
    await built.close()
  }
})

// Review at `077be4d1`, finding 3: a code with no sentence of its own used to
// render "The job could not start (CODE)." in both languages, which is worse than
// base for the codes the dictionary already translates. The order is now sentence
// table, then the writer's text through the dictionary, then the named-code stub;
// these three are the codes the reviewer named.
test('a refusal code with no sentence of its own keeps the dictionary sentence', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const built = await buildApp({ config: testConfig(), store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(built.store, { login: 'dictionary-refusals', status: 'approved' })
    const repo = built.store.createRepo({
      id: 'repo_dictionary_refusals',
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
    const session = sessionFor(built, user)
    const posting = { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' }
    const cases: Array<{ name: string; code: string; text: string; url: string; en: RegExp; zh: RegExp; prepare: () => void }> = [
      {
        name: 'BRANCH_INVALID',
        code: 'BRANCH_INVALID',
        text: '目标分支格式不正确。',
        url: `/repos/${repo.id}/run`,
        en: /target branch name is invalid/i,
        zh: /目标分支格式不正确/,
        prepare: () => {
          built.store.updateRepo(repo.id, { default_branch: 'not a branch', target_branch: '', upstream_default_branch: '' })
        },
      },
      {
        name: 'JOB_ACTIVE',
        code: 'JOB_ACTIVE',
        text: '这个仓库已有任务在运行',
        url: `/repos/${repo.id}/run`,
        en: /job is already running/i,
        zh: /这个仓库已有任务在运行/,
        prepare: () => {
          built.store.updateRepo(repo.id, { default_branch: 'main' })
          built.store.createJob({ id: 'job_active_blocker', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
        },
      },
      {
        name: 'REVIEW_DISABLED',
        code: 'REVIEW_DISABLED',
        text: '这个仓库没有启用审核角色',
        url: `/repos/${repo.id}/review`,
        en: /reviewer role is not enabled/i,
        zh: /没有启用审核角色/,
        prepare: () => {
          built.store.updateRepo(repo.id, { reviewer_enabled: 0, can_review: 0 })
        },
      },
    ]
    for (const item of cases) {
      item.prepare()
      const response = await built.app.inject({ method: 'POST', url: item.url, headers: posting, payload: formBody({ csrf: session.csrf }) })
      assert.equal(response.statusCode, 302, `${item.name} did not redirect`)
      const location = String(response.headers.location)
      assert.match(location, new RegExp(`error=${item.code}(?:%3A|:)`), `${item.name} did not carry its code: ${location}`)
      assert.match(location, new RegExp(encodeURIComponent(item.text.slice(0, 6)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${item.name} did not carry the writer text: ${location}`)
      const en = await built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie, 'accept-language': 'en' } })
      const enText = banner(en.body)
      assert.doesNotMatch(enText, CJK, `the ${item.name} banner leaked Chinese in en: ${enText}`)
      assert.match(enText, item.en, `the ${item.name} en banner does not match base: ${enText}`)
      const zh = await built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie, 'accept-language': 'zh' } })
      const zhText = banner(zh.body)
      assert.match(zhText, item.zh, `the ${item.name} zh banner does not match base: ${zhText}`)
    }
  } finally {
    await built.close()
  }
})

// The order itself, without a route: a sentence entry wins, a code with no entry
// uses the text that travelled after the colon (the dictionary translates it), a
// bare unknown code names itself, and anything that is not a code stays on the
// dictionary. `JOB_LIMIT` and `BOT_MODEL_ASSIGNMENT_FAILED` carry parameters.
test('the banner prefers the sentence table, then the writer text, then the code stub', () => {
  assert.match(failureBannerSentence('en', 'JOB_LEASE_EXPIRED:任务租约过期：worker 未续约。') ?? '', /lease expired/i)
  assert.equal(failureBannerSentence('en', 'BRANCH_INVALID:目标分支格式不正确。'), 'The target branch name is invalid.', 'a code with no sentence must keep the dictionary sentence')
  assert.match(failureBannerSentence('en', 'BRANCH_INVALID:一个没人翻译过的拒绝。') ?? '', /一个没人翻译过的拒绝。/, 'a text the dictionary does not know is shown as written, never replaced by the stub')
  assert.equal(failureBannerSentence('en', 'SOMETHING_UNMAPPED_IN_THE_TABLE'), 'The job could not start (SOMETHING_UNMAPPED_IN_THE_TABLE).', 'the stub is for a bare code with neither a sentence nor a text')
  assert.equal(failureBannerSentence('en', '表单已过期，请刷新页面后重试。'), null, 'a text banner must stay on the dictionary')
  assert.match(failureBannerSentence('en', 'JOB_LIMIT:3') ?? '', /already has 3 jobs running/i)
  assert.match(failureBannerSentence('zh', 'JOB_LIMIT:3') ?? '', /3 个/)
  assert.match(failureBannerSentence('en', 'BOT_MODEL_ASSIGNMENT_FAILED:chief, lead') ?? '', /chief, lead/)
  assert.match(failureBannerSentence('en', 'BRANCH_MISSING:main') ?? '', /target branch main/i)
})

// The two job-button refusals whose text had no dictionary row: at base an `en`
// reader saw Chinese from Pause/Resume. They answer text, not a code, so the row
// is the fix.
test('the resume and cancel refusals have a dictionary sentence', () => {
  const { store, userId, repo } = fixture()
  try {
    const resume = repoBanner(store, userId, repo, 'en', '只有已暂停的任务可以恢复。')
    assert.doesNotMatch(resume, CJK, `the resume refusal leaked Chinese: ${resume}`)
    assert.match(resume, /only a paused job/i)
    const cancel = repoBanner(store, userId, repo, 'en', '这个任务已经结束。')
    assert.doesNotMatch(cancel, CJK, `the cancel refusal leaked Chinese: ${cancel}`)
    assert.match(cancel, /already finished/i)
  } finally {
    store.close()
  }
})

// The write half of the duplicate-work banner case above. The URL has to travel
// as the refusal's own parameter: `DUPLICATE_WORK`'s sentence names `{detail}`,
// so a payload of "已有 PR 覆盖这个 issue：https://…" would fill the English
// sentence with the service's Chinese. Without this case the banner test above
// passes on a hand-written value the route never produces.
test('the duplicate refusal carries the pull request URL as its detail', async () => {
  const github = await startFakeServer((request, response) => {
    if ((request.url ?? '').startsWith('/repos/acme/demo/pulls')) {
      json(response, 200, [
        {
          number: 9,
          html_url: 'https://github.com/acme/demo/pull/9',
          title: 'Fix it',
          body: 'Fixes #9',
          head: { ref: 'fledge/fix' },
          base: { ref: 'main' },
        },
      ])
      return
    }
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url }, runner: { ...base.runner, queueDispatch: false } })
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'dup-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_dup',
      userId: user.id,
      owner: 'acme',
      name: 'demo',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const jobs = new Jobs(
      store,
      config,
      {
        name: 'flybot',
        async run() {
          return { status: 'running' }
        },
      },
      new MemoryMailer(),
    )
    const result = await jobs.enqueue(repo, 'manual', 'close issue #9', 'iterate')
    assert.equal(result.ok, false, 'an open pull request covering the issue refuses the enqueue')
    assert.equal(result.code, 'DUPLICATE_WORK')
    assert.equal(result.detail, 'https://github.com/acme/demo/pull/9', 'the URL travels as the parameter, not inside the sentence')
  } finally {
    store.close()
    await github.close()
  }
})

test('already-fixed work reads as the fix being in, and not as work in flight', () => {
  // #174: the two duplicates must be distinguishable where the maintainer reads
  // them, not only in the audit row.
  const url = 'https://github.com/acme/demo/pull/7'
  assert.equal(
    failureBannerSentence('zh', `ALREADY_FIXED:${url}`),
    `这个 issue 的修复已经合入上游：${url}`,
    'the Chinese banner does not say the fix already landed',
  )
  assert.equal(
    failureBannerSentence('en', `ALREADY_FIXED:${url}`),
    `The fix for this issue is already merged upstream: ${url}`,
    'the English banner does not say the fix already landed',
  )
  assert.equal(
    failureBannerSentence('en', `DUPLICATE_WORK:${url}`),
    `A pull request already covers this issue: ${url}`,
    'the open-pull-request refusal lost its own sentence',
  )
})
