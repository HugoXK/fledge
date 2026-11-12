import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { dashboardPage } from '../src/views/pages.js'
import { setupChecklist, type SetupState } from '../src/views/checklist.js'
import { translator } from '../src/i18n.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #227: the first run is a checklist whose state comes from the database, not
// from a cookie. The unit half below drives the pure state machine through the
// five setups a new account passes; the render half proves the dashboard shows
// one primary action at a time and that the checklist is replaced, not hidden,
// once the first job has produced a PR.

const en = translator('en')
const zh = translator('zh')

function state(patch: Partial<SetupState> = {}): SetupState {
  return {
    repos: 0,
    roleChosen: false,
    modelConfigured: false,
    instanceReady: false,
    jobs: 0,
    firstJobStatus: null,
    firstPrUrl: null,
    repoHref: null,
    ...patch,
  }
}

// The link assertions below compare whole anchor targets rather than searching
// the page for a URL: CodeQL rejects both an unanchored URL regex and a URL
// substring check on a page of text, and an equality against the parsed href is
// the stronger evidence anyway — it proves the link, not the presence of a
// string that could sit anywhere.
function anchorTargets(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '')
}

function linksTo(html: string, url: string): boolean {
  return anchorTargets(html).some((target) => target === url)
}

test('a brand-new account starts at step 1 and every later step names its blocker', () => {
  const checklist = setupChecklist(state(), en)
  assert.equal(checklist.steps.length, 5, 'five steps: repository, role, model, instance, first job')
  assert.equal(checklist.done, 0)
  assert.equal(checklist.total, 5)
  assert.equal(checklist.complete, false)
  assert.equal(checklist.next?.key, 'repo')
  assert.equal(checklist.next?.blocked, null, 'step 1 has no prerequisite')
  assert.equal(checklist.next?.action.href, '#add-repo')
  for (const step of checklist.steps.slice(1)) {
    assert.notEqual(step.blocked, null, `${step.key} names the step that blocks it`)
  }
  assert.deepEqual(checklist.steps.map((step) => step.key), ['repo', 'role', 'model', 'instance', 'job'])
})

test('the next step follows the data, and a completed step stops being the action', () => {
  const withRepo = setupChecklist(state({ repos: 1, repoHref: '/repos/r1' }), en)
  assert.equal(withRepo.next?.key, 'role')
  assert.equal(withRepo.done, 1)
  assert.equal(withRepo.next?.action.href, '/repos/r1', 'the role step links to the repository that needs it')
  assert.equal(withRepo.steps[0]?.done, true)
  assert.equal(withRepo.steps[0]?.action.href, '#add-repo')

  const withRole = setupChecklist(state({ repos: 1, roleChosen: true, repoHref: '/repos/r1' }), en)
  assert.equal(withRole.next?.key, 'model')
  assert.equal(withRole.next?.action.href, '/settings#model-providers')
  assert.equal(withRole.steps.find((step) => step.key === 'instance')?.blocked !== null, true)

  const withModel = setupChecklist(state({ repos: 1, roleChosen: true, modelConfigured: true, repoHref: '/repos/r1' }), en)
  assert.equal(withModel.next?.key, 'instance')

  const withInstance = setupChecklist(state({ repos: 1, roleChosen: true, modelConfigured: true, instanceReady: true, repoHref: '/repos/r1' }), en)
  assert.equal(withInstance.next?.key, 'job')
  assert.equal(withInstance.next?.blocked, null)
  assert.equal(withInstance.complete, false, 'the job is the step that finishes the run')
})

test('the checklist completes on the first job, not on the instance being ready', () => {
  const complete = setupChecklist(state({ repos: 2, roleChosen: true, modelConfigured: true, instanceReady: true, jobs: 1, firstJobStatus: 'succeeded' }), en)
  assert.equal(complete.done, 5)
  assert.equal(complete.complete, true)
  assert.equal(complete.next, undefined, 'a finished checklist has no next action')
})

test('every step is bilingual, and the step titles differ between the two locales', () => {
  const english = setupChecklist(state(), en)
  const chinese = setupChecklist(state(), zh)
  assert.equal(english.steps.length, chinese.steps.length)
  const titles = english.steps.map((step) => step.title)
  const chineseTitles = chinese.steps.map((step) => step.title)
  for (let index = 0; index < titles.length; index += 1) {
    assert.notEqual(titles[index], chineseTitles[index], `step ${index} has a zh title and an en title`)
    assert.ok((titles[index] ?? '').trim() !== '' && (chineseTitles[index] ?? '').trim() !== '')
  }
})

test('the dashboard renders one primary action and marks the current step', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'checklist-ui', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const setup = state({ repos: 1, repoHref: '/repos/r1' })
    const html = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [], setup })
    assert.match(html, /id="setup"/, 'the checklist has one section on the dashboard')
    assert.match(html, /data-setup-next="role"/, 'the section names the step the user is on')
    assert.equal((html.match(/data-setup-primary/g) ?? []).length, 1, 'exactly one primary action')
    assert.match(html, /aria-current="step"/, 'the current step is announced, not only coloured')
    assert.match(html, /1 of 5|1\/5/, 'the progress count is visible')
    assert.doesNotMatch(html, /data-first-pr/, 'no first-PR summary before the first job')
  } finally {
    store.close()
  }
})

test('after the first job the checklist is replaced by the first-PR summary', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'checklist-done', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const setup = state({ repos: 1, roleChosen: true, modelConfigured: true, instanceReady: true, jobs: 1, firstJobStatus: 'succeeded', firstPrUrl: 'https://github.com/o/r/pull/1' })
    const html = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [], setup })
    assert.match(html, /data-first-pr/, 'the finished run gets a summary instead of a checklist')
    assert.ok(linksTo(html, 'https://github.com/o/r/pull/1'), 'the summary links the first PR')
    assert.doesNotMatch(html, /id="setup"/, 'the checklist is gone, not merely collapsed')
  } finally {
    store.close()
  }
})

test('a missing model blocks the instance step with a reason, in both languages', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'checklist-blocked', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const setup = state({ repos: 1, roleChosen: true, repoHref: '/repos/r1' })
    const english = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [], setup })
    const chinese = dashboardPage({ config, locale: 'zh', viewer, repos: [], jobs: [], notifications: [], setup })
    assert.match(english, /Add a model first/, 'the blocked step says why it is blocked')
    assert.match(chinese, /先添加一个模型/, 'the same reason exists in Chinese')
    assert.match(english, /Settings/, 'the blocked step still links to the exact form')
  } finally {
    store.close()
  }
})

test('the route detects the step from rows, so a second browser or a cleared cookie sees the same one', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'checklist-route', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`

    const fresh = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(fresh.statusCode, 200)
    assert.match(fresh.body, /data-setup-next="repo"/, 'no rows yet: step 1 is the repository')

    store.createRepo({ id: 'repo_route', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: null, goal: '', autoIterate: false, intervalMinutes: 1440 })
    const withRepo = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.match(withRepo.body, /data-setup-next="role"/, 'a repository but no role: the role step is next')

    store.updateRepo('repo_route', { repo_role: 'developer' })
    const withRole = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.match(withRole.body, /data-setup-next="model"/, 'role chosen and no model: the model step is next')
    assert.match(withRole.body, /Open Settings → Model/, 'the next action points at the exact form')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a job that carries a PR replaces the checklist and the summary links it', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'checklist-pr', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`
    const repo = store.createRepo({ id: 'repo_pr', userId: user.id, owner: 'o', name: 'pr', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_pr', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    // The summary must read the oldest job that carries a PR, through the
    // store's index, not whichever page of jobs happens to be loaded.
    store.updateJob('job_pr', { pr_url: 'https://github.com/o/pr/pull/7', status: 'succeeded' })

    const response = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /data-first-pr/, 'a job with a PR ends the checklist')
    assert.ok(linksTo(response.body, 'https://github.com/o/pr/pull/7'), 'the summary links that PR')
    assert.doesNotMatch(response.body, /data-setup-next/, 'no checklist step remains once a PR exists')
  } finally {
    await built.app.close()
    store.close()
  }
})

// Finding 1 on #241: the first-run summary must read the *first job*, not a
// window-scoped success count. A success that fell out of the 7-day window used
// to render "Your first job did not succeed" and the retry path, while
// ?window=30 rendered "Your first job finished" for the same rows.
test('a first success older than the window still reads as a finished first run', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'checklist-old-success', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`
    const repo = store.createRepo({ id: 'repo_old', userId: user.id, owner: 'o', name: 'old', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_old', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString()
    store.runChanges('UPDATE jobs SET status = ?, created_at = ?, started_at = ?, finished_at = ? WHERE id = ?', 'succeeded', eightDaysAgo, eightDaysAgo, eightDaysAgo, 'job_old')

    const response = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Your first job finished/, 'an old success is still a finished first run')
    assert.doesNotMatch(response.body, /did not succeed/, 'the reporting window must not turn a success into a failure')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a first job that failed keeps the retry path to the repository', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'checklist-failed', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`
    const repo = store.createRepo({ id: 'repo_failed', userId: user.id, owner: 'o', name: 'failed', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_failed', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_failed', { status: 'failed', error: 'boom' })

    const response = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Your first job did not succeed/, 'a failed first run says so')
    assert.ok(linksTo(response.body, `/repos/${repo.id}`), 'and offers the repository as the retry path')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a first job that is still running is neither finished nor failed', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'checklist-running', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`
    const repo = store.createRepo({ id: 'repo_run', userId: user.id, owner: 'o', name: 'run', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_run', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_run', { status: 'running' })

    const response = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /Your first job is running/, 'a running first job is announced as running')
    assert.doesNotMatch(response.body, /did not succeed|Your first job finished/, 'and is not reported as either outcome')
  } finally {
    await built.app.close()
    store.close()
  }
})
