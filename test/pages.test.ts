import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { formBody, json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'
import { appReposPage, dashboardPage, jobPage, landingPage, metricsPage, repoPage } from '../src/views/pages.js'
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
  assert.equal(
    localizeMessage('en', '已有 PR 覆盖这个 issue：https://github.com/acme/demo/pull/7'),
    'A pull request already covers this issue: https://github.com/acme/demo/pull/7',
  )
  assert.equal(localizeMessage('en', '设置已保存；团队规则已按新目标更新。'), 'Settings saved; the team playbook now follows the new goal.')
  assert.equal(localizeMessage('en', '计划任务已排队，不会写代码或开 PR。'), 'Plan queued. It will not write code or open a PR.')
})


test('the simple repo page renders the Chief conversation', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'conversation-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_conversation', userId: user.id, owner: 'o', name: 'talk', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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


test('docs and status links keep the trailing slash', () => {
  const config = testConfig({ services: { portal: 'https://portal.example', docs: 'https://docs.example/docs', status: 'https://status.example/status' } })
  const page = landingPage(config)
  assert.match(page, /https:\/\/docs\.example\/docs\//)
  assert.match(page, /https:\/\/status\.example\/status\//)
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
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'retry-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_retry', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'keep it small', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_retry', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'keep it small', callbackHash: 'cb', platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob(job.id, {
      status: 'failed',
      branch: 'fledge/fix',
      pr_url: 'https://github.com/o/r/pull/7',
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
    assert.match(repoPage.body, /confirmName/)
    assert.match(repoPage.body, /危险操作/)
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
    assert.equal(jobs[0]!.trigger, 'followup')
    assert.equal(jobs[0]!.branch, 'fledge/fix')
    assert.equal(jobs[0]!.pr_url, 'https://github.com/o/r/pull/7')
    assert.equal(jobs[0]!.base_branch, 'main')
    assert.equal(contexts[0]?.job.trigger, 'followup')
    assert.equal(contexts[0]?.job.branch, 'fledge/fix')
    assert.equal(contexts[0]?.job.pr_url, 'https://github.com/o/r/pull/7')
    assert.equal(contexts[0]?.job.base_branch, 'main')
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
    const repo = store.createRepo({ id: 'repo_simple', userId: user.id, owner: 'o', name: 'simple', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.doesNotMatch(page.body, new RegExp(`/repos/${repo.id}/team`))
    assert.match(page.body, new RegExp(`/repos/${repo.id}/workspace`))
    assert.doesNotMatch(page.body, /团队与调度规则/)
    assert.match(page.body, /和 Chief 沟通/)
    const team = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/team`, headers: { cookie } })
    assert.equal(team.statusCode, 403)
    const workspace = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/workspace`, headers: { cookie } })
    assert.equal(workspace.statusCode, 200)
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
    const repo = store.createRepo({ id: 'repo_branch_settings', userId: user.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: encryptSecret('token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_plan_exec', userId: user.id, owner: 'o', name: 'p', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'goal', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_plan_exec', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'goal', callbackHash: 'cb', platformTokenHash: '', kind: 'plan' })
    store.updateJob(job.id, { status: 'succeeded', summary: 'Plan: change one file and add one test', finished_at: new Date().toISOString(), plan_approved_at: new Date().toISOString(), plan_approved_by: user.id })
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
      const repo = store.createRepo({ id: `repo_page_${i}`, userId: user.id, owner: 'o', name: `r${i}`, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_console_jobs', userId: user.id, owner: 'acme', name: 'widgets', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_jobs_page', userId: user.id, owner: 'o', name: 'jobs', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
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
    const repo = store.createRepo({ id: 'repo_delete_token', userId: user.id, owner: 'o', name: 'dt', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createApiToken({ id: 'tok_job_delete', userId: user.id, kind: 'job', name: 'job:job_delete_token', tokenHash: 'job-delete-hash', prefix: 'flg_dele', expiresAt: null })
    store.createJob({ id: 'job_delete_token', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: 'job-delete-hash' })
    store.updateJob('job_delete_token', { status: 'running' })
    const { cookie, csrf } = sessionFor(built, user)
    const deleted = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, confirmName: 'dt' }),
    })
    assert.equal(deleted.statusCode, 302)
    assert.equal(store.getRepo(repo.id), undefined)
    assert.equal(store.findApiToken('job-delete-hash'), undefined)
  } finally {
    await built.close()
  }
})

test('a repository asks the user to choose a role and only offers allowed roles', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'role-page-user', status: 'approved' })
    const adminRepo = store.createRepo({ id: 'repo_role_admin', userId: user.id, owner: 'o', name: 'ra', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: null, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const readRepo = store.createRepo({ id: 'repo_role_read', userId: user.id, owner: 'o', name: 'rr', defaultBranch: 'main', tokenEnc: 'x', permission: 'read', repoRole: null, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const { cookie, csrf } = sessionFor(built, user)

    const adminPage = await built.app.inject({ method: 'GET', url: `/repos/${adminRepo.id}`, headers: { cookie } })
    assert.match(adminPage.body, /选择你在这个仓库的角色/)
    assert.match(adminPage.body, /value="maintainer"/)
    assert.match(adminPage.body, /value="developer"/)

    const readPage = await built.app.inject({ method: 'GET', url: `/repos/${readRepo.id}`, headers: { cookie } })
    assert.match(readPage.body, /选择你在这个仓库的角色/)
    assert.doesNotMatch(readPage.body, /value="maintainer"/)

    const rejected = await built.app.inject({
      method: 'POST',
      url: `/repos/${readRepo.id}/role`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, role: 'maintainer' }),
    })
    assert.equal(rejected.statusCode, 302)
    assert.match(String(rejected.headers.location), /error=/)
    assert.equal(store.getRepo(readRepo.id)?.repo_role, null)

    const accepted = await built.app.inject({
      method: 'POST',
      url: `/repos/${adminRepo.id}/role`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, role: 'developer' }),
    })
    assert.equal(accepted.statusCode, 302)
    assert.equal(store.getRepo(adminRepo.id)?.repo_role, 'developer')
  } finally {
    await built.close()
  }
})

test('settings gate auto-merge and review on the maintainer role', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'role-settings-user', status: 'approved' })
    const adminRepo = store.createRepo({ id: 'repo_role_settings_admin', userId: user.id, owner: 'o', name: 'rsa', defaultBranch: 'main', targetBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: null, canReview: true, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const devRepo = store.createRepo({ id: 'repo_role_settings_dev', userId: user.id, owner: 'o', name: 'rsd', defaultBranch: 'main', targetBranch: 'main', tokenEnc: 'x', permission: 'write', repoRole: 'developer', canReview: true, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const { cookie, csrf } = sessionFor(built, user)

    const page = await built.app.inject({ method: 'GET', url: `/repos/${adminRepo.id}`, headers: { cookie } })
    assert.match(page.body, /name="repoRole"/)
    assert.match(page.body, /name="autoMerge"/)
    assert.match(page.body, /允许 maintainer 自动合并 PR/)

    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${adminRepo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, goal: '', targetBranch: 'main', repoRole: 'maintainer', autoMerge: '1', review: '1', enabled: '1', interval: '1440', reviewInterval: '1440' }),
    })
    assert.equal(saved.statusCode, 302)
    const updated = store.getRepo(adminRepo.id)!
    assert.equal(updated.repo_role, 'maintainer')
    assert.equal(updated.auto_merge, 1)
    assert.equal(updated.reviewer_enabled, 1)

    const developerSaved = await built.app.inject({
      method: 'POST',
      url: `/repos/${devRepo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, goal: '', targetBranch: 'main', repoRole: 'developer', autoMerge: '1', review: '1', enabled: '1', interval: '1440', reviewInterval: '1440' }),
    })
    assert.equal(developerSaved.statusCode, 302)
    const developer = store.getRepo(devRepo.id)!
    assert.equal(developer.repo_role, 'developer')
    assert.equal(developer.auto_merge, 0)
    assert.equal(developer.reviewer_enabled, 0)
  } finally {
    await built.close()
  }
})

test('refresh downgrades a maintainer when the GitHub permission is lost', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url === '/user') {
      json(response, 200, { login: 'role-refresh-user', id: 1 })
      return
    }
    if (request.url === '/repos/openJiuwen-ai/DigitalMate') {
      json(response, 200, {
        name: 'DigitalMate',
        full_name: 'openJiuwen-ai/DigitalMate',
        default_branch: 'main',
        private: false,
        html_url: 'https://github.com/openJiuwen-ai/DigitalMate',
        owner: { login: 'openJiuwen-ai' },
        permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
      })
      return
    }
    if (request.url === '/repos/role-refresh-user/DigitalMate') {
      json(response, 200, {
        name: 'DigitalMate',
        full_name: 'role-refresh-user/DigitalMate',
        default_branch: 'main',
        private: false,
        html_url: 'https://github.com/role-refresh-user/DigitalMate',
        fork: true,
        parent: { full_name: 'openJiuwen-ai/DigitalMate' },
        owner: { login: 'role-refresh-user' },
        permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
      })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'role-refresh-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_role_refresh',
      userId: user.id,
      owner: 'openJiuwen-ai',
      name: 'DigitalMate',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      autoMerge: true,
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
      upstreamOwner: 'openJiuwen-ai',
      upstreamName: 'DigitalMate',
      forkOwner: 'role-refresh-user',
      forkName: 'DigitalMate',
      isFork: true,
    })
    const { cookie, csrf } = sessionFor(built, user)
    const refreshed = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/refresh`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(refreshed.statusCode, 302)
    assert.match(String(refreshed.headers.location), /notice=/)
    assert.match(decodeURIComponent(String(refreshed.headers.location)), /降级/)
    const updated = store.getRepo(repo.id)!
    assert.equal(updated.permission, 'read')
    assert.equal(updated.repo_role, 'developer')
    assert.equal(updated.auto_merge, 0)
    assert.equal(updated.reviewer_enabled, 0)
  } finally {
    await built.close()
    await github.close()
  }
})

test('work items can be created, triaged and started', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'work-item-page-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_work_item_page', userId: user.id, owner: 'o', name: 'wip', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const { cookie, csrf } = sessionFor(built, user)
    const created = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/work`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, title: 'Fix parser', detail: 'User problem', issueUrl: 'https://github.com/o/wip/issues/1', priority: '30' }),
    })
    assert.equal(created.statusCode, 302)
    const item = store.listWorkItems(repo.id)[0]
    assert.ok(item)
    assert.equal(item.state, 'proposed')
    assert.equal(item.priority, 30)
    const triaged = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/work/${item.id}/state`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, state: 'triaged' }),
    })
    assert.equal(triaged.statusCode, 302)
    assert.equal(store.getWorkItem(item.id)?.state, 'triaged')
    const started = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/work/${item.id}/run`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(started.statusCode, 302)
    assert.equal(contexts.length, 1)
    assert.equal(contexts[0]?.job.work_item_id, item.id)
    assert.equal(store.getWorkItem(item.id)?.state, 'in_progress')
  } finally {
    await built.close()
  }
})

test('a plan must be approved by a maintainer before execution', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'plan-approval-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_plan_approval', userId: user.id, owner: 'o', name: 'pa', defaultBranch: 'main', targetBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', planRequired: true, goal: 'ship it', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_plan_approval', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'plan goal', callbackHash: 'cb', platformTokenHash: '', kind: 'plan', baseBranch: 'main' })
    store.updateJob(job.id, { status: 'succeeded', summary: 'Plan: change src/parser.ts', finished_at: new Date().toISOString() })
    const { cookie, csrf } = sessionFor(built, user)
    const rejected = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/execute`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(rejected.statusCode, 302)
    assert.match(String(rejected.headers.location), /error=/)
    assert.equal(contexts.length, 0)

    const approved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/approve-plan`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, allowPaths: 'src/', denyPaths: '.github/' }),
    })
    assert.equal(approved.statusCode, 302)
    assert.notEqual(store.getJob(job.id)?.plan_approved_at, null)
    const executed = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/execute`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(executed.statusCode, 302)
    assert.equal(contexts.length, 1)
    assert.match(contexts[0]!.goal, /Allowed paths: src\//)
    assert.match(contexts[0]!.goal, /Forbidden paths: \.github\//)
  } finally {
    await built.close()
  }
})

test('a disabled repository shows the lifecycle banner and can be enabled again', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'lifecycle-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_lifecycle', userId: user.id, owner: 'o', name: 'lifecycle', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: 1440 })
    store.updateRepo(repo.id, { enabled: 0 })
    const { cookie, csrf } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /仓库已停用/)
    assert.match(page.body, /仓库不可运行/)
    const enabled = await built.app.inject({ method: 'POST', url: `/repos/${repo.id}/enable`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: formBody({ csrf }) })
    assert.equal(enabled.statusCode, 302)
    assert.equal(store.getRepo(repo.id)?.enabled, 1)
    const disabled = await built.app.inject({ method: 'POST', url: `/repos/${repo.id}/disable`, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, payload: formBody({ csrf }) })
    assert.equal(disabled.statusCode, 302)
    assert.equal(store.getRepo(repo.id)?.enabled, 0)
    assert.equal(store.getRepo(repo.id)?.auto_iterate, 0)
  } finally {
    await built.close()
  }
})

test('the dashboard shows a personal delivery card with a selectable window', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'personal-dashboard', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const page = dashboardPage({
      config,
      locale: 'en',
      viewer,
      repos: [],
      jobs: [],
      notifications: [],
      windowDays: 30,
      personal: { repos: 2, jobs: 10, succeeded: 8, failed: 2, prs: 6, merged: 4, costUsd: 0.5, openWorkItems: 1, lastJobAt: new Date().toISOString() },
      alerts: [{ kind: 'job_stalled', level: 'critical', repoId: 'r1', repoLabel: 'o/r', jobId: 'j1', minutes: 45, message: 'job j1 has no callback for 45m' }],
    })
    assert.match(page, /MY DELIVERY/)
    assert.match(page, /Delivery and cost/)
    assert.match(page, /30 days/)
    assert.match(page, />10</)
    assert.match(page, /80%/)
    assert.match(page, /Needs attention/)
    assert.match(page, /45 minutes/)
    assert.match(page, new RegExp(quotaMoney(0.5 * config.quota.usdCny).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    store.close()
  }
})

test('the admin metrics page shows delivery, cost and alerts', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'metrics-admin', status: 'approved', superadmin: true })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const page = metricsPage({
      config,
      locale: 'en',
      viewer,
      metrics: { users: 1, approved: 1, repos: 1, jobs: 2, succeeded: 1, failed: 1, usersWithJobs: 1, usersWithPr: 1, costUsd: 0.4, events: [{ name: 'job_enqueued', n: 2 }] },
      team: { jobs: 1, avgRoles: 2, leadOnly: 0, roles: [{ role: 'lead', calls: 3, jobs: 1 }] },
      workItems: { total: 1, open: 0, merged: 1, closed: 0 },
      attribution: { unattributedCount: 0, unattributedUsd: 0, attributedUsd: 0.4 },
      stages: { scope: 0, verify: 0, iterate: 1, review: 1, leadOnly: 0, grounded: 1 },
      delivery: { jobs: 2, succeeded: 1, failed: 1, successRate: 50, prs: 1, merged: 1, mergeRate: 100, changesRequested: 0, reviewAverage: 82, reviewCount: 1, medianJobMs: 600_000, medianMergeMs: 3_600_000, medianReviewMs: 120_000 },
      daily: [{ day: '2026-01-01', jobs: 2, succeeded: 1, failed: 1, merged: 1 }],
      repoCosts: [{ repoId: 'r1', label: 'o/r', costUsd: 0.4, calls: 3 }],
      modelCosts: [{ model: 'model-a', costUsd: 0.4, calls: 3 }],
      alerts: [{ kind: 'job_stalled', level: 'critical', repoId: 'r1', repoLabel: 'o/r', jobId: 'j1', minutes: 60, message: 'job j1 has no callback for 60m' }],
      windowDays: 7,
      failures: [{ kind: 'quota', count: 1 }],
      since: '2026-01-01T00:00:00.000Z',
    })
    assert.match(page, /Delivery efficiency/)
    assert.match(page, /Daily trend/)
    assert.match(page, /2026-01-01/)
    assert.match(page, /PR merge rate/)
    assert.match(page, /Cost by repository/)
    assert.match(page, /model-a/)
    assert.match(page, /job_stalled/)
    assert.match(page, /7 days/)
    assert.match(page, /Failure breakdown/)
  } finally {
    store.close()
  }
})

test('the job page renders the durable timeline', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'job-timeline-page', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_job_timeline', userId: user.id, owner: 'o', name: 'jt', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_page_timeline', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const page = jobPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      job,
      events: [
        { id: 2, at: new Date().toISOString(), job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'team.role', role: 'lead', step: 'delegate', meta: '{"calls":3,"tool":"github","activity":"working"}' },
        { id: 1, at: new Date().toISOString(), job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.enqueued', role: null, step: 'iterate', meta: 'iterate:manual' },
      ],
    })
    assert.match(page, /Timeline/)
    assert.match(page, /job\.enqueued/)
    assert.match(page, /iterate:manual/)
    assert.match(page, /3 calls/)
  } finally {
    store.close()
  }
})

test('a blocked path guard never renders as Evidence passed', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'guard-page-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_guard_page', userId: user.id, owner: 'o', name: 'gp', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_guard_page', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(job.id, {
      pr_url: 'https://github.com/o/gp/pull/4',
      pr_state: 'open',
      verification_json: JSON.stringify({
        ok: true,
        checkedAt: '2026-11-09T17:00:00.000Z',
        sha: 'a'.repeat(40),
        prState: 'open',
        draft: false,
        mergeableState: 'clean',
        checks: { total: 3, green: 3, failing: [], pending: [] },
        combinedStatus: 'success',
        reviews: { changesRequested: false, approvals: 1 },
        testEvidence: { state: 'verified', claimed: true, greenChecks: ['test (22)'], failingChecks: [] },
        reasons: [],
      }),
      path_guard_json: JSON.stringify({
        ok: false,
        checkedAt: '2026-11-09T17:00:00.000Z',
        allow: [],
        deny: ['src/'],
        files: ['src/config.ts'],
        violations: [{ file: 'src/config.ts', reason: 'denied' }],
      }),
    })
    const page = jobPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      job: store.getJob(job.id)!,
    })
    assert.doesNotMatch(page, /Evidence passed/, 'a blocked PR must not claim its evidence passed')
    assert.match(page, /Blocked/)
    assert.match(page, /src\/config\.ts: denied/)
    assert.match(page, /blocked by the path guard/i)

    const zh = jobPage({
      config,
      locale: 'zh',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      job: store.getJob(job.id)!,
    })
    assert.doesNotMatch(zh, /证据通过/, 'a blocked PR must not claim its evidence passed in Chinese either')
    assert.match(zh, /路径守卫阻止/)
    assert.match(zh, /src\/config\.ts: denied/)
  } finally {
    store.close()
  }
})

test('a clean guard and passing evidence still render Evidence passed', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'guard-clean-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_guard_clean', userId: user.id, owner: 'o', name: 'gc', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_guard_clean', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(job.id, {
      pr_url: 'https://github.com/o/gc/pull/5',
      pr_state: 'open',
      verification_json: JSON.stringify({
        ok: true,
        checkedAt: '2026-11-09T17:00:00.000Z',
        sha: 'b'.repeat(40),
        prState: 'open',
        draft: false,
        mergeableState: 'clean',
        checks: { total: 3, green: 3, failing: [], pending: [] },
        combinedStatus: 'success',
        reviews: { changesRequested: false, approvals: 1 },
        testEvidence: { state: 'verified', claimed: true, greenChecks: ['test (22)'], failingChecks: [] },
        reasons: [],
      }),
      path_guard_json: JSON.stringify({
        ok: true,
        checkedAt: '2026-11-09T17:00:00.000Z',
        allow: [],
        deny: ['src/'],
        files: ['README.md'],
        violations: [],
      }),
    })
    const page = jobPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      job: store.getJob(job.id)!,
    })
    assert.match(page, /Evidence passed/)
    assert.doesNotMatch(page, /blocked by the path guard/i)
  } finally {
    store.close()
  }
})

test('a failed job shows an actionable failure category and a recovery link', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'failure-page-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_failure_page', userId: user.id, owner: 'o', name: 'fp', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_failure_page', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(job.id, { status: 'failed', error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API。', finished_at: new Date().toISOString() })
    const page = jobPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      job: store.getJob(job.id)!,
    })
    assert.match(page, /Platform quota exhausted/)
    assert.match(page, /Open settings/)
    assert.match(page, /Technical detail/)
    assert.match(page, /Settings → Model/)
  } finally {
    store.close()
  }
})

test('the read metrics API scopes a user to personal and a superadmin to global', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'read-api-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_read_api', userId: user.id, owner: 'o', name: 'ra', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_read_api', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const normal = sessionFor(built, user)
    const personal = await built.app.inject({ method: 'GET', url: '/api/read/metrics?window=30', headers: { cookie: normal.cookie } })
    assert.equal(personal.statusCode, 200)
    const personalBody = personal.json() as { personal?: { jobs: number }; product?: unknown }
    assert.equal(personalBody.personal?.jobs, 1)
    assert.equal(personalBody.product, undefined)

    const admin = makeUser(store, { login: 'read-api-admin', status: 'approved', superadmin: true })
    const adminSession = sessionFor(built, admin)
    const global = await built.app.inject({ method: 'GET', url: '/api/read/metrics?window=30', headers: { cookie: adminSession.cookie } })
    assert.equal(global.statusCode, 200)
    const globalBody = global.json() as { product?: { jobs: number }; delivery?: { jobs: number } }
    assert.equal(globalBody.product?.jobs, 1)
    assert.equal(globalBody.delivery?.jobs, 1)
  } finally {
    await built.close()
  }
})

test('the repository page shows a delivery board grouped by work-item state', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'board-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_board', userId: user.id, owner: 'o', name: 'board', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const item = store.createWorkItem({ id: 'work_board', repoId: repo.id, userId: user.id, title: 'Fix the board', detail: 'detail', state: 'in_review' })
    const other = store.createWorkItem({ id: 'work_other', repoId: repo.id, userId: user.id, title: 'Other work', detail: 'detail', state: 'proposed' })
    const page = repoPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      jobs: [],
      workItems: [item, other],
      workState: 'in_review',
    })
    assert.match(page, /Delivery board/)
    assert.match(page, /In review/)
    assert.match(page, /Fix the board/)
    assert.doesNotMatch(page, /Other work/)
    assert.match(page, /Clear filter/)
  } finally {
    store.close()
  }
})

test('admin metrics shows the failure breakdown', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'failure-admin', status: 'approved', superadmin: true })
    const page = metricsPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      metrics: { users: 1, approved: 1, repos: 1, jobs: 2, succeeded: 1, failed: 1, usersWithJobs: 1, usersWithPr: 0, costUsd: 0, events: [] },
      team: { jobs: 0, avgRoles: 0, leadOnly: 0, roles: [] },
      workItems: { total: 0, open: 0, merged: 0, closed: 0 },
      attribution: { unattributedCount: 0, unattributedUsd: 0, attributedUsd: 0 },
      stages: { scope: 0, verify: 0, iterate: 1, review: 0, leadOnly: 0, grounded: 0 },
      delivery: { jobs: 2, succeeded: 1, failed: 1, successRate: 50, prs: 0, merged: 0, mergeRate: 0, changesRequested: 0, reviewAverage: null, reviewCount: 0, medianJobMs: null, medianMergeMs: null, medianReviewMs: null },
      daily: [],
      repoCosts: [],
      modelCosts: [],
      alerts: [],
      windowDays: 30,
      failures: [{ kind: 'quota', count: 1 }, { kind: 'github', count: 1 }],
      since: '2026-01-01T00:00:00.000Z',
    })
    assert.match(page, /Failure breakdown/)
    assert.match(page, /Platform quota exhausted/)
    assert.match(page, /GitHub operation failed/)
  } finally {
    store.close()
  }
})
