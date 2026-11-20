import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { PostmortemRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import type { ChangeStory } from '../src/lib/changeStory.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { flashOf, formBody, json, makeTerminalJob, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'
import { adminSearchPage, appReposPage, dashboardPage, jobPage, landingPage, metricsPage, repoPage, settingsPage, workspacePage } from '../src/views/pages.js'
import { quotaMoney } from '../src/views/layout.js'
import { localizeMessage } from '../src/i18n.js'
import { WORK_ITEM_STATES } from '../src/lib/workItems.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { planPacketHash } from '../src/lib/planDecision.js'

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

test('the settings page offers the per-job success switch and states the coalescing policy', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'mail-success-switch', status: 'approved' })
    const { cookie, csrf } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /name="jobSuccess"/, 'the switch is on the page')
    assert.match(page.body, /计划任务成功时也单独发邮件/, 'the Chinese label is on the page')
    assert.match(page.body, /失败按仓库合并/, 'the coalescing policy is stated in Chinese')
    assert.doesNotMatch(page.body, /name="jobSuccess" value="1" checked/, 'the switch starts off for an existing user')
    assert.equal(store.userById(user.id)?.email_job_success, 0)

    // The UI bar requires both languages: the same page in English must carry
    // the same switch and the same policy sentence, not a fallback.
    const english = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie, 'accept-language': 'en' } })
    assert.equal(english.statusCode, 200)
    assert.match(english.body, /name="jobSuccess"/)
    assert.match(english.body, /also email me when a scheduled job succeeds/i)
    assert.match(english.body, /summarized in the daily summary/i)

    const saved = await built.app.inject({
      method: 'POST',
      url: '/settings/notifications',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, jobUpdates: '1', dailyDigest: '1', jobSuccess: '1', action: 'save' }),
    })
    assert.equal(saved.statusCode, 302)
    assert.equal(store.userById(user.id)?.email_job_success, 1)

    const off = await built.app.inject({
      method: 'POST',
      url: '/settings/notifications',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, jobUpdates: '1', dailyDigest: '1', action: 'save' }),
    })
    assert.equal(off.statusCode, 302)
    assert.equal(store.userById(user.id)?.email_job_success, 0, 'saving without the box turns it back off')
  } finally {
    await built.close()
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
    assert.match(en.body, /<html lang="en" data-locale="en" data-density="comfortable" data-theme="system">/)
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
    assert.equal(jobs[0]!.owner_started, 1, 'the retry button is a person pressing it, so the row records that')
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
    assert.equal(rejected.headers.location, `/repos/${repo.id}#repo-settings`)
    assert.equal(flashOf(rejected)?.error?.text, '目标分支不存在或不可访问。')
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
    assert.match(first.body, /<section class="card" id="repositories">/)
    assert.match(first.body, /data-open-dialog="add-repo"/)
    assert.match(first.body, /aria-haspopup="dialog"/)
    assert.match(first.body, /aria-controls="add-repo"/)
    assert.match(first.body, /<dialog[^>]*id="add-repo"[^>]*aria-labelledby="add-repo-title"/)
    assert.match(first.body, /data-close-dialog/)
    assert.doesNotMatch(first.body, /<div class="card" id="add-repo">/)
    assert.match(first.body, /<noscript><style>/)
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
      makeTerminalJob(store, { id: `job_repo_page_${i}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
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
    assert.equal(rejected.headers.location, `/repos/${readRepo.id}#role`)
    assert.equal(flashOf(rejected)?.error?.text, '你的 GitHub 权限不允许选择这个角色。')
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
    assert.equal(refreshed.headers.location, `/repos/${repo.id}`)
    assert.match(flashOf(refreshed)?.notice?.text ?? '', /降级/)
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
    // #634: a plan without structured evidence cannot be approved, so this fixture
    // carries the packet a real plan reports.
    store.updateJob(job.id, {
      status: 'succeeded', summary: 'Plan: change src/parser.ts', finished_at: new Date().toISOString(),
      evidence_json: JSON.stringify({ scope: 'src/parser.ts', acceptance: 'the plan runs', testPlan: 'post the form', testRed: 'not approvable', testGreen: 'approved', tests: 'node:test', checks: 'npm run check', files: 1, risk: 'low', rollback: 'revert the commit' }),
    })
    const { cookie, csrf } = sessionFor(built, user)
    const rejected = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/jobs/${job.id}/execute`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(rejected.statusCode, 302)
    assert.equal(rejected.headers.location, `/repos/${repo.id}/jobs/${job.id}`)
    assert.equal(flashOf(rejected)?.error?.text, '计划尚未批准。')
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

test('a plan card pins the packet hash and offers only the decisions its state allows', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'plan-card-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_plan_card', userId: user.id, owner: 'o', name: 'pc', defaultBranch: 'main', targetBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', planRequired: true, goal: 'ship it', autoIterate: false, intervalMinutes: 1440 })
    const evidence = JSON.stringify({ scope: 'src/parser.ts', acceptance: 'the plan runs', testPlan: 'read the page', testRed: 'the card offered approve only', testGreen: 'the card offers reject and revise', tests: 'node:test', checks: 'npm run check', files: 1, risk: 'low', rollback: 'revert the commit' })
    const item = store.createWorkItem({ id: 'wi_plan_card', repoId: repo.id, userId: user.id, title: 'plan card work' })
    const ready = store.createJob({ id: 'job_plan_card_ready', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'plan goal', callbackHash: 'cb-ready', platformTokenHash: '', kind: 'plan', baseBranch: 'main', workItemId: item.id })
    store.updateJob(ready.id, { status: 'succeeded', summary: 'Plan: change src/parser.ts', finished_at: new Date().toISOString(), evidence_json: evidence })
    const blind = store.createJob({ id: 'job_plan_card_blind', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'plan goal', callbackHash: 'cb-blind', platformTokenHash: '', kind: 'plan', baseBranch: 'main', workItemId: item.id })
    store.updateJob(blind.id, { status: 'succeeded', summary: 'Plan: no evidence', finished_at: new Date().toISOString() })
    // #634: plan rows written before the work-item link existed carry no work
    // item, so there is nothing a revision could be queued on. The card must not
    // offer a control whose press only redirects with an error.
    const legacy = store.createJob({ id: 'job_plan_card_legacy', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'plan goal', callbackHash: 'cb-legacy', platformTokenHash: '', kind: 'plan', baseBranch: 'main' })
    store.updateJob(legacy.id, { status: 'succeeded', summary: 'Plan: legacy row', finished_at: new Date().toISOString() })
    const { cookie } = sessionFor(built, user)

    // The hash is the one the page rendered, computed from the same three values
    // the page shows, because that is what both decision doors compare.
    const packetHash = (jobId: string): string => {
      const job = store.getJob(jobId)!
      return planPacketHash({ summary: job.summary, evidenceJson: job.evidence_json, baseSha: job.base_sha })
    }
    const hiddenHash = (body: string): string | undefined => body.match(/<input type="hidden" name="planHash" value="([0-9a-f]{64})"/)?.[1]
    const primaryButton = (body: string): string => body.match(/<button[^>]*data-plan-primary[^>]*>/)?.[0] ?? ''

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${ready.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-plan-decision="pending"/)
    assert.equal(hiddenHash(page.body), packetHash(ready.id), 'the form posts the hash of the packet the page showed')
    assert.doesNotMatch(primaryButton(page.body), /disabled/, 'a complete plan can be approved')
    assert.match(page.body, new RegExp(`formaction="/repos/${repo.id}/jobs/${ready.id}/reject-plan"`))
    assert.match(page.body, new RegExp(`formaction="/repos/${repo.id}/jobs/${ready.id}/revise-plan"`))

    const blindPage = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${blind.id}`, headers: { cookie } })
    assert.equal(blindPage.statusCode, 200)
    assert.match(blindPage.body, /data-plan-decision="incomplete"/)
    assert.equal(hiddenHash(blindPage.body), packetHash(blind.id), 'a refusal still names the packet it read')
    assert.match(primaryButton(blindPage.body), /disabled/, 'a plan without evidence cannot be approved')
    // #634: the incomplete card disabled the approval and with it the decision —
    // no reject, no revise. A plan nobody can evaluate is exactly the plan a
    // maintainer has to be able to send back.
    assert.match(blindPage.body, new RegExp(`formaction="/repos/${repo.id}/jobs/${blind.id}/reject-plan"`), 'reject stays available without evidence')
    assert.match(blindPage.body, new RegExp(`formaction="/repos/${repo.id}/jobs/${blind.id}/revise-plan"`), 'a revision stays available without evidence')

    // A row from before the work-item link: reject still applies to the row, but
    // a revision would have to queue a new plan on a work item that is not there.
    const legacyPage = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${legacy.id}`, headers: { cookie } })
    assert.equal(legacyPage.statusCode, 200)
    assert.match(legacyPage.body, /data-plan-decision="incomplete"/)
    assert.equal(store.getJob(legacy.id)?.work_item_id, null)
    assert.match(legacyPage.body, new RegExp(`formaction="/repos/${repo.id}/jobs/${legacy.id}/reject-plan"`), 'reject still applies to a plan with no work item')
    assert.doesNotMatch(legacyPage.body, new RegExp(`/repos/${repo.id}/jobs/${legacy.id}/revise-plan`), 'a plan with no work item offers no revision it cannot queue')
    assert.match(legacyPage.body, /id="plan-revise-unavailable"/, 'the card says why it cannot revise')
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
    assert.match(page, /My delivery/)
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

test('the dashboard masthead uses singular labels for one repository, job and work item', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'masthead-singular', status: 'approved' })
    const repoOne = store.createRepo({ id: 'repo_masthead_one', userId: user.id, owner: 'o', name: 'one', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const repoTwo = store.createRepo({ id: 'repo_masthead_two', userId: user.id, owner: 'o', name: 'two', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const jobOne = makeTerminalJob(store, { id: 'job_masthead_one', repoId: repoOne.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const jobTwo = makeTerminalJob(store, { id: 'job_masthead_two', repoId: repoTwo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const personal = { repos: 1, jobs: 1, succeeded: 1, failed: 0, prs: 0, merged: 0, costUsd: 0, openWorkItems: 1, lastJobAt: jobOne.created_at }
    const one = dashboardPage({ config, locale: 'en', viewer, repos: [repoOne], jobs: [jobOne], notifications: [], personal })
    assert.match(one, />1<\/b> repository(?!s)/)
    assert.doesNotMatch(one, />1<\/b> repositories/)
    assert.match(one, />1<\/b> job(?!s)/)
    assert.doesNotMatch(one, />1<\/b> jobs/)
    assert.match(one, />1<\/b> open work item(?!s)/)
    assert.doesNotMatch(one, />1<\/b> open work items/)
    const two = dashboardPage({ config, locale: 'en', viewer, repos: [repoOne, repoTwo], jobs: [jobOne, jobTwo], notifications: [], personal: { ...personal, repos: 2, jobs: 2, openWorkItems: 2 } })
    assert.match(two, />2<\/b> repositories/)
    assert.match(two, />2<\/b> jobs/)
    assert.match(two, />2<\/b> open work items/)
  } finally {
    store.close()
  }
})

test('the dashboard names a non-USD bucket instead of converting it', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'currency-bucket-dashboard', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const page = dashboardPage({
      config,
      locale: 'en',
      viewer,
      repos: [],
      jobs: [],
      notifications: [],
      personal: {
        repos: 1,
        jobs: 1,
        succeeded: 1,
        failed: 0,
        prs: 0,
        merged: 0,
        costUsd: 0.3,
        otherCurrencies: [{ currency: 'CNY', amount: 10, requests: 1 }],
        openWorkItems: 0,
        lastJobAt: null,
      },
    })
    // The USD figure is the USD-billed spend, converted at the configured rate.
    assert.match(page, new RegExp(quotaMoney(0.3 * config.quota.usdCny).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    // The CNY row is named in its own currency and never converted.
    assert.match(page, /10\.0000 CNY/)
    assert.doesNotMatch(page, /¥74\.16/)
    // A window with only USD rows says nothing about other currencies.
    const usdOnly = dashboardPage({
      config,
      locale: 'en',
      viewer,
      repos: [],
      jobs: [],
      notifications: [],
      personal: { repos: 1, jobs: 1, succeeded: 1, failed: 0, prs: 0, merged: 0, costUsd: 0.3, otherCurrencies: [], openWorkItems: 0, lastJobAt: null },
    })
    assert.doesNotMatch(usdOnly, /Other currencies/)
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
      metrics: { users: 1, approved: 1, repos: 1, jobs: 2, succeeded: 1, failed: 1, usersWithJobs: 1, usersWithPr: 1, costUsd: 0.4, events: [{ name: 'job_enqueued', n: 2 }], firstMerge: { repositories: 1, samples: 1, medianMs: 86_400_000 }, readyWait: { samples: 1, medianMs: 3_600_000 } },
      team: { jobs: 1, avgRoles: 2, leadOnly: 0, roles: [{ role: 'lead', calls: 3, jobs: 1 }] },
      workItems: { total: 1, open: 0, merged: 1, closed: 0 },
      attribution: { unattributedCount: 0, unattributedUsd: 0, attributedUsd: 0.4 },
      stages: { scope: 0, verify: 0, iterate: 1, review: 1, leadOnly: 0, grounded: 1 },
      delivery: { jobs: 2, succeeded: 1, failed: 1, successRate: 50, prs: 1, merged: 1, mergeRate: 100, changesRequested: 0, reviewAverage: 82, reviewCount: 1, medianJobMs: 600_000, medianMergeMs: 3_600_000, medianReviewMs: 120_000 },
      daily: [{ day: '2026-01-01', jobs: 2, succeeded: 1, failed: 1, merged: 1 }],
      repoCosts: [{ repoId: 'r1', label: 'o/r', costUsd: 0.4, calls: 3 }],
      modelCosts: [{ model: 'model-a', costUsd: 0.4, calls: 3 }],
      currency: { buckets: [{ currency: 'USD', amount: 0.4, requests: 3 }], unknownRequests: 1, semantics: 'lower_bound' },
      alerts: [{ kind: 'job_stalled', level: 'critical', repoId: 'r1', repoLabel: 'o/r', jobId: 'j1', minutes: 60, message: 'job j1 has no callback for 60m' }],
      windowDays: 7,
      failures: [{ kind: 'quota', count: 1 }],
      since: '2026-01-01T00:00:00.000Z',
      automation: { idleWithWork: [{ repo: 'o/r', seconds: 1_200 }], queueDepth: 2, activeJobs: 1, dispatchLatencyMs: 4_500, dispatchSamples: 3 },
    })
    assert.match(page, /Delivery efficiency/)
    // #807: the automation card is on the same page as the numbers it reads.
    assert.match(page, /Automation health/)
    assert.match(page, /4\.5 s/)
    assert.match(page, /Mean over 3 dispatches/)
    assert.match(page, /Daily trend/)
    assert.match(page, /2026-01-01/)
    assert.match(page, /PR merge rate/)
    assert.match(page, /Cost by repository/)
    assert.match(page, /model-a/)
    assert.match(page, /job_stalled/)
    assert.match(page, /7 days/)
    assert.match(page, /Failure breakdown/)
    // #636: each currency is its own bucket, with the amount shown in that
    // currency and an explicit unknown row rather than a silent zero.
    assert.match(page, /Cost by currency/)
    assert.match(page, /USD/)
    assert.match(page, /0\.4000 USD/)
    assert.match(page, /Unknown/)
    assert.match(page, /lower bound/)
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

test('the job page prints the trace token next to the timeline', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'trace-page-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const repo = store.createRepo({ id: 'repo_trace_page', userId: user.id, owner: 'o', name: 'tp', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_trace_page', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const at = new Date().toISOString()
    const events = [
      { id: 1, at, job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.enqueued', role: null, step: 'iterate', meta: 'iterate:manual' },
      { id: 2, at, job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.running', role: null, step: 'iterate', meta: null },
    ]
    const page = jobPage({ config, locale: 'en', viewer, repo, job, events })
    const timeline = cardAfterHeading(page, 'Timeline')
    const tokens = [...timeline.matchAll(/data-trace-token="([^"]*)"/g)]
    assert.equal(tokens.length, 1, 'the timeline names exactly one search token')
    assert.equal(tokens[0]?.[1], job.id, 'the token is the job id')
    assert.match(timeline, new RegExp(`<code>${job.id}</code>`), 'the token is printed as text to copy')
    for (const event of events) assert.equal(event.job_id, tokens[0]?.[1], 'the token matches every job_events.job_id in the timeline')

    const zh = jobPage({ config, locale: 'zh', viewer, repo, job, events })
    assert.match(cardAfterHeading(zh, '时间线'), new RegExp(`data-trace-token="${job.id}"`), 'the Chinese page prints the same token')
  } finally {
    store.close()
  }
})

// #475: the job page led with everything at once. The first slice moves the cost
// into the header line — the number a reader looks for without scrolling — and
// folds the timeline behind a disclosure so the page stops opening with it, while
// every event row still renders.
function seededJobPage(locale: 'en' | 'zh'): { page: string; store: Store; cost: string } {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `lead-page-${locale}`, status: 'approved' })
  const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
  const repo = store.createRepo({ id: `repo_lead_page_${locale}`, userId: user.id, owner: 'o', name: 'lp', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  const job = store.createJob({ id: `job_lead_page_${locale}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
  const at = new Date().toISOString()
  store.updateJob(job.id, { status: 'succeeded', cost_usd: 0.5, finished_at: at, pr_url: 'https://github.com/o/lp/pull/12' })
  const events = [
    { id: 1, at, job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.enqueued', role: null, step: 'iterate', meta: 'iterate:manual' },
    { id: 2, at, job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.running', role: null, step: 'iterate', meta: null },
    { id: 3, at, job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.succeeded', role: null, step: 'iterate', meta: null },
  ]
  const page = jobPage({ config, locale, viewer, repo, job: store.getJob(job.id)!, events })
  return { page, store, cost: quotaMoney(0.5 * config.quota.usdCny) }
}

test('the job page prints the job cost in the header line', () => {
  for (const locale of ['en', 'zh'] as const) {
    const { page, store, cost } = seededJobPage(locale)
    try {
      assert.ok(page.includes(`<span data-header-cost>${cost}</span>`), `${locale}: the header line prints the cost as ${cost}`)
      const header = page.slice(page.indexOf('<section class="card">'), page.indexOf('</section>'))
      assert.match(header, locale === 'en' ? /Cost/ : /成本/, `${locale}: the header names what the number is`)
    } finally {
      store.close()
    }
  }
})

test('the timeline is a disclosure that still renders every event', () => {
  const en = seededJobPage('en')
  try {
    const timeline = /<details[^>]*data-timeline[\s\S]*?<\/details>/.exec(en.page)?.[0] ?? ''
    assert.notEqual(timeline, '', 'the timeline is a disclosure')
    assert.match(timeline, /<summary>/, 'the disclosure has a summary')
    assert.match(timeline, /<h2>Timeline<\/h2>/, 'the timeline heading sits inside the disclosure')
    for (const kind of ['job.enqueued', 'job.running', 'job.succeeded']) assert.ok(timeline.includes(kind), `every event row still renders: ${kind}`)
    assert.match(en.page, /id="timeline"/, 'the disclosure itself is linkable')
    assert.match(en.page, /id="review-merge"/, 'the review anchor still resolves')
  } finally {
    en.store.close()
  }
  const zh = seededJobPage('zh')
  try {
    assert.match(zh.page, /<details[^>]*data-timeline[\s\S]*?<h2>时间线<\/h2>/, 'the Chinese timeline is the same disclosure')
  } finally {
    zh.store.close()
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
    assert.match(page, /data-open-dialog="new-work-item"/, 'the create form is behind a header button')
    assert.match(page, /id="new-work-item"/, 'the create form is a dialog')
    assert.match(page, /data-work-queue/, 'the page names why an item is waiting')
    assert.match(page, /<details class="work-actions">[\s\S]*name="state"/, 'the row actions are folded into one disclosure')
  } finally {
    store.close()
  }
})

test('an empty delivery board shows a dash, not a confident zero share', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'board-empty', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_board_empty', userId: user.id, owner: 'o', name: 'empty-board', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const page = repoPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      jobs: [],
      workItems: [],
    })
    const summary = /<div class="work-summary" id="board"[^>]*>([\s\S]*?)<\/div>/.exec(page)?.[1] ?? ''
    assert.ok(summary !== '', 'the empty board still renders its state links')
    assert.equal((summary.match(/—/g) ?? []).length, WORK_ITEM_STATES.length, 'every state has no denominator, so every state shows a dash')
    assert.doesNotMatch(summary, /0%/, 'a board with no items must not print a confident zero share')
    assert.doesNotMatch(page, /NaN/)
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
      metrics: { users: 1, approved: 1, repos: 1, jobs: 2, succeeded: 1, failed: 1, usersWithJobs: 1, usersWithPr: 0, costUsd: 0, events: [], firstMerge: { repositories: 0, samples: 0, medianMs: null }, readyWait: { samples: 0, medianMs: null } },
      team: { jobs: 0, avgRoles: 0, leadOnly: 0, roles: [] },
      workItems: { total: 0, open: 0, merged: 0, closed: 0 },
      attribution: { unattributedCount: 0, unattributedUsd: 0, attributedUsd: 0 },
      stages: { scope: 0, verify: 0, iterate: 1, review: 0, leadOnly: 0, grounded: 0 },
      delivery: { jobs: 2, succeeded: 1, failed: 1, successRate: 50, prs: 0, merged: 0, mergeRate: 0, changesRequested: 0, reviewAverage: null, reviewCount: 0, medianJobMs: null, medianMergeMs: null, medianReviewMs: null },
      daily: [],
      repoCosts: [],
      modelCosts: [],
      currency: { buckets: [], unknownRequests: 0, semantics: 'exact' },
      alerts: [],
      windowDays: 30,
      failures: [{ kind: 'quota', count: 1 }, { kind: 'github', count: 1 }],
      since: '2026-01-01T00:00:00.000Z',
      automation: { idleWithWork: [], queueDepth: 0, activeJobs: 0, dispatchLatencyMs: null, dispatchSamples: 0 },
    })
    assert.match(page, /Failure breakdown/)
    assert.match(page, /Platform quota exhausted/)
    assert.match(page, /GitHub operation failed/)
  } finally {
    store.close()
  }
})

/** One card out of a page, so a state rendered elsewhere cannot satisfy an assertion. */
function cardWithId(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`)
  assert.notEqual(start, -1, `expected a card with id="${id}" in the page`)
  const end = html.indexOf('</section>', start)
  assert.notEqual(end, -1, `expected the card with id="${id}" to close`)
  return html.slice(start, end)
}

/** The card that starts with one heading, for pages whose cards carry no id. */
function cardAfterHeading(html: string, heading: string): string {
  const start = html.indexOf(`<h2>${heading}</h2>`)
  assert.notEqual(start, -1, `expected a card headed ${heading}`)
  const end = html.indexOf('</section>', start)
  assert.notEqual(end, -1, `expected the card headed ${heading} to close`)
  return html.slice(start, end)
}

test('every empty data region uses the shared state component and points at its own page action', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'empty-state-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const repo = store.createRepo({ id: 'repo_empty_states', userId: user.id, owner: 'o', name: 'empty', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })

    const repoHtml = repoPage({ config, locale: 'en', viewer, repo, jobs: [] })
    const jobsCard = cardWithId(repoHtml, 'jobs')
    assert.match(jobsCard, /data-state="empty"/, 'the repository jobs card renders the shared empty state')
    assert.doesNotMatch(jobsCard, /\/dashboard#add-repo/, 'the repository page never sends an empty job list to add a repository')
    assert.match(jobsCard, /action="\/repos\/repo_empty_states\/run"/, "the repository empty action runs this repository's first job")

    const consoleHtml = workspacePage({ config, locale: 'en', viewer, repos: [repo], jobs: [] })
    const consoleRecent = cardAfterHeading(consoleHtml, 'Recent jobs')
    assert.match(consoleRecent, /data-state="empty"/, 'the console recent-jobs region renders the shared empty state')
    assert.doesNotMatch(consoleRecent, /<p class="muted">No jobs yet\.<\/p>/, 'the console no longer falls back to a bare grey sentence')
    assert.match(consoleRecent, /class="actions"/, 'the console empty state carries an action')

    const settingsHtml = settingsPage({ config, locale: 'en', viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [] })
    const providerCard = cardWithId(settingsHtml, 'model-providers')
    assert.match(providerCard, /data-state="empty"/, 'settings renders the shared empty state when there is no provider')
    assert.doesNotMatch(providerCard, /<p class="muted">No model providers yet\.<\/p>/, 'settings no longer falls back to a bare grey sentence')

    const job = store.createJob({ id: 'job_empty_events', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const jobHtml = jobPage({ config, locale: 'en', viewer, repo, job, events: [] })
    const timelineCard = cardAfterHeading(jobHtml, 'Timeline')
    assert.match(timelineCard, /data-state="empty"/, 'the job timeline renders the shared empty state')
    assert.doesNotMatch(timelineCard, /<p class="muted">No job events yet\.<\/p>/, 'the timeline no longer falls back to a bare grey sentence')
  } finally {
    store.close()
  }
})

test('non-empty data regions render exactly as before, with no state wrapper', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'filled-state-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const repo = store.createRepo({ id: 'repo_filled_states', userId: user.id, owner: 'o', name: 'filled', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_filled_events', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })

    const repoHtml = repoPage({ config, locale: 'en', viewer, repo, jobs: [job] })
    const jobsCard = cardWithId(repoHtml, 'jobs')
    assert.match(jobsCard, /data-job-id="job_filled_events"/)
    assert.doesNotMatch(jobsCard, /data-state=/, 'a non-empty job table gains no state wrapper')

    const consoleHtml = workspacePage({ config, locale: 'en', viewer, repos: [repo], jobs: [job] })
    const consoleRecent = cardAfterHeading(consoleHtml, 'Recent jobs')
    assert.match(consoleRecent, /data-job-id="job_filled_events"/)
    assert.doesNotMatch(consoleRecent, /data-state=/, 'a non-empty recent-jobs list gains no state wrapper')

    const provider = store.createModelProvider({ id: 'prov_filled', userId: user.id, label: 'Filled provider', baseUrl: 'https://api.example.com/v1', keyEnc: 'x', allowPrivate: false })
    const settingsHtml = settingsPage({ config, locale: 'en', viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [{ ...provider, models: [] }] })
    const providerCard = cardWithId(settingsHtml, 'model-providers')
    assert.match(providerCard, /Filled provider/)
    assert.doesNotMatch(providerCard, /data-state=/, 'a configured settings page gains no state wrapper')

    const jobHtml = jobPage({ config, locale: 'en', viewer, repo, job, events: [{ id: 1, at: new Date().toISOString(), job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.enqueued', role: null, step: 'iterate', meta: 'iterate:manual' }] })
    const timelineCard = cardAfterHeading(jobHtml, 'Timeline')
    assert.match(timelineCard, /job\.enqueued/)
    assert.doesNotMatch(timelineCard, /data-state=/, 'a non-empty timeline gains no state wrapper')
  } finally {
    store.close()
  }
})

test('a pull request with half the merge evidence never renders as Ready', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'half-evidence-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const repo = store.createRepo({ id: 'repo_half_evidence', userId: user.id, owner: 'o', name: 'half', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_half_evidence', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    // The production shape: `tryMerge` writes the path guard on its own, then
    // refuses on failing checks, so the row keeps a guard and no verification.
    const guard = { ok: true, checkedAt: new Date().toISOString(), allow: ['src/'], deny: [], files: ['src/a.ts'], violations: [] }
    store.updateJob(job.id, { pr_url: 'https://github.com/o/half/pull/9', pr_state: 'open', path_guard_json: JSON.stringify(guard) })
    const row = store.getJob(job.id)
    assert.notEqual(row, undefined)

    const repoHtml = repoPage({ config, locale: 'en', viewer, repo, jobs: [], prJobs: [row!] })
    const link = repoHtml.indexOf('/pull/9')
    assert.notEqual(link, -1, 'the pull request row is rendered')
    const rowHtml = repoHtml.slice(repoHtml.lastIndexOf('<tr>', link), repoHtml.indexOf('</tr>', link))
    assert.match(rowHtml, /Not verified/, 'the Verified cell says the half was never measured')
    assert.doesNotMatch(rowHtml, />Ready</, 'a half-verified pull request never renders the Ready badge')
    assert.doesNotMatch(rowHtml, /可合并/, 'the Chinese badge is not Ready either')

    const jobHtml = jobPage({ config, locale: 'en', viewer, repo, job: row!, events: [] })
    const card = cardAfterHeading(jobHtml, 'PR verification')
    assert.match(card, /Not verified/, 'the job page badge says not verified')
    assert.doesNotMatch(card, />Ready</, 'the job page never prints the Ready badge above "No verification yet."')
    assert.match(card, /No verification yet\./, 'the card still states that no verification ran')
  } finally {
    store.close()
  }
})

// --- Redirect banner localization (#240) -----------------------------------
//
// A banner sentence reaches a redirect through one of two sinks: S1
// `encodeURIComponent(...)` at the call site, or S2 `withMessage`/`fail`, which
// encode it inside the helper. Every `reply.redirect(...)` is walked, so a third
// helper or a hand-built query fails here instead of shipping a Chinese banner
// to /lang/en. The guard is the whole set, not the texts the issue listed, so a
// banner added by a later PR has to bring its English form with it.

const CJK = /[\u4e00-\u9fff]/

type BannerText = { source: string; rendered: string }

type Interpolation = { body: string; start: number; end: number }

function skipQuoted(text: string, start: number): number {
  const quote = text[start] ?? ''
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') { index += 2; continue }
    if (char === quote) return index
    index += 1
  }
  throw new Error(`unterminated string at ${start}`)
}

function skipTemplate(text: string, start: number): number {
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') { index += 2; continue }
    if (char === '`') return index
    if (char === '$' && text[index + 1] === '{') {
      index = balanced(text, index + 1).end + 1
      continue
    }
    index += 1
  }
  throw new Error(`unterminated template at ${start}`)
}

function balanced(text: string, start: number): { body: string; end: number } {
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === '`') { index = skipTemplate(text, index) + 1; continue }
    if (char === '"' || char === "'") { index = skipQuoted(text, index) + 1; continue }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth === 0) return { body: text.slice(start + 1, index), end: index }
    }
    index += 1
  }
  throw new Error(`unbalanced expression at ${start}`)
}

function scanInterpolations(text: string, offset: number): Interpolation[] {
  const found: Interpolation[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '`') {
      const end = skipTemplate(text, index)
      const content = text.slice(index + 1, end)
      let cursor = 0
      while (cursor < content.length) {
        const inner = content[cursor]
        if (inner === '\\') { cursor += 2; continue }
        if (inner === '$' && content[cursor + 1] === '{') {
          const part = balanced(content, cursor + 1)
          const start = offset + index + 1 + cursor
          found.push({ body: part.body, start, end: start + (part.end - cursor) })
          found.push(...scanInterpolations(part.body, start + 2))
          cursor = part.end + 1
          continue
        }
        cursor += 1
      }
      index = end + 1
      continue
    }
    if (char === '"' || char === "'") { index = skipQuoted(text, index) + 1; continue }
    if (char === '$' && text[index + 1] === '{') {
      const part = balanced(text, index + 1)
      const start = offset + index
      found.push({ body: part.body, start, end: start + (part.end - index) })
      found.push(...scanInterpolations(part.body, start + 2))
      index = part.end + 1
      continue
    }
    index += 1
  }
  return found
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  let index = 0
  while (index < body.length) {
    const char = body[index]
    if (char === '`') { const end = skipTemplate(body, index); current += body.slice(index, end + 1); index = end + 1; continue }
    if (char === '"' || char === "'") { const end = skipQuoted(body, index); current += body.slice(index, end + 1); index = end + 1; continue }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') depth -= 1
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; index += 1; continue }
    current += char
    index += 1
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

type Binding = { kind: 'array'; parts: string[] } | { kind: 'expression'; expression: string }

function bindingBefore(source: string, name: string, before: number): Binding | undefined {
  const pattern = new RegExp(`const ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} =`, 'g')
  let found: number | undefined
  for (const match of source.matchAll(pattern)) {
    if (match.index !== undefined && match.index < before) found = match.index
  }
  if (found === undefined) return undefined
  let index = found + `const ${name} =`.length
  while (index < source.length && /\s/.test(source[index] ?? '')) index += 1
  if (source[index] === '[') {
    const part = balanced(source, index)
    const parts = splitTopLevel(part.body)
    const pushPattern = new RegExp(`\\b${name}\\.push\\(`, 'g')
    for (const match of source.matchAll(pushPattern)) {
      if (match.index === undefined || match.index < found || match.index > before) continue
      const call = balanced(source, match.index + match[0].length - 1)
      parts.push(call.body)
    }
    return { kind: 'array', parts }
  }
  let end = index
  let depth = 0
  while (end < source.length) {
    const char = source[end]
    if (char === '`') { end = skipTemplate(source, end) + 1; continue }
    if (char === '"' || char === "'") { end = skipQuoted(source, end) + 1; continue }
    if (char === '(' || char === '[' || char === '{') depth += 1
    if (char === ')' || char === ']' || char === '}') {
      if (depth === 0) break
      depth -= 1
    }
    if ((char === '\n' || char === ';') && depth === 0) break
    end += 1
  }
  return { kind: 'expression', expression: source.slice(index, end).trim() }
}

function renderTemplate(content: string): string {
  let rendered = ''
  let index = 0
  while (index < content.length) {
    const char = content[index]
    if (char === '\\') { rendered += content.slice(index, index + 2); index += 2; continue }
    if (char === '$' && content[index + 1] === '{') {
      const part = balanced(content, index + 1)
      // A clause written as `condition ? '' : '...'` renders empty in the
      // common case; a fixed `2` is the representative for a value.
      rendered += /\?\s*''\s*:/.test(part.body) ? '' : '2'
      index = part.end + 1
      continue
    }
    rendered += char
    index += 1
  }
  return rendered
}

function textsOf(expression: string, depth = 0): BannerText[] {
  const found: BannerText[] = []
  let index = 0
  while (index < expression.length) {
    const char = expression[index]
    if (char === 't' && expression[index + 1] === '(' && !/[\w$.]/.test(expression[index - 1] ?? '')) {
      // `t(zh, en)` already carries both languages; its Chinese arm is not a
      // banner that needs a row.
      index = balanced(expression, index + 1).end + 1
      continue
    }
    if (char === '"' || char === "'") {
      const end = skipQuoted(expression, index)
      const value = expression.slice(index + 1, end)
      if (CJK.test(value)) found.push({ source: value, rendered: value })
      index = end + 1
      continue
    }
    if (char === '`') {
      const end = skipTemplate(expression, index)
      const content = expression.slice(index + 1, end)
      if (CJK.test(content)) found.push({ source: content, rendered: renderTemplate(content) })
      index = end + 1
      continue
    }
    if (depth < 4 && char === '$' && expression[index + 1] === '{') {
      const part = balanced(expression, index + 1)
      found.push(...textsOf(part.body, depth + 1))
      index = part.end + 1
      continue
    }
    index += 1
  }
  return found
}

function sinkValue(expression: string): { allowed: boolean; message: string } {
  const trimmed = expression.trim()
  if (trimmed.startsWith('withMessage(')) {
    const args = splitTopLevel(balanced(trimmed, trimmed.indexOf('(')).body)
    return { allowed: true, message: args[1] ?? '' }
  }
  if (trimmed.startsWith('fail(')) {
    const args = splitTopLevel(balanced(trimmed, trimmed.indexOf('(')).body)
    return { allowed: true, message: args[0] ?? '' }
  }
  if (trimmed.startsWith('encodeURIComponent(')) {
    return { allowed: true, message: balanced(trimmed, trimmed.indexOf('(')).body }
  }
  return { allowed: false, message: trimmed }
}

function bannerTexts(source: string): { texts: BannerText[]; bypasses: string[] } {
  const texts: BannerText[] = []
  const bypasses: string[] = []
  const seen = new Set<string>()

  function collect(expression: string): void {
    for (const entry of textsOf(expression)) {
      if (seen.has(entry.rendered)) continue
      seen.add(entry.rendered)
      texts.push(entry)
    }
  }

  function push(message: string, at: number): void {
    const trimmed = message.trim()
    if (trimmed === '') return
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      const binding = bindingBefore(source, trimmed, at)
      if (binding === undefined) return
      if (binding.kind === 'array') {
        for (const part of binding.parts) collect(part)
        return
      }
      collect(binding.expression)
      return
    }
    collect(trimmed)
  }

  function isKeyExpression(expression: string, at: number): boolean {
    const trimmed = expression.trim()
    if (/'notice'/.test(trimmed) && /'error'/.test(trimmed)) return true
    if (!/^[A-Za-z_$][\w$]*$/.test(trimmed)) return false
    const binding = bindingBefore(source, trimmed, at)
    return binding?.kind === 'expression' && /'notice'/.test(binding.expression) && /'error'/.test(binding.expression)
  }

  for (const match of source.matchAll(/reply\.redirect\(/g)) {
    if (match.index === undefined) continue
    const at = match.index
    const arg = balanced(source, at + match[0].length - 1).body.trim()
    if (arg.startsWith('withMessage(') || arg.startsWith('fail(')) {
      const parsed = sinkValue(arg)
      push(parsed.message, at)
      continue
    }
    let found = false
    const parts = scanInterpolations(arg, 0).sort((left, right) => left.start - right.start)
    for (let position = 0; position < parts.length; position += 1) {
      const part = parts[position]
      if (part === undefined) continue
      const prefix = arg.slice(0, part.start)
      let isValue = /(?:notice|error)=$/.test(prefix)
      if (!isValue && prefix.endsWith('}=')) {
        const previous = parts[position - 1]
        isValue = previous !== undefined && previous.end === prefix.length - 2 && isKeyExpression(previous.body, at)
      }
      if (!isValue) {
        if (prefix.endsWith('}=')) bypasses.push(`a notice/error key this rule cannot follow in a redirect at offset ${at}`)
        continue
      }
      const parsed = sinkValue(part.body)
      if (!parsed.allowed) { bypasses.push(`${part.body.trim()} in a redirect at offset ${at}`); continue }
      found = true
      push(parsed.message, at)
    }
    const concat = /(?:notice|error)=(['"])\s*\+\s*([\s\S]+)$/.exec(arg)
    if (concat !== null) {
      const parsed = sinkValue(concat[2] ?? '')
      if (!parsed.allowed) bypasses.push(`${(concat[2] ?? '').trim()} in a redirect at offset ${at}`)
      else { found = true; push(parsed.message, at) }
    }
    if (!found && /[?&](?:notice|error)=\S/.test(arg)) bypasses.push(`a banner query with no readable value in a redirect at offset ${at}`)
  }
  return { texts, bypasses }
}

test('every redirect banner value has an English form', () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  const { texts, bypasses } = bannerTexts(source)
  assert.deepEqual(
    bypasses,
    [],
    'every notice=/error= value must be encodeURIComponent at the call site or withMessage/fail; a third helper or a hand-built query fails here',
  )
  // The floor is a broken-extractor alarm, not a pinned count. It moved with #540
  // slice 2: the migrated write adapters answer through `t(zh, en)` and
  // `managementFailure`, which this walk skips by construction (a `t()` call has
  // both languages already), so the literals it can read went down as the routes
  // that used to carry one went up.
  assert.ok(texts.length >= 90, `the extraction read ${texts.length} banner texts; it is meant to cover every redirect in src/app.ts`)
  const unresolved = [...new Set(texts.map((entry) => entry.rendered))]
    .filter((text) => CJK.test(localizeMessage('en', text) ?? ''))
    .sort()
  assert.deepEqual(
    unresolved,
    [],
    'these banner texts have no English form; add a MESSAGES row (plain) or a localizer (interpolated) in src/i18n.ts',
  )

  // A clause a route appends inside the same value is not a text of its own, so
  // the composed shapes are pinned here as a route renders them.
  for (const composed of [
    '已合并 1 个 PR，跳过 2 个（最新任务还没有成功）',
    '已合并 0 个 PR，跳过 1 个（未通过合并检查）',
    '2 个模型已通过测试并保存；失败：a, b',
  ]) {
    assert.doesNotMatch(localizeMessage('en', composed) ?? '', CJK, `a composed banner keeps Chinese: ${composed}`)
  }

  // The same rule across files: only src/app.ts may build a redirect banner.
  const directory = new URL('../src/', import.meta.url)
  for (const entry of readdirSync(directory, { recursive: true })) {
    const file = String(entry)
    if (!file.endsWith('.ts') || file === 'app.ts') continue
    const text = readFileSync(new URL(file, directory), 'utf8')
    assert.doesNotMatch(text, /\?(?:error|notice)=/, `${file} builds a redirect banner outside src/app.ts`)
  }
})

// --- errorPage localization (#449) ------------------------------------------
//
// `errorPage(config, viewer, status, title, message, locale)` runs both sentences
// through `localizeMessage`, which returns an unmatched literal verbatim, so a
// title or a message with no `MESSAGES` row ships in Chinese inside the English
// console. Until this guard only the 404 pair (#444) was pinned, by hand. The walk
// below reads every `errorPage(` call in `src/app.ts` and takes arguments 4 and 5
// (title, message); the sixth argument is the action, whose label is bilingual by
// construction (`t('使用 GitHub 登录', 'Sign in with GitHub')`). The third argument
// became the replied status in #469 and is not a sentence.
//
// An argument is read as the sentences it can be at run time: a literal, both
// branches of a top-level conditional, or the English side of a `t(zh, en)`
// call. Anything else is reported in `unreadable` rather than dropped, so a
// variable that hides a sentence costs one assertion instead of silence.

type ErrorPageArgument = { texts: string[]; unreadable: string[] }

function literalText(expression: string): string | null {
  const trimmed = expression.trim()
  if (trimmed === '') return null
  const quote = trimmed[0]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  const end = quote === '`' ? skipTemplate(trimmed, 0) : skipQuoted(trimmed, 0)
  if (end !== trimmed.length - 1) return null
  let text = ''
  let index = 1
  while (index < trimmed.length - 1) {
    const char = trimmed[index]
    if (char === '\\') { text += trimmed[index + 1] ?? ''; index += 2; continue }
    if (char === '$' && trimmed[index + 1] === '{') { index = balanced(trimmed, index + 1).end + 1; continue }
    text += char
    index += 1
  }
  return text
}

function ternaryBranches(expression: string): { consequent: string; alternate: string } | null {
  let depth = 0
  let question = -1
  let index = 0
  while (index < expression.length) {
    const char = expression[index]
    if (char === '`') { index = skipTemplate(expression, index) + 1; continue }
    if (char === '"' || char === "'") { index = skipQuoted(expression, index) + 1; continue }
    if (char === '(' || char === '[' || char === '{') { depth += 1; index += 1; continue }
    if (char === ')' || char === ']' || char === '}') { depth -= 1; index += 1; continue }
    if (depth === 0 && char === '?') {
      // `?.` and `??` are not conditionals.
      if (expression[index + 1] === '.' || expression[index + 1] === '?') { index += 2; continue }
      question = index
      break
    }
    index += 1
  }
  if (question === -1) return null
  let nesting = 0
  depth = 0
  index = question + 1
  while (index < expression.length) {
    const char = expression[index]
    if (char === '`') { index = skipTemplate(expression, index) + 1; continue }
    if (char === '"' || char === "'") { index = skipQuoted(expression, index) + 1; continue }
    if (char === '(' || char === '[' || char === '{') { depth += 1; index += 1; continue }
    if (char === ')' || char === ']' || char === '}') { depth -= 1; index += 1; continue }
    if (depth === 0 && char === '?') { nesting += 1; index += 1; continue }
    if (depth === 0 && char === ':') {
      if (nesting === 0) {
        return { consequent: expression.slice(question + 1, index), alternate: expression.slice(index + 1) }
      }
      nesting -= 1
    }
    index += 1
  }
  return null
}

function errorPageArgumentTexts(expression: string): ErrorPageArgument {
  const read: ErrorPageArgument = { texts: [], unreadable: [] }

  const walk = (candidate: string): void => {
    const trimmed = candidate.trim()
    const branches = ternaryBranches(trimmed)
    if (branches !== null) {
      walk(branches.consequent)
      walk(branches.alternate)
      return
    }
    const literal = literalText(trimmed)
    if (literal !== null) {
      if (literal.trim() !== '') read.texts.push(literal)
      return
    }
    if (trimmed.startsWith('t(')) {
      const call = balanced(trimmed, 1)
      if (call.end === trimmed.length - 1) {
        walk(splitTopLevel(call.body)[1] ?? '')
        return
      }
    }
    read.unreadable.push(trimmed)
  }

  walk(expression)
  return read
}

function errorPageTexts(source: string): { texts: string[]; unreadable: string[]; calls: number } {
  const texts: string[] = []
  const unreadable: string[] = []
  const seen = new Set<string>()
  let calls = 0
  const needle = 'errorPage('
  let at = source.indexOf(needle)
  while (at !== -1) {
    calls += 1
    const call = balanced(source, at + needle.length - 1)
    const args = splitTopLevel(call.body)
    for (const index of [3, 4]) {
      const read = errorPageArgumentTexts(args[index] ?? '')
      for (const text of read.texts) {
        if (seen.has(text)) continue
        seen.add(text)
        texts.push(text)
      }
      unreadable.push(...read.unreadable)
    }
    at = source.indexOf(needle, at + needle.length)
  }
  return { texts, unreadable: [...new Set(unreadable)].sort(), calls }
}

test('every errorPage sentence has an English form', () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  const { texts, unreadable, calls } = errorPageTexts(source)
  assert.ok(calls >= 20, `walked ${calls} errorPage calls in src/app.ts; the guard is meant to cover every call site`)
  assert.ok(texts.length >= 16, `read ${texts.length} errorPage sentences; an extraction that reads nothing must not pass`)
  assert.deepEqual(
    unreadable,
    ['message'],
    'exactly one errorPage argument is not a sentence the walk can read: the 500 handler forwards the caught message at src/app.ts setErrorHandler. A second one is a decision, not a silent skip',
  )
  const unresolved = [...new Set(texts)]
    .filter((text) => CJK.test(localizeMessage('en', text) ?? ''))
    .sort()
  assert.deepEqual(
    unresolved,
    [],
    'these errorPage sentences have no English form; add a MESSAGES row in src/i18n.ts for each',
  )
})

test('the repository settings can turn the per-job budget into a stop, in both languages', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'budget-settings', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_budget_settings', userId: user.id, owner: 'o', name: 'bs', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const { cookie, csrf } = sessionFor(built, user)

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /name="jobBudgetAction"/, 'the action is a form field')
    assert.match(page.body, /只提醒（默认）/, 'alert is described as the default')
    assert.match(page.body, /取消任务/, 'the Chinese action names are on the page')

    const english = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie, 'accept-language': 'en' } })
    assert.match(english.body, /Alert only \(default\)/)
    assert.match(english.body, /Cancel the job/)

    const save = (action: string): Promise<{ statusCode: number }> => built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, goal: '', enabled: '1', interval: '1440', reviewInterval: '1440', jobBudget: '1.00', jobBudgetAction: action }),
    })

    assert.equal((await save('cancel')).statusCode, 302)
    assert.equal(store.getRepo(repo.id)?.job_budget_action, 'cancel')
    assert.equal(store.getRepo(repo.id)?.job_budget_cny, 1)

    // Anything that is not one of the three known actions falls back to alert:
    // a typo must never silently stop a job.
    assert.equal((await save('explode')).statusCode, 302)
    assert.equal(store.getRepo(repo.id)?.job_budget_action, 'alert')
  } finally {
    await built.close()
  }
})

test('a job stopped by its budget names the action and the next step, in both languages', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'budget-page', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_budget_page', userId: user.id, owner: 'o', name: 'bp', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_budget_page', repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_budget_page', { status: 'paused', error: 'JOB_BUDGET_PAUSED: 单任务成本 0.72 元已超过预算 0.10 元。提高单任务预算后从断点恢复，或重新开始任务。', finished_at: null })
    const { cookie } = sessionFor(built, user)

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/job_budget_page`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /已达单任务预算/)
    assert.match(page.body, /提高单任务预算/, 'the page names the next step')
    assert.match(page.body, /0\.72/, 'and the observed cost')

    const english = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/job_budget_page`, headers: { cookie, 'accept-language': 'en' } })
    assert.match(english.body, /Per-job budget reached/)
    assert.match(english.body, /Raise the per-job budget/)
  } finally {
    await built.close()
  }
})

test('admin search links every later page and keeps the active tab filters', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'search-pager', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const filters = { q: 'x', status: 'failed', kind: 'iterate', priority: '', action: 'repo.settings', from: '2026-01-01', to: '2026-01-31', view: 'jobs' as const }
    const jobsPage = adminSearchPage({ config, locale: 'en', viewer, jobs: [], audit: [], usersById: new Map([[user.id, user.login]]), filters, jobsPage: 1, jobsTotal: 45, auditPage: 2, auditTotal: 60, perPage: 20, lastJobsExport: null, lastAuditExport: null })

    const jobsNext = jobsPage.match(/href="([^"]*jobsPage=2[^"]*)"/)?.at(1)
    assert.ok(jobsNext, 'the jobs tab links to its own second page')
    assert.match(jobsNext, /q=x/, 'the jobs link keeps the keyword')
    assert.match(jobsNext, /status=failed/, 'the jobs link keeps the status filter')
    assert.match(jobsNext, /kind=iterate/, 'the jobs link keeps the kind filter')
    assert.match(jobsNext, /view=jobs/, 'the jobs link keeps the active tab')
    assert.doesNotMatch(jobsNext, /action=/, 'the jobs link carries no audit-only filter')
    assert.doesNotMatch(jobsNext, /auditPage=/, 'the jobs link carries no audit page')

    const auditPage = adminSearchPage({ config, locale: 'en', viewer, jobs: [], audit: [], usersById: new Map([[user.id, user.login]]), filters: { ...filters, view: 'audit' as const }, jobsPage: 1, jobsTotal: 45, auditPage: 2, auditTotal: 60, perPage: 20, lastJobsExport: null, lastAuditExport: null })
    const auditNext = auditPage.match(/href="([^"]*auditPage=3[^"]*)"/)?.at(1)
    assert.ok(auditNext, 'the audit tab links to its own next page')
    assert.match(auditNext, /q=x/, 'the audit link keeps the keyword')
    assert.match(auditNext, /action=repo\.settings/, 'the audit link keeps the action filter')
    assert.match(auditNext, /from=2026-01-01/, 'the audit link keeps the date range')
    assert.match(auditNext, /view=audit/, 'the audit link keeps the active tab')
    assert.doesNotMatch(auditNext, /status=/, 'the audit link carries no jobs-only filter')
    assert.doesNotMatch(auditNext, /jobsPage=/, 'the audit link carries no jobs page')

    const shortJobs = adminSearchPage({ config, locale: 'en', viewer, jobs: [], audit: [], usersById: new Map(), filters, jobsPage: 1, jobsTotal: 20, auditPage: 1, auditTotal: 20, perPage: 20, lastJobsExport: null, lastAuditExport: null })
    assert.doesNotMatch(shortJobs, /jobsPage=2/, 'a tab that fits one page renders no jobs pager')
    const shortAudit = adminSearchPage({ config, locale: 'en', viewer, jobs: [], audit: [], usersById: new Map(), filters: { ...filters, view: 'audit' as const }, jobsPage: 1, jobsTotal: 20, auditPage: 1, auditTotal: 20, perPage: 20, lastJobsExport: null, lastAuditExport: null })
    assert.doesNotMatch(shortAudit, /auditPage=2/, 'a tab that fits one page renders no audit pager')
  } finally {
    store.close()
  }
})
// #453 review: the settings page linked its zero-token empty state at `#tokens`
// while the card carrying that anchor did not exist, so the visual matrix's
// `getElementById('tokens')` returned null and its "section clears the sticky
// header" assertion was skipped rather than failed. One test now covers the
// class: every in-page link on the page that renders that empty state has to
// point at an element that exists.
test('every in-page anchor on the settings page has a matching target', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'anchor-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const html = settingsPage({ config, locale: 'en', viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [] })
    const targets = [...html.matchAll(/href="#([A-Za-z][\w:-]*)"/g)].map((match) => match[1] ?? '')
    assert.ok(targets.includes('tokens'), 'the empty token list still links to the token form')
    const missing = [...new Set(targets)].filter((id) => !html.includes(`id="${id}"`))
    assert.deepEqual(missing, [], `in-page links without a target: ${missing.join(', ')}`)
  } finally {
    store.close()
  }
})

// #860: six chips for four jobs. The nav and the page's cards must stay one list
// in the same order, so grouping the chips means the page grows four group cards
// and the old six become sub-blocks inside them.
test('the settings page groups its six old cards into four sections with four chips', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'settings-groups', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const html = settingsPage({ config, locale: 'en', viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [] })
    const nav = /<nav class="section-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? ''
    const links = [...nav.matchAll(/href="#([A-Za-z][\w:-]*)"/g)].map((match) => match[1])
    assert.deepEqual(links, ['account-access', 'model-providers', 'notifications', 'feedback'], 'the nav is one link per group, in the order the page draws them')
    assert.match(html, /<section class="card" id="account-access">/, 'the three access cards share one group card')
    const inner = /<section class="card" id="account-access">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? ''
    const ids = [...inner.matchAll(/id="(account|sessions|tokens)"/g)].map((match) => match[1])
    assert.deepEqual(ids, ['account', 'sessions', 'tokens'], 'the old anchors survive as sub-blocks, in their reading order')
  } finally {
    store.close()
  }
})

test('the job page shows the adversarial verdict and says when the answer was rejected', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'job-adversarial-page', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_job_adversarial', userId: user.id, owner: 'o', name: 'ja', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_page_adversarial', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const eventOf = (meta: string) => [{ id: 1, at: new Date().toISOString(), job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.adversarial', role: null, step: 'risk', meta }]

    const risk = jobPage({
      config,
      locale: 'en',
      viewer,
      repo,
      job,
      events: eventOf(JSON.stringify({
        status: 'risk',
        verdict: { kind: 'risk', file: 'src/x.ts', line: 9, failureMode: 'stale read', repro: 'open twice', checks: ['read the diff'] },
        target: 'src/x.ts:9',
        model: 'fake/model',
        promptHash: 'abcdef0123456789',
      })),
    })
    assert.match(risk, /Independent adversarial review/)
    assert.match(risk, /concrete risk src\/x\.ts:9/)
    assert.match(risk, /automatic merge was blocked/)
    assert.match(risk, /fake\/model/)
    assert.match(risk, /abcdef012345/)

    const rejected = jobPage({
      config,
      locale: 'zh',
      viewer,
      repo,
      job,
      events: eventOf(JSON.stringify({ status: 'invalid', verdict: { kind: 'invalid', reason: 'a score is not an adversarial review' }, model: 'fake/model' })),
    })
    assert.match(rejected, /独立对抗式审核/)
    assert.match(rejected, /回答被拒绝/)
    assert.match(rejected, /a score is not an adversarial review/)

    const clean = jobPage({
      config,
      locale: 'en',
      viewer,
      repo,
      job,
      events: eventOf(JSON.stringify({ status: 'none', verdict: { kind: 'none', checks: ['read the diff', 'ran npm run check'] }, model: 'fake/model' })),
    })
    assert.match(clean, /no concrete risk \(checks: read the diff, ran npm run check\)/)

    // The events arrive newest-first, as `Store.listJobEvents` returns them. The
    // row must describe the newest verdict: an older risk beside a newer clean
    // answer is a job whose later tip cleared it, and an older clean answer
    // beside a newer risk is a job that regressed. Reading the other end of the
    // list turns both into the first tip's answer.
    const twoEvents = (newerStep: string, newerMeta: string, olderStep: string, olderMeta: string) => [
      { id: 2, at: new Date().toISOString(), job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.adversarial', role: null, step: newerStep, meta: newerMeta },
      { id: 1, at: new Date().toISOString(), job_id: job.id, repo_id: repo.id, user_id: user.id, kind: 'job.adversarial', role: null, step: olderStep, meta: olderMeta },
    ]
    const olderRisk = JSON.stringify({
      status: 'risk',
      verdict: { kind: 'risk', file: 'src/x.ts', line: 9, failureMode: 'stale read', repro: 'open twice', checks: ['read the diff'] },
      target: 'src/x.ts:9',
      model: 'fake/model',
    })
    const cleared = jobPage({
      config,
      locale: 'en',
      viewer,
      repo,
      job,
      events: twoEvents('none', JSON.stringify({ status: 'none', verdict: { kind: 'none', checks: ['read the diff'] }, model: 'fake/model' }), 'risk', olderRisk),
    })
    assert.match(cleared, /no concrete risk \(checks: read the diff\)/)
    assert.doesNotMatch(cleared, /concrete risk src\/x\.ts:9/)

    const regressed = jobPage({
      config,
      locale: 'en',
      viewer,
      repo,
      job,
      events: twoEvents(
        'risk',
        JSON.stringify({ status: 'risk', verdict: { kind: 'risk', file: 'src/y.ts', line: 3, failureMode: 'stale read', repro: 'open twice', checks: ['read the diff'] }, target: 'src/y.ts:3', model: 'fake/model' }),
        'none',
        JSON.stringify({ status: 'none', verdict: { kind: 'none', checks: ['read the diff'] }, model: 'fake/model' }),
      ),
    })
    assert.match(regressed, /concrete risk src\/y\.ts:3/)
    assert.doesNotMatch(regressed, /no concrete risk \(checks: read the diff\)/)
  } finally {
    store.close()
  }
})

// #415: the reviewer badge was the one untranslated word on both repository
// lists, and it was lowercase in English while every neighbouring badge is not.
test('both repository lists translate the reviewer badge', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'reviewer-badge-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const created = store.createRepo({ id: 'repo_reviewer_badge', userId: user.id, owner: 'o', name: 'badge', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.updateRepo(created.id, { reviewer_enabled: 1 })
    const repo = store.getRepo(created.id)!
    assert.equal(repo.reviewer_enabled, 1, 'the fixture repository has the reviewer enabled')

    const dashboard = dashboardPage({ config, locale: 'zh', viewer, repos: [repo], jobs: [], notifications: [] })
    assert.match(dashboard, /<span class="badge">审核者<\/span>/, 'the dashboard repository table translates the reviewer badge')
    assert.doesNotMatch(dashboard, />reviewer</, 'the dashboard repository table carries no bare English reviewer badge')

    const workspace = workspacePage({ config, locale: 'zh', viewer, repos: [repo], jobs: [] })
    assert.match(workspace, /<span class="badge">审核者<\/span>/, 'the console repository list translates the reviewer badge')
    assert.doesNotMatch(workspace, />reviewer</, 'the console repository list carries no bare English reviewer badge')

    const english = workspacePage({ config, locale: 'en', viewer, repos: [repo], jobs: [] })
    assert.match(english, /<span class="badge">Reviewer<\/span>/, 'the English console capitalises the reviewer badge like its neighbours')
    assert.doesNotMatch(english, />reviewer</, 'the English console never prints the lowercase literal')
  } finally {
    store.close()
  }
})

// #805: the status decides the sentence; `last_error` only explains a failure.
// `Instances.stop()` keeps the previous error and a starting instance has none, so
// every non-ready state must say what it is doing, in both languages, with its own
// action — and only `failed` may report a health failure.
test('every workspace state names itself, its own action and never calls a non-ready workspace healthy', () => {
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: 'image' } })
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'instance-health-user', status: 'approved', superadmin: true })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const repo = store.createRepo({ id: 'repo_instance_health', userId: user.id, owner: 'o', name: 'health', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const saveInstance = (status: string, lastError: string | null): void => {
      store.saveRepoInstance({
        repo_id: repo.id, user_id: user.id, container: 'fledge-health', network: 'n', data_dir: '/tmp/health', bridge_script: '/tmp/bridge',
        dsh_port: 1, bridge_port: 2, model_port: 3, model_bind: '127.0.0.1', image: 'image', status, chief_session: 'c',
        team_json: null, bridge_token_enc: 'x', bridge_pid: null, log_pid: null, last_error: lastError,
        created_at: '2026-11-15T08:00:00.000Z', updated_at: '2026-11-15T08:00:00.000Z', last_health_at: '2026-11-15T08:00:00.000Z',
      })
    }
    const instanceCard = (html: string): string => {
      const start = html.indexOf('data-instance-health')
      assert.notEqual(start, -1, 'the Team section has the structured instance card')
      const end = html.indexOf('</section>', start)
      assert.notEqual(end, -1, 'the instance card closes')
      return html.slice(start, end)
    }
    const summaryLine = (html: string): string => {
      const card = instanceCard(html)
      const end = card.indexOf('</p>')
      assert.notEqual(end, -1, 'the instance card has a summary line')
      return card.slice(0, end)
    }
    const cases = [
      { status: 'ready', lastError: null, zhBadge: '就绪', enBadge: 'Ready', zhReason: '健康检查正常', enReason: 'Health check ok', zhAction: '停止工作区', enAction: 'Stop workspace', action: 'instance/stop' },
      { status: 'failed', lastError: 'TypeError: fetch failed', zhBadge: '失败', enBadge: 'Failed', zhReason: 'Bridge 无法连接', enReason: 'Bridge unreachable', zhAction: '启动工作区', enAction: 'Start workspace', action: 'instance' },
      { status: 'failed', lastError: null, zhBadge: '失败', enBadge: 'Failed', zhReason: '健康检查失败', enReason: 'Health check failed', zhAction: '启动工作区', enAction: 'Start workspace', action: 'instance' },
      { status: 'stopped', lastError: 'health check failed: stopped from the console', zhBadge: '已停止', enBadge: 'Stopped', zhReason: '实例已停止，不会接受新任务', enReason: 'The instance is stopped and takes no new jobs', zhAction: '启动工作区', enAction: 'Start workspace', action: 'instance' },
      { status: 'starting', lastError: null, zhBadge: '启动中', enBadge: 'Starting', zhReason: '实例正在创建，还未就绪', enReason: 'The instance is being created and is not ready yet', zhAction: '重新初始化工作区', enAction: 'Reinitialize workspace', action: 'instance' },
      { status: 'provisioning', lastError: 'TypeError: fetch failed', zhBadge: '初始化中', enBadge: 'Provisioning', zhReason: '实例正在初始化，还未就绪', enReason: 'The instance is being provisioned and is not ready yet', zhAction: '重新初始化工作区', enAction: 'Reinitialize workspace', action: 'instance' },
    ]
    for (const state of cases) {
      saveInstance(state.status, state.lastError)
      const instance = store.getRepoInstance(repo.id)!
      const zh = repoPage({ config, locale: 'zh', viewer, repo, instance, jobs: [] })
      const en = repoPage({ config, locale: 'en', viewer, repo, instance, jobs: [] })
      const name = `${state.status} (${state.lastError === null ? 'no error' : 'an old error on the row'})`
      assert.ok(instanceCard(zh).includes(state.zhBadge), `${name}: the zh card carries the status badge`)
      assert.ok(instanceCard(en).includes(state.enBadge), `${name}: the en card carries the status badge`)
      assert.ok(instanceCard(zh).includes(state.zhReason), `${name}: the zh card names the state`)
      assert.ok(instanceCard(en).includes(state.enReason), `${name}: the en card names the state`)
      assert.ok(instanceCard(zh).includes(state.zhAction), `${name}: the zh card offers its own action`)
      assert.ok(instanceCard(en).includes(state.enAction), `${name}: the en card offers its own action`)
      assert.ok(instanceCard(zh).includes(`action="/repos/${repo.id}/${state.action}"`), `${name}: the zh action posts its own form`)
      assert.ok(instanceCard(en).includes(`action="/repos/${repo.id}/${state.action}"`), `${name}: the en action posts its own form`)
      if (state.status === 'ready') {
        assert.ok(!en.includes('Workspace: '), 'a ready instance raises no page-level message')
        assert.ok(!en.includes('Health check failed'), 'a ready instance never reports a failure')
        continue
      }
      assert.ok(summaryLine(zh).includes(state.zhReason), `${name}: the zh summary line carries the reason, not the raw error`)
      assert.ok(!instanceCard(zh).includes('健康检查正常'), `${name}: a non-ready instance is never called healthy in zh`)
      assert.ok(!instanceCard(en).includes('Health check ok'), `${name}: a non-ready instance is never called healthy in en`)
      assert.ok(!zh.includes('健康检查正常'), `${name}: the zh page never calls a non-ready instance healthy`)
      assert.ok(!en.includes('Health check ok'), `${name}: the en page never calls a non-ready instance healthy`)
      assert.ok(zh.includes(`工作区：${state.zhBadge} · ${state.zhReason}`), `${name}: the zh page message repeats the status and the reason`)
      assert.ok(en.includes(`Workspace: ${state.enBadge} · ${state.enReason}`), `${name}: the en page message repeats the status and the reason`)
      if (state.lastError !== null && state.status !== 'failed') {
        assert.ok(!summaryLine(en).includes(state.lastError), `${name}: an old error is not the reason of a non-failed state`)
      }
      if (state.lastError !== null) {
        assert.ok(instanceCard(en).includes('Technical detail'), `${name}: the raw error stays behind the disclosure`)
        assert.ok(instanceCard(en).includes(state.lastError), `${name}: the disclosure keeps the original text`)
        assert.ok(!en.slice(0, en.indexOf('data-instance-health')).includes(state.lastError), `${name}: the raw error is not the page-level message`)
      }
    }
  } finally {
    store.close()
  }
})

// #871: a tooltip answers "what is this field", not "what is the policy". These
// assertions read the rendered `data-tip` attribute rather than the source, so a
// tip that is only long because one language was edited is caught as well.
const TIP_ABBREVIATIONS = ['e.g.', 'i.e.', 'v1.', 'v2.', 'etc.', 'vs.', 'approx.']
const TIP_LIMIT = 120

function decodedTip(attribute: string): string {
  return attribute
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function tipsOf(html: string): string[] {
  return [...html.matchAll(/data-tip="([^"]*)"/g)].map((match) => decodedTip(match[1] ?? ''))
}

// `e.g.`, `v1.` and friends are not sentence ends, so they are neutralised
// before the terminators are counted; without that list punctuation could be
// used to dodge the rule, which is the point of the list living here.
function sentenceEnds(text: string): number {
  let rest = text
  for (const abbreviation of TIP_ABBREVIATIONS) rest = rest.split(abbreviation).join(' ')
  const cjk = (rest.match(/[。！？]/g) ?? []).length
  const latin = (rest.match(/[.!?](?=\s|$)/g) ?? []).length
  return cjk + latin
}

function densityApp(): { config: ReturnType<typeof testConfig>; store: Store; viewer: ReturnType<typeof densityViewer>; repo: ReturnType<Store['createRepo']> } {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'density-user', status: 'approved' })
  const repo = store.createRepo({ id: 'repo_density', userId: user.id, owner: 'o', name: 'density', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  return { config, store, viewer: densityViewer(store, user.id), repo }
}

function densityViewer(store: Store, userId: string): { user: NonNullable<ReturnType<Store['userById']>>; csrfToken: string } {
  return { user: store.userById(userId)!, csrfToken: 'csrf' }
}

function densityPages(): Array<{ page: string; locale: 'zh' | 'en'; html: string }> {
  const { config, store, viewer, repo } = densityApp()
  try {
    const out: Array<{ page: string; locale: 'zh' | 'en'; html: string }> = []
    for (const locale of ['zh', 'en'] as const) {
      out.push({ page: 'dashboard', locale, html: dashboardPage({ config, locale, viewer, repos: [repo], jobs: [], notifications: [] }) })
      out.push({ page: 'repo', locale, html: repoPage({ config, locale, viewer, repo, jobs: [] }) })
      out.push({ page: 'settings', locale, html: settingsPage({ config, locale, viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [] }) })
      out.push({
        page: 'appRepos',
        locale,
        html: appReposPage({
          config,
          locale,
          viewer,
          installations: [{ installation_id: 1, account_login: 'acme', account_type: 'User' }],
          installationId: 1,
          repos: [{ fullName: 'acme/repo', owner: 'acme', name: 'repo', private: false, defaultBranch: 'main' }],
        }),
      })
    }
    return out
  } finally {
    store.close()
  }
}

test('no tooltip is a paragraph', () => {
  const offenders: string[] = []
  for (const { page, locale, html } of densityPages()) {
    for (const tip of tipsOf(html)) {
      const ends = sentenceEnds(tip)
      if (tip.length > TIP_LIMIT) offenders.push(`${page} ${locale}: ${tip.length} characters — ${tip}`)
      if (ends > 1) offenders.push(`${page} ${locale}: ${ends} sentence ends — ${tip}`)
      if (/[；;]/.test(tip)) offenders.push(`${page} ${locale}: chained clauses with a semicolon — ${tip}`)
    }
  }
  assert.deepEqual(offenders, [], `every tooltip is one sentence of at most ${TIP_LIMIT} characters`)
})

test('both languages of every tooltip stay in step', () => {
  const pages = densityPages()
  for (const page of ['dashboard', 'repo', 'settings', 'appRepos']) {
    const zh = tipsOf(pages.find((entry) => entry.page === page && entry.locale === 'zh')!.html)
    const en = tipsOf(pages.find((entry) => entry.page === page && entry.locale === 'en')!.html)
    assert.equal(zh.length, en.length, `${page} renders the same number of tooltips in both languages`)
    for (const [index, tip] of zh.entries()) {
      const english = en[index] ?? ''
      assert.ok(tip.trim() !== '', `${page} tooltip ${index} has Chinese text`)
      assert.ok(english.trim() !== '', `${page} tooltip ${index} has English text`)
      assert.ok(tip.length <= TIP_LIMIT, `${page} tooltip ${index} is within the cap in Chinese`)
      assert.ok(english.length <= TIP_LIMIT, `${page} tooltip ${index} is within the cap in English`)
    }
  }
})

test('the token expiry rule is read, not hovered', () => {
  const { config, store, viewer } = densityApp()
  try {
    const zh = settingsPage({ config, locale: 'zh', viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [] })
    const en = settingsPage({ config, locale: 'en', viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [] })
    const zhAfter = zh.slice(zh.indexOf('name="expiryDays"'))
    const enAfter = en.slice(en.indexOf('name="expiryDays"'))
    assert.match(zhAfter, /<p class="fine">[^<]*个人 token 必须有期限/, 'the expiry rule is printed under the select in Chinese')
    assert.match(enAfter, /<p class="fine">[^<]*A personal token must expire/, 'the expiry rule is printed under the select in English')
    assert.deepEqual(tipsOf(zh).filter((tip) => tip.includes('必须有期限')), [], 'the expiry rule is not left inside a tooltip')
    assert.deepEqual(tipsOf(en).filter((tip) => tip.includes('must expire')), [], 'the expiry rule is not left inside a tooltip')
  } finally {
    store.close()
  }
})

test('the auto-merge protection rule is read, not hovered', () => {
  const { config, store, viewer, repo } = densityApp()
  try {
    const zh = repoPage({ config, locale: 'zh', viewer, repo, jobs: [] })
    const en = repoPage({ config, locale: 'en', viewer, repo, jobs: [] })
    const zhAfter = zh.slice(zh.indexOf('name="requireProtection"'))
    const enAfter = en.slice(en.indexOf('name="requireProtection"'))
    assert.match(zhAfter, /<p class="fine">[^<]*自动合并要求 branch protection/, 'the protection rule is printed under the checkbox in Chinese')
    assert.match(enAfter, /<p class="fine">[^<]*Auto-merge requires branch protection/, 'the protection rule is printed under the checkbox in English')
    assert.deepEqual(tipsOf(zh).filter((tip) => tip.includes('自动合并要求')), [], 'the protection rule is not left inside a tooltip')
    assert.deepEqual(tipsOf(en).filter((tip) => tip.includes('Auto-merge requires')), [], 'the protection rule is not left inside a tooltip')
  } finally {
    store.close()
  }
})

test('no page prints the tooltip helper or an unrendered template', () => {
  for (const { page, locale, html } of densityPages()) {
    assert.doesNotMatch(html, /\{infoTip\(/, `${page} ${locale} interpolates the helper instead of printing it`)
    assert.doesNotMatch(html, /\$\{/, `${page} ${locale} has no unrendered template expression`)
  }
})

// #865: one primary action in the job header, the rest behind one disclosure,
// and the four read-back cards open on demand. The order is the card's: a rule
// change first (nothing later can be trusted until it is acknowledged), then
// execute, then resume, then retry; a queued or running job has nothing to
// advance. The sets below were read at the base sha, so "folded, not deleted"
// is checked against what the page rendered before this change.
test('the job page leads with one primary action and folds the rest (#865)', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'one-primary-user', status: 'approved', superadmin: true })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    let seq = 0

    function verification(ruleChange: boolean): string {
      return JSON.stringify({
        ok: true,
        checkedAt: '2026-11-16T09:00:00.000Z',
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        prState: 'open',
        draft: false,
        mergeableState: 'clean',
        checks: { total: 3, green: 3, failing: [], pending: [] },
        combinedStatus: 'success',
        reviews: { changesRequested: false, approvals: 1 },
        testEvidence: { state: 'verified', claimed: true, greenChecks: ['tests'], failingChecks: [] },
        reasons: [],
        ...(ruleChange ? { ruleChange: { paths: ['docs/api.md', 'src/views/pages.ts'], acknowledged: false } } : {}),
      })
    }

    function render(input: {
      status: 'failed' | 'paused' | 'running' | 'succeeded'
      ruleChange?: boolean
      checkpoint?: string | null
      pr?: boolean
      kind?: 'iterate' | 'plan'
      planApproved?: boolean
      postmortem?: boolean
      changeStory?: boolean
    }): string {
      seq += 1
      const repo = store.createRepo({ id: `repo_one_primary_${seq}`, userId: user.id, owner: 'o', name: `op${seq}`, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', roleCheckedAt: new Date().toISOString(), goal: '', autoIterate: false, intervalMinutes: 1440 })
      const created = store.createJob({ id: `job_one_primary_${seq}`, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '', kind: input.kind ?? 'iterate' })
      store.updateJob(created.id, {
        status: input.status,
        finished_at: input.status === 'running' || input.status === 'paused' ? null : new Date().toISOString(),
        verification_json: verification(input.ruleChange === true),
        pr_url: input.pr === false ? null : 'https://github.com/o/op/pull/9',
        checkpoint: input.checkpoint ?? null,
        ...(input.planApproved === true ? { plan_approved_at: new Date().toISOString(), plan_approved_by: user.login } : {}),
      })
      const postmortem: PostmortemRow | null = input.postmortem === true
        ? {
            id: 'pm_one_primary', job_id: created.id, repo_id: repo.id, user_id: user.id,
            status: 'open', category: 'timeout', outcome: 'failed', recurrence_key: 'k',
            evidence_state: 'verified', evidence_json: null, timeline_json: null,
            suspected_cause: 'the job stopped reporting', owner: 'operator', preventive_action: 'watch the heartbeat',
            preventive_kind: 'monitor', preventive_verified: 0, preventive_verified_at: null,
            first_seen_at: '2026-11-16T09:00:00.000Z', last_seen_at: '2026-11-16T09:00:00.000Z',
            closed_at: null, created_at: '2026-11-16T09:00:00.000Z', updated_at: '2026-11-16T09:00:00.000Z',
          }
        : null
      const changeStory: ChangeStory | undefined = input.changeStory === true
        ? { bodyState: 'ok', sections: [], totals: null, diffState: 'ok', attribution: null }
        : undefined
      return jobPage({
        config,
        locale: 'en',
        viewer,
        repo,
        job: store.getJob(created.id)!,
        events: [],
        ...(postmortem === null ? {} : { postmortem }),
        ...(changeStory === undefined ? {} : { changeStory }),
      })
    }

    function headerOf(page: string): string {
      const start = page.indexOf('<h1><code>')
      assert.ok(start > 0, 'the page renders the job header')
      return page.slice(start, page.indexOf('</section>', start))
    }
    function primaries(html: string): number {
      return (html.match(/class="btn"/g) ?? []).length
    }
    function formOf(html: string, suffix: string): string {
      const marker = `/${suffix}"`
      const at = html.indexOf(marker)
      assert.ok(at > 0, `the page still renders the ${suffix} action`)
      return html.slice(html.lastIndexOf('<form', at), html.indexOf('</form>', at) + '</form>'.length)
    }
    function jobActions(html: string): string[] {
      const found = new Set<string>()
      for (const match of html.matchAll(/action="(\/repos\/[^"]*\/jobs\/[^/"]*\/([a-z-]+))"/g)) {
        const suffix = match[2]
        if (suffix !== undefined) found.add(suffix)
      }
      return [...found].sort()
    }

    // 1. Failed job with an unacknowledged rule change: acknowledge is the one
    // primary; retry is reachable inside More actions as a ghost.
    const failedRule = render({ status: 'failed', ruleChange: true })
    const failedRuleHeader = headerOf(failedRule)
    assert.equal(primaries(failedRuleHeader), 1, 'a failed job with a rule change has one primary, not two')
    assert.match(formOf(failedRuleHeader, 'ack-rule-change'), /<button class="btn" type="submit">/, 'acknowledge is the primary')
    assert.match(formOf(failedRuleHeader, 'retry'), /<button class="btn btn-ghost" type="submit">/, 'retry is subordinate')
    assert.ok(failedRuleHeader.indexOf('<details class="job-more">') < failedRuleHeader.indexOf('/retry"'), 'retry sits inside More actions')

    // 2. Paused job with the same verification: acknowledge first, resume under it.
    const pausedRule = headerOf(render({ status: 'paused', ruleChange: true }))
    assert.equal(primaries(pausedRule), 1, 'a paused job with a rule change has one primary')
    assert.match(formOf(pausedRule, 'ack-rule-change'), /<button class="btn" type="submit">/, 'acknowledge leads a paused job too')
    assert.match(formOf(pausedRule, 'resume'), /<button class="btn btn-ghost" type="submit">/, 'resume is subordinate')
    assert.ok(pausedRule.indexOf('<details class="job-more">') < pausedRule.indexOf('/resume"'), 'resume sits inside More actions')

    // 3. Failed job without a rule change: retry is the only primary, and the
    // checkpoint wording still depends on the checkpoint.
    const failed = headerOf(render({ status: 'failed' }))
    assert.equal(primaries(failed), 1, 'a plain failed job has one primary')
    assert.match(formOf(failed, 'retry'), /<button class="btn" type="submit">[^<]*Retry this job/, 'retry is the primary and keeps its label')
    const checkpoint = headerOf(render({ status: 'failed', checkpoint: 'step-4' }))
    assert.match(formOf(checkpoint, 'retry'), /Resume from checkpoint/, 'a checkpointed failed job still says Resume from checkpoint')

    // 4. Running job: nothing claims to advance it; pause and cancel stay out of
    // the disclosure, and nothing renders a More actions box when it would be empty.
    const running = render({ status: 'running', pr: false })
    const runningHeader = headerOf(running)
    assert.equal(primaries(runningHeader), 0, 'a running job has no primary action')
    assert.match(formOf(runningHeader, 'pause'), /<button class="btn btn-ghost" type="submit">Pause/, 'pause stays visible as a ghost')
    assert.match(formOf(runningHeader, 'cancel'), /<button class="btn btn-danger" type="submit">Cancel/, 'cancel stays visible as a danger button')
    assert.doesNotMatch(runningHeader, /class="job-more"/, 'an empty disclosure is not rendered')

    // 5. Nothing is lost: every job action the page rendered before this change
    // is still rendered in the same state.
    assert.deepEqual(jobActions(failedRule), ['ack-rule-change', 'priority', 'recheck', 'relations', 'retry'], 'the failed + rule-change state keeps every action')
    assert.deepEqual(jobActions(render({ status: 'paused', ruleChange: true })), ['ack-rule-change', 'priority', 'recheck', 'relations', 'resume'], 'the paused + rule-change state keeps every action')
    assert.deepEqual(jobActions(render({ status: 'running' })), ['cancel', 'pause', 'priority', 'recheck', 'relations'], 'the running state keeps every action')

    // An approved plan still gets its one forward step as the primary.
    const executing = headerOf(render({ status: 'succeeded', kind: 'plan', planApproved: true }))
    assert.equal(primaries(executing), 1, 'an approved plan has one primary')
    assert.match(formOf(executing, 'execute'), /<button class="btn" type="submit">[^<]*Execute this plan/, 'execute is the primary for an approved plan')

    // 6. The four read-back cards still exist exactly once, unchanged inside a
    // collapsed wrapper named after the card.
    const detailPage = render({ status: 'succeeded', kind: 'plan', planApproved: true, postmortem: true, changeStory: true })
    // #475 adds the timeline as a fifth disclosure; the four read-back cards stay
    // exactly one wrapper each.
    assert.equal((detailPage.match(/class="job-detail"/g) ?? []).length, 5, 'the four read-back cards and the timeline are wrapped')
    assert.match(detailPage, /<details class="job-detail" data-timeline id="timeline">\s*<summary>Show timeline/, 'the timeline is the fifth disclosure')
    assert.match(detailPage, /<details class="job-detail"><summary>Work type<\/summary><section class="card" data-work-type="iterate">/, 'work type keeps its markup inside the wrapper')
    assert.match(detailPage, /<details class="job-detail"><summary>Why this change<\/summary><section class="card" data-change-story>/, 'the change story keeps its markup inside the wrapper')
    assert.match(detailPage, /<details class="job-detail"><summary>Postmortem<\/summary><section class="card" id="postmortem">/, 'the postmortem keeps its markup inside the wrapper')
    assert.match(detailPage, /<details class="job-detail"><summary>Team participation<\/summary><section class="card">/, 'team participation is wrapped too')
    assert.equal((detailPage.match(/id="postmortem"/g) ?? []).length, 1, 'the postmortem is still rendered exactly once')
    assert.match(detailPage, /<section class="card" data-work-type="iterate">[\s\S]*?<\/section>/, 'the work-type section still closes as one card')
  } finally {
    store.close()
  }
})

// #378: the page has to show what the change was expected to run and which test
// was taken out of the evidence, with the reason attached to each path.
test('the job page shows the selected tests, the impact reason and the quarantined list', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'impact-page-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_impact_page', userId: user.id, owner: 'o', name: 'ip', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_impact_page', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const verification = {
      ok: true,
      checkedAt: '2026-11-09T17:00:00.000Z',
      sha: 'c'.repeat(40),
      prState: 'open',
      draft: false,
      mergeableState: 'clean',
      checks: { total: 3, green: 3, failing: [], pending: [] },
      combinedStatus: 'success',
      reviews: { changesRequested: false, approvals: 1 },
      testEvidence: { state: 'verified', claimed: true, greenChecks: ['test (24)'], failingChecks: [], quarantinedChecks: ['test (22)'] },
      testImpact: { state: 'mapped', selected: [{ path: 'test/foo.test.ts', reason: 'convention' }, { path: 'test/bar.test.ts', reason: 'importer' }], truncated: false, limit: 50 },
      reasons: [],
    }
    store.updateJob(job.id, {
      pr_url: 'https://github.com/o/ip/pull/6',
      pr_state: 'open',
      verification_json: JSON.stringify(verification),
      path_guard_json: JSON.stringify({ ok: true, checkedAt: '2026-11-09T17:00:00.000Z', allow: [], deny: [], files: ['src/foo.ts'], violations: [] }),
    })
    const read = (locale: 'en' | 'zh'): string => jobPage({ config, locale, viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, job: store.getJob(job.id)! })

    const en = read('en')
    assert.match(en, /Test selection/)
    assert.match(en, /test\/foo\.test\.ts \(convention\)/)
    assert.match(en, /test\/bar\.test\.ts \(importer\)/)
    assert.match(en, /quarantined 1: test \(22\)/)
    const zh = read('zh')
    assert.match(zh, /测试选择/)
    assert.match(zh, /隔离 1 个/)
    assert.doesNotMatch(zh, /Test selection/, 'the Chinese page uses the Chinese label')

    store.updateJob(job.id, {
      verification_json: JSON.stringify({ ...verification, testImpact: { state: 'no impact map', selected: [], truncated: false, limit: 50 } }),
    })
    assert.match(read('en'), /No impact map/)
  } finally {
    store.close()
  }
})

// #1069: quiet hours are a window on the notification card, read in the digest
// timezone. Both languages must carry the fields; a lone time, an equal pair or
// a malformed value is refused instead of being saved as a silent 24h mute.
test('the settings page offers quiet hours in the digest timezone and saves or clears them', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'quiet-hours-ui', status: 'approved' })
    const { cookie, csrf } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /name="quietStart"/, 'the start time is on the notification card')
    assert.match(page.body, /name="quietEnd"/, 'the end time is on the card')
    assert.match(page.body, /安静时段/, 'the Chinese label is present')
    assert.match(page.body, /Asia\/Shanghai/, 'the window names the zone it is read in')

    const english = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie, 'accept-language': 'en' } })
    assert.equal(english.statusCode, 200)
    assert.match(english.body, /name="quietStart"/)
    assert.match(english.body, /Quiet hours/i)

    const save = (fields: Record<string, string>): Promise<{ statusCode: number }> => built.app.inject({
      method: 'POST',
      url: '/settings/notifications',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, jobUpdates: '1', dailyDigest: '1', action: 'save', ...fields }),
    })

    assert.equal((await save({ quietStart: '23:00', quietEnd: '07:00' })).statusCode, 302)
    assert.equal(store.userById(user.id)?.quiet_hours_start, '23:00')
    assert.equal(store.userById(user.id)?.quiet_hours_end, '07:00')

    const rendered = await built.app.inject({ method: 'GET', url: '/settings', headers: { cookie } })
    assert.match(rendered.body, /name="quietStart" value="23:00"/)
    assert.match(rendered.body, /name="quietEnd" value="07:00"/)

    assert.equal((await save({ quietStart: '07:00', quietEnd: '07:00' })).statusCode, 302)
    assert.equal(store.userById(user.id)?.quiet_hours_start, '23:00', 'an empty window is refused, not saved')
    assert.equal(store.userById(user.id)?.quiet_hours_end, '07:00')

    assert.equal((await save({ quietStart: '23:00', quietEnd: '' })).statusCode, 302)
    assert.equal(store.userById(user.id)?.quiet_hours_end, '07:00', 'half a window is refused')

    assert.equal((await save({ quietStart: '', quietEnd: '' })).statusCode, 302)
    assert.equal(store.userById(user.id)?.quiet_hours_start, null, 'leaving both blank turns the window off')
    assert.equal(store.userById(user.id)?.quiet_hours_end, null)
  } finally {
    await built.close()
  }
})

// #1104: the platform quota stops only a repository whose model the platform
// pays for (`platformFundedFor`), so the page message may not tell an account
// that runs on its own model that its jobs cannot continue — the page's own next
// action already refuses to offer that step to that account.
const bannerStack = (html: string): string => {
  const start = html.indexOf('data-notification-stack')
  assert.notEqual(start, -1, 'the page renders the banner stack')
  const end = html.indexOf('</section>', start)
  assert.notEqual(end, -1, 'the banner stack closes')
  return html.slice(start, end)
}

const quotaBannerSetup = (modelConfigured: boolean) => ({
  repos: 1,
  roleChosen: true,
  providerConfigured: true,
  modelConfigured,
  platformAvailable: false,
  platformQuotaRemainingCny: 0,
  platformQuotaUnlimited: false,
  platformQuotaComfortCny: 50,
  instanceReady: true,
  jobs: 3,
  firstJobStatus: 'merged',
  firstPrUrl: 'https://github.com/o/r/pull/1',
  repoHref: '/repos/repo_quota_banner',
})

test('the exhausted-quota banner never claims an own-model account is blocked', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'quota-banner-own-model', status: 'approved', quota: 0 })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }

    const dashboard = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [], setup: quotaBannerSetup(true), platformFunded: false })
    assert.doesNotMatch(dashboard, /keep jobs running|任务才能继续/, 'the dashboard must not say the jobs stopped for an account that runs on its own model')
    assert.doesNotMatch(dashboard, /Platform quota is used up|平台额度已用完/, 'no quota banner remains for an account whose repositories are not platform-funded')

    const consoleHtml = workspacePage({ config, locale: 'en', viewer, repos: [], jobs: [], platformFunded: false })
    assert.doesNotMatch(consoleHtml, /keep jobs running|任务才能继续/, 'the console must not say the jobs stopped for an account that runs on its own model')
    assert.doesNotMatch(consoleHtml, /Platform quota is used up|平台额度已用完/, 'the console carries no quota banner for that account')
  } finally {
    store.close()
  }
})

test('the exhausted-quota banner states the per-repository rule and links the fix', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'quota-banner-platform-model', status: 'approved', quota: 0 })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const link = 'href="/settings#model-providers"'

    const dashboard = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [], setup: quotaBannerSetup(false), platformFunded: true })
    const banner = bannerStack(dashboard)
    assert.match(banner, /Platform quota is used up/, 'a platform-funded account is still told that the quota is spent')
    assert.match(banner, /repositories on the platform model pause/, 'the banner names the repositories that actually stop')
    assert.match(banner, /repositories with their own model keep running/, 'the banner names the repositories that keep running')
    assert.doesNotMatch(banner, /keep jobs running|任务才能继续/, 'the banner does not claim every job stopped')
    assert.ok(banner.includes(link), 'the banner links the section that fixes it')

    const chinese = bannerStack(dashboardPage({ config, locale: 'zh', viewer, repos: [], jobs: [], notifications: [], setup: quotaBannerSetup(false), platformFunded: true }))
    assert.match(chinese, /使用平台模型的仓库会暂停/, 'the Chinese banner states the same split')
    assert.ok(chinese.includes(link), 'the Chinese banner carries the same link')

    const consoleBanner = bannerStack(workspacePage({ config, locale: 'en', viewer, repos: [], jobs: [], platformFunded: true }))
    assert.match(consoleBanner, /Platform quota is used up/, 'the console keeps the message for the account that really is stopped')
    assert.match(consoleBanner, /repositories on the platform model pause/, 'the console states the same split')
    assert.ok(consoleBanner.includes(link), 'the console banner links the same section')
  } finally {
    store.close()
  }
})

test('the exhausted-quota banner stays for a mixed account until no repository is platform-funded', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'quota-banner-mixed', status: 'approved', quota: 0 })
    const ownRepo = store.createRepo({ id: 'repo_mixed_own', userId: user.id, owner: 'o', name: 'own', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const platformRepo = store.createRepo({ id: 'repo_mixed_platform', userId: user.id, owner: 'o', name: 'platform', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const provider = store.createModelProvider({ id: 'prv_mixed', userId: user.id, label: 'Own', baseUrl: 'https://own.example/v1', keyEnc: 'enc', allowPrivate: false })
    const model = store.createProviderModel({ id: 'pvm_mixed', providerId: provider.id, model: 'own-model', label: 'Own model' })
    store.setRepoModelSelection(ownRepo.id, [model.id], model.id)
    const { cookie } = sessionFor(built, user)
    const headers = { cookie, 'accept-language': 'en' }
    const link = 'href="/settings#model-providers"'

    // One own-model repository does not unpause the platform-funded one, so the
    // banner that repository depends on must stay — on both pages that carry it.
    // A page with no page messages renders no stack at all, and a stack is where
    // every banner lives, so an absent region is an absent banner.
    const bannerRegion = (html: string): string => {
      const start = html.indexOf('data-notification-stack')
      if (start === -1) return ''
      const end = html.indexOf('</section>', start)
      assert.notEqual(end, -1, 'the banner stack closes')
      return html.slice(start, end)
    }

    const dashboardBanner = bannerRegion((await built.app.inject({ method: 'GET', url: '/dashboard', headers })).body)
    assert.match(dashboardBanner, /Platform quota is used up/, 'the platform-funded repository is still paused, so the banner remains')
    assert.match(dashboardBanner, /repositories on the platform model pause/, 'the banner names what the quota pauses')
    assert.ok(dashboardBanner.includes(link), 'the banner links the section that fixes it')

    const consoleBanner = bannerRegion((await built.app.inject({ method: 'GET', url: '/console', headers })).body)
    assert.match(consoleBanner, /Platform quota is used up/, 'the console states the same fact for the same account')
    assert.ok(consoleBanner.includes(link), 'the console banner carries the same link')

    // Only when the last platform-funded repository gets its own model is
    // nothing paused, and then both pages drop the banner.
    store.setRepoModelSelection(platformRepo.id, [model.id], model.id)
    const ownOnlyDashboard = bannerRegion((await built.app.inject({ method: 'GET', url: '/dashboard', headers })).body)
    assert.doesNotMatch(ownOnlyDashboard, /Platform quota is used up|平台额度已用完/, 'no repository is platform-funded any more, so the dashboard keeps no quota banner')
    const ownOnlyConsole = bannerRegion((await built.app.inject({ method: 'GET', url: '/console', headers })).body)
    assert.doesNotMatch(ownOnlyConsole, /Platform quota is used up|平台额度已用完/, 'and the console keeps none either')
  } finally {
    await built.close()
  }
})

test('an account with no repository and no own model still sees the exhausted-quota banner', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    // Before #1104 this account saw the banner; it is the state every account
    // starts in, so the per-repository predicate must not turn "no repository is
    // platform-funded" into "nothing can be paused" for it.
    const user = makeUser(store, { login: 'quota-banner-empty', status: 'approved', quota: 0 })
    assert.equal(store.listRepos(user.id).length, 0, 'the account has no repository at all')
    const { cookie } = sessionFor(built, user)
    const headers = { cookie, 'accept-language': 'en' }
    const bannerRegion = (html: string): string => {
      const start = html.indexOf('data-notification-stack')
      if (start === -1) return ''
      const end = html.indexOf('</section>', start)
      assert.notEqual(end, -1, 'the banner stack closes')
      return html.slice(start, end)
    }

    const dashboardBanner = bannerRegion((await built.app.inject({ method: 'GET', url: '/dashboard', headers })).body)
    assert.match(dashboardBanner, /Platform quota is used up/, 'an empty account with no own model still reads the quota state on the dashboard')
    assert.ok(dashboardBanner.includes('href="/settings#model-providers"'), 'the banner links the section that changes it')

    const consoleBanner = bannerRegion((await built.app.inject({ method: 'GET', url: '/console', headers })).body)
    assert.match(consoleBanner, /Platform quota is used up/, 'the console states the same fact for the same empty account')
  } finally {
    await built.close()
  }
})

test('the next-step card offers its form only to a role the decision route accepts', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'decision-role-user', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const repo = store.createRepo({ id: 'repo_decision_role', userId: user.id, owner: 'o', name: 'decision-role', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_decision_role', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'verify the fix', callbackHash: 'cb-decision-role', platformTokenHash: '', kind: 'verify' })
    store.updateJob(job.id, { status: 'succeeded' })
    const row = store.getJob(job.id)!
    const action = /action="\/repos\/repo_decision_role\/jobs\/job_decision_role\/decision"/

    // The route refuses every role but maintainer and developer, so the card
    // must not hand a viewer a form whose only outcome is that refusal.
    const viewerHtml = jobPage({ config, locale: 'en', viewer, repo, job: row, events: [], viewerRole: 'viewer' })
    assert.doesNotMatch(viewerHtml, action, 'a viewer is not given the decision form')
    assert.match(viewerHtml, /Only a maintainer or a developer can decide what comes next\./, 'the card names the role the decision needs')

    const viewerZh = jobPage({ config, locale: 'zh', viewer, repo, job: row, events: [], viewerRole: 'viewer' })
    assert.doesNotMatch(viewerZh, action, 'the Chinese page draws no form for a viewer either')
    assert.match(viewerZh, /只有维护者或开发者可以决定下一步。/, 'and says in Chinese which role the decision needs')

    for (const role of ['maintainer', 'developer'] as const) {
      const html = jobPage({ config, locale: 'en', viewer, repo, job: row, events: [], viewerRole: role })
      assert.match(html, action, `a ${role} keeps the form the route accepts`)
      assert.doesNotMatch(html, /Only a maintainer or a developer can decide what comes next\./, `a ${role} is not told the decision is closed to them`)
    }
  } finally {
    store.close()
  }
})

// #1089: an in-page link is a promise that the target exists. The class, not
// the single link, is what has to hold: a fragment that no page defines lands
// the reader at the top of a long page with nothing marked.
function fragmentLinks(html: string): { path: string | null; fragment: string }[] {
  const found: { path: string | null; fragment: string }[] = []
  for (const match of html.matchAll(/href="(\/[^"#]*)?#([A-Za-z][A-Za-z0-9_-]*)"/g)) {
    const href = match[0]
    if (/href="\/\//.test(href)) continue // protocol-relative, i.e. off this site
    found.push({ path: match[1] === undefined ? null : match[1], fragment: match[2]! })
  }
  return found
}

test('every in-app fragment link lands on an element that exists', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'anchor-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_anchor', userId: user.id, owner: 'o', name: 'anchor', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const { cookie } = sessionFor(built, user)
    const pages = ['/console', '/dashboard', `/repos/${repo.id}`]
    const checked: string[] = []
    for (const url of pages) {
      const page = await built.app.inject({ method: 'GET', url, headers: { cookie } })
      assert.equal(page.statusCode, 200, `${url} renders`)
      const links = fragmentLinks(page.body)
      assert.ok(links.length > 0, `${url} carries in-page links, so the scan is not vacuous`)
      for (const link of links) {
        const target = link.path ?? url
        checked.push(`${url} -> ${target}#${link.fragment}`)
        const destination = await built.app.inject({ method: 'GET', url: target, headers: { cookie } })
        assert.equal(destination.statusCode, 200, `${url} -> ${target} renders`)
        assert.match(
          destination.body,
          new RegExp(`id="${link.fragment}"`),
          `${url} links ${target}#${link.fragment} and ${target} defines no id="${link.fragment}"`,
        )
      }
    }
    assert.ok(checked.length >= 4, `the scan covered ${checked.length} links: ${checked.join(', ')}`)
  } finally {
    await built.close()
  }
})

// #470: the daily card draws the four series it already receives as inline SVG —
// one `role="img"` per series, the same figure repeated as text — and a quiet
// window keeps the existing empty state instead of drawing a false zero line.
function sparkMetricsPage(input: {
  daily: Array<{ day: string; jobs: number; succeeded: number; failed: number; merged: number }>
  windowDays?: number
  locale?: 'en' | 'zh'
}): string {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'metrics-sparklines', status: 'approved', superadmin: true })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    return metricsPage({
      config,
      locale: input.locale ?? 'en',
      viewer,
      metrics: { users: 1, approved: 1, repos: 1, jobs: 7, succeeded: 6, failed: 1, usersWithJobs: 1, usersWithPr: 1, costUsd: 0.4, events: [{ name: 'job_enqueued', n: 2 }], firstMerge: { repositories: 1, samples: 1, medianMs: 86_400_000 }, readyWait: { samples: 1, medianMs: 3_600_000 } },
      team: { jobs: 1, avgRoles: 2, leadOnly: 0, roles: [{ role: 'lead', calls: 3, jobs: 1 }] },
      workItems: { total: 1, open: 0, merged: 1, closed: 0 },
      attribution: { unattributedCount: 0, unattributedUsd: 0, attributedUsd: 0.4 },
      stages: { scope: 0, verify: 0, iterate: 1, review: 1, leadOnly: 0, grounded: 1 },
      delivery: { jobs: 7, succeeded: 6, failed: 1, successRate: 86, prs: 3, merged: 3, mergeRate: 100, changesRequested: 0, reviewAverage: 82, reviewCount: 1, medianJobMs: 600_000, medianMergeMs: 3_600_000, medianReviewMs: 120_000 },
      daily: input.daily,
      repoCosts: [{ repoId: 'r1', label: 'o/r', costUsd: 0.4, calls: 3 }],
      modelCosts: [{ model: 'model-a', costUsd: 0.4, calls: 3 }],
      currency: { buckets: [{ currency: 'USD', amount: 0.4, requests: 3 }], unknownRequests: 0, semantics: 'exact' },
      alerts: [],
      windowDays: input.windowDays ?? 7,
      failures: [],
      since: '2026-01-01T00:00:00.000Z',
      automation: { idleWithWork: [], queueDepth: 0, activeJobs: 1, dispatchLatencyMs: 4_500, dispatchSamples: 3 },
    })
  } finally {
    store.close()
  }
}

function sparkTiles(page: string): Map<string, string> {
  const start = page.indexOf('<div class="spark-grid"')
  assert.ok(start !== -1, 'the daily card draws the sparkline grid')
  const grid = page.slice(start, page.indexOf('<div class="table-scroll">', start))
  const tiles = new Map<string, string>()
  for (const part of grid.split('<div class="spark" data-series="').slice(1)) {
    const key = part.slice(0, part.indexOf('"'))
    tiles.set(key, part.slice(0, part.indexOf('</p>') + '</p>'.length))
  }
  return tiles
}

test('the admin metrics daily card draws one labelled sparkline per series', () => {
  // Newest first, the order `Store.dailyMetrics` returns; the store-order case
  // below is the one that pins what that does to the drawing.
  const daily = [
    { day: '2026-01-03', jobs: 2, succeeded: 2, failed: 0, merged: 1 },
    { day: '2026-01-02', jobs: 4, succeeded: 3, failed: 1, merged: 2 },
    { day: '2026-01-01', jobs: 1, succeeded: 1, failed: 0, merged: 0 },
  ]
  const page = sparkMetricsPage({ daily })
  const tiles = sparkTiles(page)
  assert.deepEqual([...tiles.keys()], ['jobs', 'succeeded', 'failed', 'merged'], 'one tile per daily series, in the series order the table uses')
  const totals = { jobs: 7, succeeded: 6, failed: 1, merged: 3 }
  for (const [series, total] of Object.entries(totals)) {
    const tile = tiles.get(series) ?? ''
    // The graphic is one inline SVG with a role and a label, and it carries no
    // fixed width, so the card cannot overflow at 360.
    assert.match(tile, /<svg [^>]*role="img"[^>]*aria-label="[^"]+"/, `${series} has no labelled svg`)
    assert.match(tile, /viewBox="0 0 100 28"/, `${series} does not scale through a viewBox`)
    assert.doesNotMatch(tile, /\swidth=/, `${series} pins a width and would overflow at 360`)
    assert.match(tile, new RegExp(`class="spark-total">${String(total)}<`), `${series} does not repeat its figure as text`)
    const label = /aria-label="([^"]+)"/.exec(tile)?.[1] ?? ''
    assert.ok(label.includes(String(total)), `${series} aria-label does not carry the figure: ${label}`)
    assert.match(tile, /<polyline class="spark-path" points="/, `${series} draws no line`)
  }
  // The graphic sits above the table it summarises, inside the same card.
  assert.ok(page.indexOf('spark-grid') < page.indexOf('2026-01-03</td>'), 'the sparklines come after the table they summarise')
  // Nothing external and nothing executable: the SVG is the whole asset.
  const grid = page.slice(page.indexOf('<div class="spark-grid"'), page.indexOf('</svg>', page.indexOf('<div class="spark-grid"')))
  assert.doesNotMatch(grid, /<script|<link|<img/, 'the grid adds no script, stylesheet or bitmap')
})

test('a quiet daily window keeps the empty state and draws no zero line', () => {
  const page = sparkMetricsPage({ daily: [] })
  assert.doesNotMatch(page, /class="spark"/, 'an empty window draws a sparkline')
  assert.match(page, /No daily data yet\./, 'the existing empty state is gone')
})

test('a series with no activity in the window says so instead of drawing a line', () => {
  const page = sparkMetricsPage({ daily: [{ day: '2026-01-01', jobs: 2, succeeded: 2, failed: 0, merged: 0 }], windowDays: 30 })
  const merged = sparkTiles(page).get('merged') ?? ''
  assert.match(merged, /class="spark-line spark-quiet"/, 'an all-zero series still draws a trend line')
  assert.doesNotMatch(merged, /<polyline/, 'an all-zero series draws a line')
  const label = /aria-label="([^"]+)"/.exec(merged)?.[1] ?? ''
  assert.ok(label.includes('0'), `the quiet series does not say zero: ${label}`)
})

test('the sparkline labels follow the page language', () => {
  const daily = [{ day: '2026-01-01', jobs: 2, succeeded: 2, failed: 0, merged: 0 }]
  const zh = sparkMetricsPage({ daily, locale: 'zh' })
  const en = sparkMetricsPage({ daily, locale: 'en' })
  assert.match(zh, /每日任务|任务<\/span>/, 'no Chinese series name')
  assert.match(en, /Jobs<\/span>/, 'no English series name')
  assert.notEqual(zh, en)
})

// #1170: the reviewer caught the axis reversed. `Store.dailyMetrics` hands the
// window over newest-first (`ORDER BY day DESC` in src/db.ts), so the row the
// store returns first has to sit at the right edge. This case reads the rows
// from a real store instead of a hand-written ascending list, so the fixture
// cannot drift away from the query again.
test('the daily sparkline ends on the day the store returns first', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'metrics-spark-order', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_spark_order', userId: user.id, owner: 'o', name: 'spark-order', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const seed = (day: string, count: number): void => {
      for (let n = 0; n < count; n += 1) {
        const id = `job_spark_${day}_${String(n)}`
        makeTerminalJob(store, { id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb-${id}`, platformTokenHash: '', kind: 'iterate' })
        store.db.exec(`UPDATE jobs SET created_at = '${day}T09:00:00.000Z' WHERE id = '${id}'`)
      }
    }
    seed('2026-01-01', 1)
    seed('2026-01-02', 1)
    seed('2026-01-03', 10)
    const daily = store.dailyMetrics('2026-01-01T00:00:00.000Z', 7)
    assert.deepEqual(daily.map((row) => row.day), ['2026-01-03', '2026-01-02', '2026-01-01'], 'the store no longer returns newest-first; this case pins the order the page draws')
    const jobs = sparkTiles(sparkMetricsPage({ daily, windowDays: 7 })).get('jobs') ?? ''
    const drawn = (/points="([^"]+)"/.exec(jobs)?.[1] ?? '').split(' ').map((pair) => pair.split(',').map(Number))
    assert.equal(drawn.length, 3, `the chart does not draw one point per day: ${jobs}`)
    assert.equal(drawn[0]?.[0], 0, 'the oldest day is not the first point')
    assert.equal(drawn[2]?.[0], 100, 'the newest day is not the last point')
    assert.ok((drawn[2]?.[1] ?? 28) < (drawn[0]?.[1] ?? 0), `the newest day is not drawn as the peak: ${drawn.map((point) => point.join(',')).join(' ')}`)
    assert.match(jobs, /Peak 10 on 2026-01-03/, 'the caption no longer names the newest day as the peak')
  } finally {
    store.close()
  }
})
