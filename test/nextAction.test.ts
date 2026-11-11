import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store, type AlertView, type RepoRow, type UserRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { dashboardPage, type InboxQuestion } from '../src/views/pages.js'
import type { SetupState } from '../src/views/checklist.js'
import type { Locale } from '../src/i18n.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #230: the dashboard leads with one next action instead of a wall of equal
// cards. The next action is derived on the server from data the page already
// loads — open questions, alerts, the latest job, quota and the first-run
// state — so a browser with no JavaScript sees the same one, and there is no
// second source of truth to fall out of sync.

const config = testConfig()

interface PageInput {
  alerts?: AlertView[]
  questions?: InboxQuestion[]
  setup?: SetupState
  repos?: RepoRow[]
  jobs?: ReturnType<Store['listJobsPageForUser']>
}

const completeSetup: SetupState = {
  repos: 1,
  roleChosen: true,
  modelConfigured: true,
  instanceReady: true,
  jobs: 1,
  firstJobStatus: 'succeeded',
  firstPrUrl: null,
  repoHref: '/repos/repo_1',
}

// One store per render keeps each case independent; the seed callback builds
// the rows the route would have read, and the page then gets the same shape the
// route passes.
function render(locale: Locale, input: PageInput = {}, seed?: (store: Store, user: UserRow) => PageInput | void): string {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'next-action', status: 'approved' })
    const seeded = seed?.(store, user) ?? {}
    const merged: PageInput = { ...input, ...seeded }
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    return dashboardPage({
      config,
      locale,
      viewer,
      repos: merged.repos ?? store.listRepos(user.id),
      jobs: merged.jobs ?? [],
      notifications: [],
      alerts: merged.alerts ?? [],
      questions: merged.questions ?? [],
      ...(merged.setup === undefined ? {} : { setup: merged.setup }),
    })
  } finally {
    store.close()
  }
}

// The block is the only place the page makes one action primary, so every
// assertion below reads that element rather than the whole page.
function nextActionBlock(html: string): string {
  return html.match(/<section class="card" id="next-action"[\s\S]*?<\/section>/)?.[0] ?? ''
}

function targets(section: string): string[] {
  return [...section.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '')
}

const criticalAlert: AlertView = {
  kind: 'job_stalled',
  level: 'critical',
  repoId: 'repo_1',
  repoLabel: 'o/r',
  jobId: 'job_1',
  minutes: 45,
  message: 'job job_1 has no callback for 45m',
}

const stalePrAlert: AlertView = {
  kind: 'pr_stale',
  level: 'warning',
  repoId: 'repo_1',
  repoLabel: 'o/r',
  jobId: 'job_2',
  prUrl: 'https://github.com/o/r/pull/2',
  hours: 30,
  message: 'PR https://github.com/o/r/pull/2 has been open for 30h',
}

test('the dashboard leads with one next action, before the summary cards', () => {
  const html = render('en', { alerts: [criticalAlert, stalePrAlert] })
  const section = nextActionBlock(html)
  assert.match(section, /data-next-action="alert"/, 'the block names where its action came from')
  assert.match(section, /has not called back for 45 minutes/, 'the most urgent alert is the action')
  assert.equal((section.match(/<a class="btn/g) ?? []).length, 1, 'one primary action, not a list of them')
  assert.equal((section.match(/<p class="muted"/g) ?? []).length, 1, 'at most one supporting sentence')
  assert.deepEqual(targets(section), ['/repos/repo_1/jobs/job_1'], 'the action is the stalled job itself')
  assert.ok(html.indexOf('data-next-action') < html.indexOf('quota-card'), 'it is above the quota summary')
  assert.ok(html.indexOf('data-next-action') < html.indexOf('id="attention"'), 'it is above the full attention table')
  assert.ok(html.indexOf('data-next-action') < html.indexOf('id="jobs"'), 'it is above the job list')
})

test('every alert kind names its own next action and a link', () => {
  const cases: Array<{ alert: AlertView; href: string; text: RegExp }> = [
    { alert: criticalAlert, href: '/repos/repo_1/jobs/job_1', text: /has not called back/ },
    { alert: { ...criticalAlert, kind: 'job_slow', level: 'warning', minutes: 31 }, href: '/repos/repo_1/jobs/job_1', text: /31 minutes/ },
    { alert: stalePrAlert, href: 'https://github.com/o/r/pull/2', text: /open for 30 hours/ },
    { alert: { kind: 'credential_invalid', level: 'critical', repoId: 'repo_1', repoLabel: 'o/r', state: 'invalid', message: 'credential invalid' }, href: '/repos/repo_1', text: /credential state/ },
    { alert: { kind: 'budget_near_limit', level: 'warning', repoId: 'repo_1', repoLabel: 'o/r', spentCny: 9, budgetCny: 10, message: 'near limit' }, href: '/repos/repo_1', text: /30 days/ },
    // An alert with no repository, no job and no pull request still has to land
    // somewhere: the attention table that lists it.
    { alert: { kind: 'unclassified', level: 'info', message: 'something happened' }, href: '#attention', text: /something happened/ },
  ]
  for (const testCase of cases) {
    const section = nextActionBlock(render('en', { alerts: [testCase.alert] }))
    assert.match(section, testCase.text, `${testCase.alert.kind} says what happened`)
    assert.deepEqual(targets(section), [testCase.href], `${testCase.alert.kind} links to the place that fixes it`)
  }
})

test('an open question outranks an alert, because only the user can answer it', () => {
  const question: InboxQuestion = {
    id: 'q1',
    sessionId: 's1',
    repoId: 'repo_1',
    repoLabel: 'o/r',
    question: 'Which branch?',
    detail: '',
    options: ['main'],
    multiSelect: false,
  }
  const section = nextActionBlock(render('en', { questions: [question], alerts: [criticalAlert] }))
  assert.match(section, /data-next-action="questions"/)
  assert.match(section, /FlyBot is waiting on 1 answer/)
  assert.deepEqual(targets(section), ['#inbox'], 'the answer form is one tap away')
  assert.doesNotMatch(section, /45 minutes/, 'an alert does not displace a question only the user can answer')
})

test('the latest failed job is a next action with the job as its link', () => {
  const html = render('en', {}, (store, user) => {
    const repo = store.createRepo({ id: 'repo_1', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_9', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_9', { status: 'failed', error: 'bridge refused the run' })
    return { jobs: store.listJobsPageForUser(user.id, 10, 0) }
  })
  const section = nextActionBlock(html)
  assert.match(section, /data-next-action="job"/)
  assert.match(section, /job_9/)
  assert.deepEqual(targets(section), ['/repos/repo_1/jobs/job_9'])
})

test('the all-clear state names the next scheduled run and offers no competing button', () => {
  const html = render(
    'en',
    { setup: completeSetup },
    (store, user) => {
      const repo = store.createRepo({ id: 'repo_1', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: true, intervalMinutes: 60 })
      store.updateRepo(repo.id, { last_run_at: new Date(Date.now() - 30 * 60_000).toISOString() })
    },
  )
  const section = nextActionBlock(html)
  assert.match(section, /data-next-action="clear"/)
  assert.match(section, /Nothing needs you/)
  assert.match(section, /Next automatic run/, 'the all-clear state says when the platform runs again')
  assert.match(section, /o\/r/, 'and for which repository')
  assert.equal((section.match(/<a class="btn/g) ?? []).length, 0, 'a quiet state does not add a second primary action')
})

test('the all-clear state is honest when no repository auto-iterates', () => {
  const section = nextActionBlock(render('en', { setup: completeSetup }))
  assert.match(section, /data-next-action="clear"/)
  assert.match(section, /No repository runs automatically/, 'manual-only accounts are told so instead of an invented schedule')
})

test('an unfinished first run keeps exactly one primary action, in the next-action block', () => {
  const setup: SetupState = { repos: 1, roleChosen: false, modelConfigured: false, instanceReady: false, jobs: 0, firstJobStatus: null, firstPrUrl: null, repoHref: '/repos/repo_1' }
  const html = render('en', { setup })
  const section = nextActionBlock(html)
  assert.match(section, /data-next-action="setup"/)
  assert.match(section, /Choose your role/)
  assert.deepEqual(targets(section).filter((href) => href.startsWith('/repos/')), ['/repos/repo_1'])
  assert.equal((html.match(/data-setup-primary/g) ?? []).length, 1, 'the checklist step and the next action are the same button, not two')
  assert.ok(section.includes('data-setup-primary'), 'the one primary action lives in the next-action block')
  assert.match(html, /id="setup"/, 'the checklist stays, as the detail of that action')
  assert.match(html, /data-setup-next="role"/)
  assert.match(html, /aria-current="step"/)
})

test('secondary sections collapse into one disclosure and lose nothing', () => {
  const html = render('en', { setup: completeSetup })
  const disclosure = html.match(/<details[^>]*data-secondary[^>]*>/)?.[0] ?? ''
  assert.notEqual(disclosure, '', 'the secondary sections have one disclosure')
  assert.doesNotMatch(disclosure, /\bopen\b/, 'it starts collapsed so the first screen keeps one action')
  assert.ok(html.indexOf('data-secondary') > html.indexOf('data-next-action'), 'it sits below the next action')
  for (const marker of ['id="quota"', 'id="delivery"', 'id="jobs"', 'id="add-repo"']) {
    assert.ok(html.indexOf(marker) > html.indexOf('data-secondary'), `${marker} stays inside the disclosure`)
  }
  assert.match(html, /<table>/, 'the repository table is still rendered, only collapsed')
  assert.match(html, /Recent jobs/, 'the job section is still rendered')
})

test('the disclosure opens when the next action points inside it', () => {
  const setup: SetupState = { repos: 0, roleChosen: false, modelConfigured: false, instanceReady: false, jobs: 0, firstJobStatus: null, firstPrUrl: null, repoHref: null }
  const html = render('en', { setup })
  const section = nextActionBlock(html)
  assert.deepEqual(targets(section), ['#add-repo'], 'the first step is adding a repository')
  const disclosure = html.match(/<details[^>]*data-secondary[^>]*>/)?.[0] ?? ''
  assert.match(disclosure, /\bopen\b/, 'the form the action points at must be reachable in one tap, not hidden behind a second one')
})

test('the next action is bilingual', () => {
  const english = nextActionBlock(render('en', { alerts: [criticalAlert] }))
  const chinese = nextActionBlock(render('zh', { alerts: [criticalAlert] }))
  assert.match(chinese, /没有回调/, 'the alert is translated, not copied from the English string')
  assert.notEqual(english, chinese)
  const clearEn = nextActionBlock(render('en', { setup: completeSetup }))
  const clearZh = nextActionBlock(render('zh', { setup: completeSetup }))
  assert.match(clearZh, /没有需要你处理/, 'the all-clear state exists in Chinese too')
  assert.notEqual(clearEn, clearZh)
})

test('the route derives the next action from rows, not from the template alone', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'next-action-route', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`
    const repo = store.createRepo({ id: 'repo_live', userId: user.id, owner: 'o', name: 'live', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.updateRepo(repo.id, { credential_state: 'invalid' })
    const response = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(response.statusCode, 200)
    const section = nextActionBlock(response.body)
    assert.match(section, /data-next-action="alert"/, 'an invalid credential is the first thing the page says')
    assert.deepEqual(targets(section), [`/repos/${repo.id}`], 'and it links to the repository that needs re-authorizing')
  } finally {
    await built.app.close()
    store.close()
  }
})
