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
    providerConfigured: false,
    modelConfigured: false,
    platformAvailable: false,
    platformQuotaRemainingCny: 0,
    platformQuotaUnlimited: false,
    platformQuotaComfortCny: 50,
    instanceReady: false,
    instancesUsed: true,
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
  for (const step of checklist.steps.filter((entry) => entry.key !== 'model').slice(1)) {
    assert.notEqual(step.blocked, null, `${step.key} names the step that blocks it`)
  }
  assert.equal(checklist.steps.find((step) => step.key === 'model')?.blocked, null, 'adding a model does not depend on the role')
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

test('a provider without a repository selection is not a completed model step', () => {
  const providerOnly = setupChecklist(state({ repos: 1, roleChosen: true, providerConfigured: true, modelConfigured: false, repoHref: '/repos/r1' }), en)
  assert.equal(providerOnly.next?.key, 'model')
  assert.equal(providerOnly.next?.title, 'Choose a model for the repository')
  assert.equal(providerOnly.next?.action.href, '/repos/r1', 'the add form is not the next step once a provider exists')
  assert.equal(providerOnly.steps.find((step) => step.key === 'instance')?.blocked, 'Choose a model for the repository first.')

  const selected = setupChecklist(state({ repos: 1, roleChosen: true, providerConfigured: true, modelConfigured: true, repoHref: '/repos/r1' }), en)
  assert.equal(selected.next?.key, 'instance', 'a repository selection is the own model the gateway and bridge use')
  assert.equal(selected.steps.find((step) => step.key === 'model')?.done, true)
  assert.equal(selected.steps.find((step) => step.key === 'instance')?.blocked, null)
})

test('platform quota satisfies the model step and skips its NEXT ACTION', () => {
  const withRole = setupChecklist(state({ repos: 1, roleChosen: true, platformAvailable: true, platformQuotaRemainingCny: 50, repoHref: '/repos/r1' }), en)
  assert.equal(withRole.next?.key, 'instance', 'the missing own model must not be the next action while platform quota is available')
  const model = withRole.steps.find((step) => step.key === 'model')
  assert.ok(model !== undefined)
  assert.equal(model.done, true)
  assert.equal(model.optional, true)
  assert.equal(model.note, 'Using platform quota (default) · ¥50.00 left')
  assert.equal(model.warning, undefined, 'a comfortable balance does not warn')
  assert.equal(model.action.label, 'Configure later in Settings → Model')
  assert.equal(model.blocked, null)
  assert.equal(withRole.steps.find((step) => step.key === 'instance')?.blocked, null)

  const unlimited = setupChecklist(state({ repos: 1, roleChosen: true, platformAvailable: true, platformQuotaUnlimited: true, repoHref: '/repos/r1' }), en)
  const unlimitedModel = unlimited.steps.find((step) => step.key === 'model')
  assert.equal(unlimitedModel?.note, 'Using platform quota (unlimited)')
  assert.equal(unlimitedModel?.warning, undefined)
  assert.equal(unlimitedModel?.action.label, 'Configure later in Settings → Model')

  const complete = setupChecklist(state({ repos: 1, roleChosen: true, platformAvailable: true, instanceReady: true, jobs: 1, firstJobStatus: 'succeeded', repoHref: '/repos/r1' }), en)
  assert.equal(complete.done, 5)
  assert.equal(complete.complete, true)
})

test('the quota comfort threshold defaults to 50 and reads the env override', () => {
  assert.equal(testConfig().quota.comfortCny, 50)
  assert.equal(testConfig({ quota: { initialCny: 1, usdCny: 7.2, comfortCny: 123 } }).quota.comfortCny, 123)
})

test('a low platform balance recommends an own model when the model step is skipped', () => {
  const low = setupChecklist(state({ repos: 1, roleChosen: true, platformAvailable: true, platformQuotaRemainingCny: 1, repoHref: '/repos/r1' }), en)
  const model = low.steps.find((step) => step.key === 'model')
  assert.match(model?.note ?? '', /¥1\.00/)
  assert.match(model?.warning ?? '', /may not cover the first run/)
  assert.match(model?.warning ?? '', /Settings → Model/)
  assert.equal(model?.action.label, 'Add your own model now')
  assert.equal(model?.optional, true)

  const providerLow = setupChecklist(state({ repos: 1, roleChosen: true, providerConfigured: true, platformAvailable: true, platformQuotaRemainingCny: 1, repoHref: '/repos/r1' }), en)
  const providerModel = providerLow.steps.find((step) => step.key === 'model')
  assert.equal(providerModel?.action.href, '/repos/r1')
  assert.equal(providerModel?.action.label, 'Choose a repository model now')
  assert.match(providerModel?.warning ?? '', /Choose a model for the repository now/)
})

test('the quota comfort threshold comes from config, not a second constant', () => {
  const strict = setupChecklist(state({ repos: 1, roleChosen: true, platformAvailable: true, platformQuotaRemainingCny: 50, platformQuotaComfortCny: 100, repoHref: '/repos/r1' }), en)
  assert.notEqual(strict.steps.find((step) => step.key === 'model')?.warning, undefined, 'a 100 CNY threshold warns at 50 CNY')
  const relaxed = setupChecklist(state({ repos: 1, roleChosen: true, platformAvailable: true, platformQuotaRemainingCny: 50, platformQuotaComfortCny: 50, repoHref: '/repos/r1' }), en)
  assert.equal(relaxed.steps.find((step) => step.key === 'model')?.warning, undefined, 'a 50 CNY threshold is comfortable at 50 CNY')
})

test('the dashboard shows platform quota instead of a model requirement when the platform can fund the run', async () => {
  const config = testConfig()
  config.flybot.instanceImage = 'ghcr.io/example/flybot:latest'
  config.llm.baseUrl = 'https://platform.example/v1'
  config.llm.key = 'platform-key'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'platform-quota', status: 'approved' })
    const session = sessionFor(built, user)
    store.createRepo({ id: 'repo_platform', userId: user.id, owner: 'o', name: 'platform', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const page = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-setup-next="instance"/)
    assert.match(page.body, /Using platform quota/)
    assert.match(page.body, /Add your own model/)
    assert.match(page.body, /Only ¥1\.00 of platform quota is left/)
    assert.match(page.body, /may not cover the first run/)
    assert.match(page.body, /setup-warning/)
    const nextAction = page.body.match(/<section class="card(?: [a-z-]+)?" id="next-action"[\s\S]*?<\/section>/)?.[0] ?? ''
    assert.match(nextAction, /Start workspace/, 'the platform-funded run does not stop at the model step')
    assert.doesNotMatch(nextAction, /Add a model provider/, 'the optional model step is not the primary action')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a deployment without workspaces does not ask for one', async () => {
  const config = testConfig()
  config.llm.baseUrl = 'https://platform.example/v1'
  config.llm.key = 'platform-key'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'no-workspaces', status: 'approved' })
    const session = sessionFor(built, user)
    store.createRepo({ id: 'repo_no_ws', userId: user.id, owner: 'o', name: 'no-ws', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const page = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-setup-next="job"/, 'an empty FLYBOT_INSTANCE_IMAGE makes the first job the next step')
    assert.match(page.body, /<li class="setup-step is-done[^"]*" data-setup-step="instance"/, 'the workspace step is done when the deployment has none')
    assert.doesNotMatch(page.body, /Start the instance first|Start the workspace first/, 'the first job is not blocked on a workspace this deployment cannot start')
    const chinese = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${session.cookie}; fledge_lang=zh` } })
    assert.doesNotMatch(chinese.body, /先启动实例|先启动工作区/, 'the zh render asks for no workspace either')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a deployment with workspaces still blocks the first job on a stopped workspace', async () => {
  const config = testConfig()
  config.flybot.instanceImage = 'ghcr.io/example/flybot:latest'
  config.llm.baseUrl = 'https://platform.example/v1'
  config.llm.key = 'platform-key'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'with-workspaces', status: 'approved' })
    const session = sessionFor(built, user)
    store.createRepo({ id: 'repo_ws', userId: user.id, owner: 'o', name: 'ws', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const page = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-setup-next="instance"/, 'a deployment with workspaces still asks for one')
    const instanceStep = page.body.match(/<li[^>]*data-setup-step="instance"[\s\S]*?<\/li>/)?.[0] ?? ''
    assert.ok(instanceStep !== '', 'the workspace step renders')
    assert.doesNotMatch(instanceStep, /is-done/, 'no ready workspace: the step stays unmet')
    const jobStep = page.body.match(/<li[^>]*data-setup-step="job"[\s\S]*?<\/li>/)?.[0] ?? ''
    assert.match(jobStep, /setup-blocked/, 'the first job is still blocked')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('the first-job blocker names the workspace, not the instance', async () => {
  const config = testConfig()
  config.flybot.instanceImage = 'ghcr.io/example/flybot:latest'
  config.llm.baseUrl = 'https://platform.example/v1'
  config.llm.key = 'platform-key'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'blocker-wording', status: 'approved' })
    const session = sessionFor(built, user)
    store.createRepo({ id: 'repo_wording', userId: user.id, owner: 'o', name: 'wording', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const page = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    const jobStep = page.body.match(/<li[^>]*data-setup-step="job"[\s\S]*?<\/li>/)?.[0] ?? ''
    assert.match(jobStep, /Start the workspace first/, 'the blocker names the workspace')
    assert.doesNotMatch(jobStep, /Start the instance first/, 'the blocker no longer names the instance')
    const chinese = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${session.cookie}; fledge_lang=zh` } })
    const zhJobStep = chinese.body.match(/<li[^>]*data-setup-step="job"[\s\S]*?<\/li>/)?.[0] ?? ''
    assert.match(zhJobStep, /先启动工作区/, 'the zh blocker names the workspace')
    assert.doesNotMatch(zhJobStep, /先启动实例/, 'the zh blocker no longer names the instance')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('a comfortable platform balance only names the remaining quota', async () => {
  const config = testConfig()
  config.llm.baseUrl = 'https://platform.example/v1'
  config.llm.key = 'platform-key'
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'platform-quota-50', status: 'approved', quota: 50 })
    const session = sessionFor(built, user)
    store.createRepo({ id: 'repo_platform_50', userId: user.id, owner: 'o', name: 'platform-50', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const page = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Using platform quota \(default\) · ¥50\.00 left/)
    assert.match(page.body, /Configure later in Settings → Model/)
    assert.doesNotMatch(page.body, /may not cover the first run/)
    assert.doesNotMatch(page.body, /setup-warning/)
  } finally {
    await built.app.close()
    store.close()
  }
})

test('the dashboard uses the configured comfort threshold', async () => {
  const config = testConfig()
  config.llm.baseUrl = 'https://platform.example/v1'
  config.llm.key = 'platform-key'
  config.quota.comfortCny = 100
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'platform-quota-configured', status: 'approved', quota: 50 })
    const session = sessionFor(built, user)
    store.createRepo({ id: 'repo_platform_configured', userId: user.id, owner: 'o', name: 'platform-configured', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const page = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Only ¥50\.00 of platform quota is left/, 'the route passes config.quota.comfortCny to the checklist')
    assert.match(page.body, /may not cover the first run/)
  } finally {
    await built.app.close()
    store.close()
  }
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

    const provider = store.createModelProvider({ id: 'prv_route', userId: user.id, label: 'Own', baseUrl: 'https://own.example/v1', keyEnc: 'x', allowPrivate: false })
    const model = store.createProviderModel({ id: 'pvm_route', providerId: provider.id, model: 'own-model', label: 'Own model' })
    const withProvider = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.match(withProvider.body, /data-setup-next="model"/, 'a provider alone is not a repository model')
    assert.match(withProvider.body, /Choose a model for the repository/, 'the next action is the repository picker')
    assert.match(withProvider.body, /href="\/repos\/repo_route"/, 'and it links to the repository')

    store.setRepoModelSelection('repo_route', [model.id], model.id)
    const withSelection = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.match(withSelection.body, /data-setup-next="job"/, 'a selected repository model completes the model step; with no workspaces the first job is next')
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

// #734: the table filter is table state. A filter that matches no job must not
// make an account with a finished first run look new again.
test('a job-table filter does not rewrite the first-run state', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'checklist-filtered', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`
    const repo = store.createRepo({ id: 'repo_filtered', userId: user.id, owner: 'o', name: 'filtered', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_filtered', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_filtered', { status: 'succeeded' })

    const clean = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.match(clean.body, /data-first-pr/, 'the first job gives the account its first-run summary')

    const filtered = await built.app.inject({ method: 'GET', url: '/dashboard?status=queued', headers: { cookie } })
    assert.equal(filtered.statusCode, 200)
    assert.match(filtered.body, /data-first-pr/, 'a filter that matches no job does not bring the checklist back')
    assert.match(filtered.body, /Your first job finished/, 'the first-run outcome still reads the first job')
    assert.doesNotMatch(filtered.body, /data-setup-next=/, 'the checklist is not rendered again')
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
