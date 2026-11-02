import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'
import { appReposPage, dashboardPage } from '../src/views/pages.js'
import { quotaMoney } from '../src/views/layout.js'

test('healthz reports the package version', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const response = await built.app.inject({ method: 'GET', url: '/healthz' })
    const body = response.json() as { version: string }
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    assert.equal(body.version, pkg.version)
  } finally {
    await built.close()
  }
})

test('small quota changes are visible below one yuan', () => {
  assert.equal(quotaMoney(0.0001), '¥0.0001')
  assert.equal(quotaMoney(0.5), '¥0.5000')
  assert.equal(quotaMoney(1.234), '¥1.23')
})

test('unlimited quota is shown instead of a finite balance', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'unlimited-ui', status: 'approved' })
    store.setUserQuotaUnlimited(user.id, true)
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const en = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [] })
    assert.match(en, /Unlimited/)
    assert.match(en, /usage is still recorded|platform quota is unlimited/)
    const zh = dashboardPage({ config, locale: 'zh', viewer, repos: [], jobs: [], notifications: [] })
    assert.match(zh, /不限额/)
  } finally {
    store.close()
  }
})

test('email notification settings can be viewed and changed', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const built = await buildApp({ config, store, mailer, runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'mail-settings', status: 'approved' })
    const { cookie, csrf } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /邮件通知/)
    assert.match(page.body, /\/settings\/notifications/)
    assert.match(page.body, /通知邮箱/)
    const changed = await built.app.inject({
      method: 'POST',
      url: '/settings/notifications',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, email: 'me@example.com', jobUpdates: '1', dailyDigest: '1', action: 'save' }),
    })
    assert.equal(changed.statusCode, 302)
    const updated = store.userById(user.id)
    assert.equal(updated?.notify_email, 'me@example.com')
    assert.equal(updated?.email_job_updates, 1)
    assert.equal(updated?.email_daily_digest, 1)
    const after = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie } })
    assert.doesNotMatch(after.body, /mail-settings@example\.com|me@example\.com/)
    assert.match(after.body, /m\*\*\*@example\.com/)
    const keep = await built.app.inject({
      method: 'POST',
      url: '/settings/notifications',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, jobUpdates: '1', dailyDigest: '1', action: 'save' }),
    })
    assert.equal(keep.statusCode, 302)
    assert.equal(store.userById(user.id)?.notify_email, 'me@example.com')
    const cleared = await built.app.inject({
      method: 'POST',
      url: '/settings/notifications',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, clear: '1', jobUpdates: '1', dailyDigest: '1', action: 'save' }),
    })
    assert.equal(cleared.statusCode, 302)
    assert.equal(store.userById(user.id)?.notify_email, null)
    const tested = await built.app.inject({
      method: 'POST',
      url: '/settings/notifications',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, email: 'me@example.com', jobUpdates: '1', dailyDigest: '1', action: 'test' }),
    })
    assert.equal(tested.statusCode, 302)
    assert.equal(mailer.messages.length, 1)
    assert.match(mailer.messages[0]!.subject, /测试邮件/)
  } finally {
    await built.close()
  }
})

test('the workspace stays focused and the UI switches language', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'language-user', status: 'approved' })
    const { cookie } = sessionFor(built, user)

    const zh = await built.app.inject({ method: 'GET', url: '/console', headers: { cookie } })
    assert.equal(zh.statusCode, 200)
    assert.match(zh.body, /工作区/)
    assert.match(zh.body, /最近任务/)
    assert.match(zh.body, /data-lang-btn="en"/)
    assert.match(zh.body, /data-locale="zh"/)
    assert.doesNotMatch(zh.body, /暂未开放|生态|独立服务|flybot\.hugoxk\.online|sciencediscovery\.hugoxk\.online/)

    const appJs = await built.app.inject({ method: 'GET', url: '/assets/app.js' })
    assert.equal(appJs.statusCode, 200)
    assert.match(appJs.body, /hugoxk-lang/)

    const switched = await built.app.inject({ method: 'GET', url: '/lang/en?next=%2Fconsole', headers: { cookie } })
    assert.equal(switched.statusCode, 302)
    assert.equal(switched.headers.location, '/console')
    assert.match(String(switched.headers['set-cookie']), /fledge_lang=en/)

    const en = await built.app.inject({ method: 'GET', url: '/console', headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(en.statusCode, 200)
    assert.match(en.body, /<html lang="en" data-locale="en">/)
    assert.match(en.body, /Workspace/)
    assert.match(en.body, /Recent jobs/)
    assert.match(en.body, /Sign out/)
    assert.doesNotMatch(en.body, /服务/)

    const bad = await built.app.inject({ method: 'GET', url: '/lang/fr' })
    assert.equal(bad.statusCode, 404)

    const unsafe = await built.app.inject({ method: 'GET', url: '/lang/en?next=%2F%2Fevil.example' })
    assert.equal(unsafe.statusCode, 302)
    assert.equal(unsafe.headers.location, '/')
  } finally {
    await built.close()
  }
})

test('the anonymous landing page follows the saved language', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const zh = await built.app.inject({ method: 'GET', url: '/' })
    assert.match(zh.body, /让仓库自己长大/)
    const en = await built.app.inject({ method: 'GET', url: '/', headers: { cookie: 'fledge_lang=en' } })
    assert.match(en.body, /Let your repositories grow/)
    assert.match(en.body, /Sign in with GitHub/)
  } finally {
    await built.close()
  }
})

test('job detail shows evidence and can retry a failed job', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'retry-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_retry', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', goal: 'keep it small', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_retry', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'keep it small', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(job.id, {
      status: 'failed',
      summary: 'Tests failed',
      error: 'one assertion failed',
      cost_usd: 0.0123,
      checkpoint: 'done A; next B',
      evidence_json: JSON.stringify({ tests: 'unit tests: 4 pass / 1 fail', checks: 'CI red', files: 3, risk: 'medium', rollback: 'revert the commit' }),
      attribution_json: JSON.stringify({ claimedBy: 'Lead', implementedBy: 'Dev-1', testedBy: 'Test' }),
    })
    const { cookie, csrf } = sessionFor(built, user)
    const repoPage = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(repoPage.statusCode, 200)
    assert.match(repoPage.body, /data-goal-template/)
    assert.match(repoPage.body, /goal-settings/)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /unit tests: 4 pass \/ 1 fail/)
    assert.match(page.body, /done A; next B/)
    assert.match(page.body, /从断点继续/)
    assert.match(page.body, /Dev-1/)
    const retried = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/retry`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(retried.statusCode, 302)
    const jobs = store.listJobsForRepo(repo.id)
    assert.equal(jobs.length, 2)
    assert.match(jobs[0]!.goal, /Resume from checkpoint:/)
    assert.match(jobs[0]!.goal, /done A; next B/)
  } finally {
    await built.close()
  }
})

test('admin product metrics page renders the funnel', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'metrics-admin', admin: true, status: 'approved' })
    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin/metrics', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /产品指标/)
    assert.match(page.body, /漏斗/)
    assert.match(page.body, /成功率/)
  } finally {
    await built.close()
  }
})

test('a plan job can be executed after approval', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'plan-exec-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_plan_exec', userId: user.id, owner: 'o', name: 'p', defaultBranch: 'main', tokenEnc: 'x', goal: 'goal', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_plan_exec', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'goal', callbackHash: 'cb', platformTokenHash: '', kind: 'plan' })
    store.updateJob(job.id, { status: 'succeeded', summary: 'Plan: change one file and add one test', finished_at: new Date().toISOString() })
    const { cookie, csrf } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /执行这个计划/)
    const executed = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/execute`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(executed.statusCode, 302)
    const jobs = store.listJobsForRepo(repo.id)
    assert.equal(jobs.length, 2)
    assert.match(jobs[0]!.goal, /Approved plan:/)
    assert.match(jobs[0]!.goal, /Plan: change one file/)
  } finally {
    await built.close()
  }
})

test('dashboard paginates repositories and jobs at ten per page', async () => {
  const config = testConfig({ githubApp: { ...testConfig().githubApp, id: '1', slug: 'fledge' } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'page-user', status: 'approved' })
    for (let i = 0; i < 11; i += 1) {
      const repo = store.createRepo({ id: `repo_page_${i}`, userId: user.id, owner: 'o', name: `r${i}`, defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
      store.createJob({ id: `job_page_${i}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    }
    const { cookie } = sessionFor(built, user)
    const first = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(first.statusCode, 200)
    assert.equal((first.body.match(/data-job-id=/g) || []).length, 10)
    assert.equal((first.body.match(/data-repo-id=/g) || []).length, 10)
    assert.match(first.body, /方式一（推荐）：GitHub App/)
    assert.match(first.body, /方式二：手动提供 fine-grained token/)
    assert.match(first.body, /add-manual/)
    assert.match(first.body, /info-tip/)
    assert.doesNotMatch(first.body, /间隔是两次自动迭代之间的最小间隔/)
    const secondJobs = await built.app.inject({ method: 'GET', url: '/dashboard?jobsPage=2', headers: { cookie } })
    assert.equal((secondJobs.body.match(/data-job-id=/g) || []).length, 1)
    const secondRepos = await built.app.inject({ method: 'GET', url: '/dashboard?reposPage=2', headers: { cookie } })
    assert.equal((secondRepos.body.match(/data-repo-id=/g) || []).length, 1)
  } finally {
    await built.close()
  }
})

test('a repository job table paginates at ten per page', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'repo-page-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_jobs_page', userId: user.id, owner: 'o', name: 'jobs', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    for (let i = 0; i < 11; i += 1) {
      store.createJob({ id: `job_repo_page_${i}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    }
    const { cookie } = sessionFor(built, user)
    const first = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal((first.body.match(/data-job-id=/g) || []).length, 10)
    const second = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}?jobsPage=2`, headers: { cookie } })
    assert.equal((second.body.match(/data-job-id=/g) || []).length, 1)
  } finally {
    await built.close()
  }
})


test('app onboarding carries the repository settings and help is behind info icons', () => {
  const config = testConfig({ githubApp: { ...testConfig().githubApp, id: '1', slug: 'fledge' } })
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'app-settings-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const page = appReposPage({
      config,
      locale: 'zh',
      viewer,
      installations: [{ installation_id: 1, account_login: 'acme', account_type: 'User' }],
      installationId: 1,
      repos: [{ fullName: 'acme/repo', owner: 'acme', name: 'repo', private: false, defaultBranch: 'main' }],
    })
    assert.match(page, /name="goal"/)
    assert.match(page, /name="auto"/)
    assert.match(page, /name="interval"/)
    assert.match(page, /name="review"/)
    assert.match(page, /name="reviewInterval"/)
    assert.match(page, /info-tip/)
  } finally {
    store.close()
  }
})
