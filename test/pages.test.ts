import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'
import { appReposPage, dashboardPage, repoPage } from '../src/views/pages.js'
import { quotaMoney } from '../src/views/layout.js'
import { localizeMessage } from '../src/i18n.js'
import { encryptSecret } from '../src/lib/secrets.js'

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

test('redirect messages and dynamic counts are localized', () => {
  assert.equal(localizeMessage('en', '已接入 2 个仓库。'), 'Connected 2 repositories.')
  assert.equal(localizeMessage('en', '已接入 1 个仓库。'), 'Connected 1 repository.')
  assert.equal(localizeMessage('en', '已创建 fork acme/demo。'), 'Created fork acme/demo.')
  assert.equal(localizeMessage('en', '设置已保存；团队规则已按新目标更新。'), 'Settings saved; the team playbook now follows the new goal.')
  assert.equal(localizeMessage('en', '计划任务已排队，不会写代码或开 PR。'), 'Plan queued. It will not write code or open a PR.')
})


test('the simple repo page renders the Chief conversation', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'conversation-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_conversation', userId: user.id, owner: 'o', name: 'talk', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const page = repoPage({
      config,
      locale: 'zh',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      jobs: [],
      chiefMessages: [
        { role: 'user', text: '进度如何？', at: 1 },
        { role: 'chief', text: '还有一个测试没通过。', at: 2 },
      ],
    })
    assert.match(page, /和 Chief 沟通/)
    assert.match(page, /进度如何？/)
    assert.match(page, /还有一个测试没通过。/)
    assert.match(page, /chief-msg user/)
    assert.match(page, /chief-msg chief/)
  } finally {
    store.close()
  }
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
    assert.match(appJs.body, /dataset\.confirm/)
    assert.match(appJs.body, /data-reload/)

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
    assert.match(repoPage.body, /data-confirm="删除这个仓库/)
    assert.doesNotMatch(repoPage.body, /onsubmit=|onclick=/)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /unit tests: 4 pass \/ 1 fail/)
    assert.match(page.body, /done A; next B/)
    assert.match(page.body, /从断点继续/)
    assert.match(page.body, /Dev-1/)
    assert.doesNotMatch(page.body, /团队参与/)
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
    const admin = makeUser(store, { login: 'metrics-admin', superadmin: true, status: 'approved' })
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



test('normal users get a simplified repository page without the live team console', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'simple-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_simple', userId: user.id, owner: 'o', name: 'simple', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.doesNotMatch(page.body, new RegExp(`/repos/${repo.id}/team`))
    assert.doesNotMatch(page.body, new RegExp(`/repos/${repo.id}/workspace`))
    assert.doesNotMatch(page.body, /团队与调度规则/)
    assert.match(page.body, /和 Chief 沟通/)
    const team = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/team`, headers: { cookie } })
    assert.equal(team.statusCode, 403)
    const workspace = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/workspace`, headers: { cookie } })
    assert.equal(workspace.statusCode, 403)
  } finally {
    await built.close()
  }
})

test('repository settings can change the target branch', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url === '/repos/o/b/branches/develop') {
      json(response, 200, { name: 'develop', commit: { sha: 'abc' } })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'branch-settings-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_branch_settings', userId: user.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: encryptSecret('token', config.tokenEncryptionKey), goal: '', autoIterate: false, intervalMinutes: 1440 })
    const { cookie, csrf } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.match(page.body, /name="targetBranch"/)
    assert.match(page.body, /目标分支/)
    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, goal: '', targetBranch: 'develop', enabled: '1', interval: '1440', reviewInterval: '1440' }),
    })
    assert.equal(saved.statusCode, 302)
    assert.equal(store.getRepo(repo.id)?.target_branch, 'develop')
    const rejected = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, goal: '', targetBranch: 'missing', enabled: '1', interval: '1440', reviewInterval: '1440' }),
    })
    assert.equal(rejected.statusCode, 302)
    assert.match(String(rejected.headers.location), /error=/)
    assert.equal(store.getRepo(repo.id)?.target_branch, 'develop')
  } finally {
    await built.close()
    await github.close()
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
    assert.match(first.body, /PR \/ Issue/)
    assert.doesNotMatch(first.body, /onclick=|onsubmit=/)
    assert.doesNotMatch(first.body, /间隔是两次自动迭代之间的最小间隔/)
    const secondJobs = await built.app.inject({ method: 'GET', url: '/dashboard?jobsPage=2', headers: { cookie } })
    assert.equal((secondJobs.body.match(/data-job-id=/g) || []).length, 1)
    const secondRepos = await built.app.inject({ method: 'GET', url: '/dashboard?reposPage=2', headers: { cookie } })
    assert.equal((secondRepos.body.match(/data-repo-id=/g) || []).length, 1)
  } finally {
    await built.close()
  }
})

test('the workspace shows ten recent jobs with repository labels and full PR/Issue links', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'console-jobs-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_console_jobs', userId: user.id, owner: 'acme', name: 'widgets', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    for (let i = 0; i < 12; i += 1) {
      const job = store.createJob({ id: `job_console_${i}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb${i}`, platformTokenHash: '' })
      store.updateJob(job.id, {
        status: 'succeeded',
        summary: `job ${i} completed with a focused change`,
        pr_url: `https://github.com/acme/widgets/pull/${i}`,
        issue_url: `https://github.com/acme/widgets/issues/${i}`,
      })
    }
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: '/console', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.equal((page.body.match(/data-job-id=/g) || []).length, 10)
    assert.match(page.body, /acme\/widgets/)
    assert.match(page.body, />PR<\/a>/)
    assert.match(page.body, />Issue<\/a>/)
    assert.match(page.body, /查看其余 2 个任务/)
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

test('deleting a repository revokes its active job token', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'delete-token-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_delete_token', userId: user.id, owner: 'o', name: 'dt', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createApiToken({ id: 'tok_job_delete', userId: user.id, kind: 'job', name: 'job:job_delete_token', tokenHash: 'job-delete-hash', prefix: 'flg_dele', expiresAt: null })
    store.createJob({ id: 'job_delete_token', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: 'job-delete-hash' })
    store.updateJob('job_delete_token', { status: 'running' })
    const { cookie, csrf } = sessionFor(built, user)
    const deleted = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(deleted.statusCode, 302)
    assert.equal(store.getRepo(repo.id), undefined)
    assert.equal(store.findApiToken('job-delete-hash'), undefined)
  } finally {
    await built.close()
  }
})
