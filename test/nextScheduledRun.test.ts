import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store, type WorkItemRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { nextRun } from '../src/lib/nextRun.js'
import { nextRunFor } from '../src/lib/nextRunFor.js'
import { humanTimeShort } from '../src/lib/time.js'
import { nextTime } from '../src/schedules/next.js'
import { scheduleFromRow } from '../src/schedules/tick.js'
import { dashboardPage, repoPage } from '../src/views/pages.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// The worker is due after `max(15, min(interval, workCooldown))`, not after the
// discovery interval (#478). A default 1440-minute repository with open work is
// therefore due 15 minutes after its last run, and the console must say so.
const NOW = Date.now()
const INTERVAL_MINUTES = 1440
const COOLDOWN_MINUTES = 15
const LAST_RUN_AT = new Date(NOW - 20 * 60_000).toISOString()
// Ten minutes ago is inside the cooldown, so the run is still ahead.
const LAST_RUN_RECENT = new Date(NOW - 10 * 60_000).toISOString()

function workItem(repoId: string, userId: string, state = 'open'): WorkItemRow {
  const at = new Date(NOW).toISOString()
  return {
    id: 'wi_next_run',
    repo_id: repoId,
    user_id: userId,
    title: 'open work',
    detail: '',
    issue_url: null,
    pr_url: null,
    state,
    closed_reason: null,
    priority: 0,
    assignee_user_id: null,
    job_id: null,
    pr_state: null,
    merged_at: null,
    merge_commit: null,
    created_at: at,
    updated_at: at,
  }
}

function fixture(lastRunAt = LAST_RUN_AT) {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'next-run-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_next_run',
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: true,
    intervalMinutes: INTERVAL_MINUTES,
  })
  store.updateRepo(repo.id, { last_run_at: lastRunAt })
  const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
  return { config, store, user, viewer, repo: store.getRepo(repo.id)! }
}

function repoLine(html: string): string {
  // The element also carries `data-next-source` (#544): the page says whether the
  // line came from the legacy interval rule or from the schedule planner.
  const match = /<span data-next-run[^>]*>([^<]*)<\/span>/.exec(html)
  assert.ok(match, 'the repository page renders its next-run line in one element')
  return match[1]!
}

function dashboardLine(html: string): string {
  const match = /data-next-run="([^"]*)"/.exec(html)
  assert.ok(match, 'the dashboard next-action card carries the same next-run line')
  return match[1]!
}

function renderBoth(input: {
  repoEnabled: boolean
  activeJob: boolean
  openWork?: boolean
  instanceReady?: boolean
  lastRunAt?: string
}) {
  const { config, store, user, viewer, repo } = fixture(input.lastRunAt)
  if (!input.repoEnabled) store.updateRepo(repo.id, { enabled: 0 })
  const row = store.getRepo(repo.id)!
  const openWork = input.openWork ?? true
  const dashboard = dashboardPage({
    config,
    locale: 'en',
    viewer,
    repos: [],
    allRepos: [row],
    jobs: [],
    notifications: [],
    nextRunFacts: [{ repoId: row.id, openWork, activeJob: input.activeJob, instanceReady: input.instanceReady ?? true }],
  })
  const page = repoPage({
    config,
    locale: 'en',
    viewer,
    repo: row,
    jobs: [],
    workItems: openWork ? [workItem(row.id, user.id)] : [],
    activeJob: input.activeJob,
  })
  return { dashboard, page }
}

test('the shared next-run helper chooses the planner for a saved row', () => {
  const { store, repo } = fixture()
  try {
    const row = store.saveSchedule({ id: 'sch_for', repoId: repo.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    const schedule = scheduleFromRow(row)
    assert.ok(schedule !== null)
    const expected = nextTime(schedule, NOW)
    assert.ok(expected !== null)
    const next = nextRunFor({ repo, row, openWork: true, activeJob: false, instanceReady: true, workCooldownMinutes: COOLDOWN_MINUTES, now: NOW })
    assert.equal(next.state, 'scheduled')
    assert.equal(next.at, expected)
    store.updateRepo(repo.id, { enabled: 0 })
    const disabled = nextRunFor({ repo: store.getRepo(repo.id)!, row, openWork: true, activeJob: false, instanceReady: true, workCooldownMinutes: COOLDOWN_MINUTES, now: NOW })
    assert.equal(disabled.state, 'disabled', 'enabled answers before the saved row, exactly as the worker does')
    assert.equal(disabled.at, null)
    store.updateRepo(repo.id, { enabled: 1 })

    const unreadable = store.saveSchedule({ id: 'sch_for_bad', repoId: repo.id, kind: 'cron', expression: null, timezone: 'Asia/Shanghai' })
    assert.deepEqual(
      nextRunFor({ repo: store.getRepo(repo.id)!, row: unreadable, openWork: true, activeJob: false, instanceReady: true, workCooldownMinutes: COOLDOWN_MINUTES, now: NOW }),
      { at: null, state: 'unknown-unreadable' },
    )
    const closed = store.saveSchedule({ id: 'sch_for_closed', repoId: repo.id, kind: 'interval', everyMs: 60_000, endAt: NOW - 1 })
    assert.deepEqual(
      nextRunFor({ repo: store.getRepo(repo.id)!, row: closed, openWork: true, activeJob: false, instanceReady: true, workCooldownMinutes: COOLDOWN_MINUTES, now: NOW }),
      { at: null, state: 'unknown-closed' },
    )
  } finally {
    store.close()
  }
})

test('the shared next-run helper keeps every interval state the page prints', () => {
  const cases: Array<{ label: string; patch: { enabled?: number; autoIterate?: boolean; lastRunAt?: string | null; openWork?: boolean; activeJob?: boolean; instanceReady?: boolean }; state: string }> = [
    { label: 'disabled', patch: { enabled: 0 }, state: 'disabled' },
    { label: 'not-ready', patch: { instanceReady: false }, state: 'not-ready' },
    { label: 'auto-off', patch: { autoIterate: false }, state: 'auto-off' },
    { label: 'active-job', patch: { activeJob: true }, state: 'active-job' },
    { label: 'idle', patch: { openWork: false }, state: 'idle' },
    { label: 'waiting-first-run', patch: { lastRunAt: null }, state: 'waiting-first-run' },
    { label: 'due', patch: { lastRunAt: new Date(NOW - 60 * 60_000).toISOString() }, state: 'due' },
    { label: 'scheduled', patch: { lastRunAt: LAST_RUN_RECENT }, state: 'scheduled' },
  ]
  for (const testCase of cases) {
    const { store, repo } = fixture()
    try {
      store.updateRepo(repo.id, {
        enabled: testCase.patch.enabled ?? 1,
        auto_iterate: testCase.patch.autoIterate === false ? 0 : 1,
        ...(testCase.patch.lastRunAt === undefined ? {} : { last_run_at: testCase.patch.lastRunAt }),
      })
      const next = nextRunFor({
        repo: store.getRepo(repo.id)!,
        row: undefined,
        openWork: testCase.patch.openWork ?? true,
        activeJob: testCase.patch.activeJob ?? false,
        instanceReady: testCase.patch.instanceReady ?? true,
        workCooldownMinutes: COOLDOWN_MINUTES,
        now: NOW,
      })
      assert.equal(next.state, testCase.state, `${testCase.label} keeps the page's state`)
    } finally {
      store.close()
    }
  }
})

test('the cooldown the worker uses decides the next run, not the discovery interval', () => {
  const next = nextRun({
    lastRunAt: LAST_RUN_AT,
    intervalMinutes: INTERVAL_MINUTES,
    workCooldownMinutes: COOLDOWN_MINUTES,
    autoIterate: true,
    hasOpenWork: true,
    hasActiveJob: false,
    repoEnabled: true,
    instanceReady: true,
    now: NOW,
  })
  // The last run is 20 minutes old, so the cooldown has already elapsed: the
  // worker would run it now, and the console says so instead of naming a time
  // 23h45m away.
  assert.equal(next.state, 'due')
  assert.equal(next.at, Date.parse(LAST_RUN_AT) + COOLDOWN_MINUTES * 60_000)
  assert.notEqual(next.at, Date.parse(LAST_RUN_AT) + INTERVAL_MINUTES * 60_000)
})

test('the dashboard card and the repository page print the same next-run line', () => {
  const { dashboard, page } = renderBoth({ repoEnabled: true, activeJob: false, lastRunAt: LAST_RUN_RECENT })
  const line = repoLine(page)
  assert.equal(line, humanTimeShort(new Date(Date.parse(LAST_RUN_RECENT) + COOLDOWN_MINUTES * 60_000).toISOString()))
  assert.equal(dashboardLine(dashboard), line)
  // The broken formula would print the discovery interval here.
  assert.notEqual(line, humanTimeShort(new Date(Date.parse(LAST_RUN_RECENT) + INTERVAL_MINUTES * 60_000).toISOString()))
})

test('a disabled repository says so on both surfaces instead of a happy time', () => {
  const { dashboard, page } = renderBoth({ repoEnabled: false, activeJob: false })
  const line = repoLine(page)
  assert.equal(line, 'Repository disabled; no automatic run starts')
  assert.equal(dashboardLine(dashboard), line)
})

test('a running job says it is after the active job on both surfaces', () => {
  const { dashboard, page } = renderBoth({ repoEnabled: true, activeJob: true })
  const line = repoLine(page)
  assert.equal(line, 'After the active job finishes')
  assert.equal(dashboardLine(dashboard), line)
})

test('no open work reads as idle on both surfaces', () => {
  const { dashboard, page } = renderBoth({ repoEnabled: true, activeJob: false, openWork: false })
  const line = repoLine(page)
  assert.match(line, /Idle: no open work/)
  assert.equal(dashboardLine(dashboard), line)
})

// #688: a repository that has saved a schedule row is answered by the planner on
// both surfaces. The dashboard card mapped every `auto_iterate` repository
// through the legacy interval rule and never read the row, so a repository
// scheduled `0 9 * * 1-5` in `Asia/Shanghai`, with a 1440-minute interval and its
// last run ten minutes ago, was promised a run within minutes while the
// repository page named the next weekday morning. One repository therefore had
// two next-run answers. The card takes the planner's instant when the row exists;
// the interval rule is left to the repositories that never opted in (#544).
test('the dashboard answers with the schedule row, not the interval, when one exists', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'next-run-scheduled', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`
    const repo = store.createRepo({
      id: 'repo_scheduled',
      userId: user.id,
      owner: 'acme',
      name: 'demo',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: true,
      intervalMinutes: INTERVAL_MINUTES,
    })
    const lastRunAt = new Date(Date.now() - 10 * 60_000).toISOString()
    store.updateRepo(repo.id, { last_run_at: lastRunAt })
    store.createWorkItem({ id: 'wi_scheduled', repoId: repo.id, userId: user.id, title: 'open work', detail: '' })
    // The all-clear card is reached only with a complete first run, so the
    // fixture carries the same rows a real account would: an instance, a model
    // and one succeeded job. None of them decides the next-run answer.
    const at = new Date().toISOString()
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/scheduled', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: 2, model_port: 3, model_bind: '127.0.0.1', image: 'image', status: 'ready',
      chief_session: 'c', team_json: null, bridge_token_enc: null, bridge_pid: null, log_pid: null,
      last_error: null, created_at: at, updated_at: at, last_health_at: null,
    })
    store.createModelProvider({ id: 'prov_scheduled', userId: user.id, label: 'p', baseUrl: 'https://example.test', keyEnc: 'x', allowPrivate: false })
    store.createProviderModel({ id: 'pm_scheduled', providerId: 'prov_scheduled', model: 'm', label: 'm' })
    store.setRepoModelSelection(repo.id, ['pm_scheduled'], 'pm_scheduled')
    store.createJob({ id: 'job_scheduled', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_scheduled', { status: 'succeeded' })
    const row = store.saveSchedule({ id: 'sch_scheduled', repoId: repo.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })

    const dashboard = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(dashboard.statusCode, 200)
    assert.equal(page.statusCode, 200)
    const section = /<section class="card" id="next-action"[\s\S]*?<\/section>/.exec(dashboard.body)?.[0] ?? ''
    assert.match(section, /data-next-action="clear"/, 'the fixture reaches the all-clear card, where the next run is named')

    const schedule = scheduleFromRow(row)
    assert.ok(schedule !== null, 'the schedule row parses')
    const expected = humanTimeShort(new Date(nextTime(schedule, Date.now())!).toISOString())
    assert.equal(repoLine(page.body), expected, 'the repository page answers from the schedule row')
    assert.equal(dashboardLine(dashboard.body), expected, 'the dashboard card answers with the same instant')
    const intervalAnswer = humanTimeShort(new Date(Date.parse(lastRunAt) + COOLDOWN_MINUTES * 60_000).toISOString())
    assert.notEqual(dashboardLine(dashboard.body), intervalAnswer, 'the interval rule must not answer for a repository that has a schedule row')
    assert.notEqual(expected, intervalAnswer, 'the fixture separates the two answers, or the assertion above proves nothing')
  } finally {
    await built.app.close()
    store.close()
  }
})

// #723: the worker only ever considers an enabled repository (`listAutoRepos` is
// `WHERE enabled = 1 AND auto_iterate = 1`) and a manual start on a paused one is
// refused with REPO_DISABLED, so no surface may name a run for it. These cases
// cover the two surfaces the card measured.
function seedAllClear(store: Store, user: ReturnType<typeof makeUser>, repoId: string): void {
  const at = new Date().toISOString()
  store.saveRepoInstance({
    repo_id: repoId, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/disabled', bridge_script: '/tmp/bridge',
    dsh_port: 1, bridge_port: 2, model_port: 3, model_bind: '127.0.0.1', image: 'image', status: 'ready',
    chief_session: 'c', team_json: null, bridge_token_enc: null, bridge_pid: null, log_pid: null,
    last_error: null, created_at: at, updated_at: at, last_health_at: null,
  })
  store.createModelProvider({ id: `prov_${repoId}`, userId: user.id, label: 'p', baseUrl: 'https://example.test', keyEnc: 'x', allowPrivate: false })
  store.createProviderModel({ id: `pm_${repoId}`, providerId: `prov_${repoId}`, model: 'm', label: 'm' })
  // #732: a provider row is not an own model until a repository selects it, and
  // this deployment configures no platform model, so the selection is what makes
  // the first-run check complete.
  store.setRepoModelSelection(repoId, [`pm_${repoId}`], `pm_${repoId}`)
  store.createJob({ id: `job_${repoId}`, repoId, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: `cb_${repoId}`, platformTokenHash: '' })
  store.updateJob(`job_${repoId}`, { status: 'succeeded' })
}

function nextRunRepo(store: Store, user: ReturnType<typeof makeUser>, id: string, name: string) {
  return store.createRepo({
    id, userId: user.id, owner: 'acme', name, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: '', autoIterate: true, intervalMinutes: INTERVAL_MINUTES,
  })
}

test('a disabled repository with a schedule row says so on the page, not a planner instant', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'next-run-disabled-page', status: 'approved' })
    const session = sessionFor(built, user)
    const repo = nextRunRepo(store, user, 'repo_disabled_row', 'paused')
    store.updateRepo(repo.id, { last_run_at: LAST_RUN_RECENT })
    store.createWorkItem({ id: 'wi_disabled_row', repoId: repo.id, userId: user.id, title: 'open work', detail: '' })
    store.saveSchedule({ id: 'sch_disabled_row', repoId: repo.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    store.updateRepo(repo.id, { enabled: 0 })

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    assert.equal(repoLine(page.body), '仓库已停用，自动运行不会开始', 'a paused repository is not given a next run')
    const source = /data-next-source="([^"]*)"/.exec(page.body)?.[1]
    assert.equal(source, 'interval', 'the line is not tagged as the planner answering for a paused repository')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('the dashboard never names a paused repository while an enabled one has a next run', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'next-run-disabled-dash', status: 'approved' })
    const session = sessionFor(built, user)
    const paused = nextRunRepo(store, user, 'repo_dash_paused', 'paused')
    const enabled = nextRunRepo(store, user, 'repo_dash_enabled', 'enabled')
    seedAllClear(store, user, enabled.id)
    // The paused repository's cron is earlier, so before the fix it is both
    // runnable and the earliest candidate, and the card names it.
    store.saveSchedule({ id: 'sch_dash_paused', repoId: paused.id, kind: 'cron', expression: '0 * * * *', timezone: 'Asia/Shanghai' })
    store.saveSchedule({ id: 'sch_dash_enabled', repoId: enabled.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    store.updateRepo(paused.id, { enabled: 0 })

    const dashboard = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: session.cookie } })
    assert.equal(dashboard.statusCode, 200)
    const section = /<section class="card" id="next-action"[\s\S]*?<\/section>/.exec(dashboard.body)?.[0] ?? ''
    assert.match(section, /data-next-action="clear"/, 'the fixture reaches the all-clear card, where the next run is named')
    assert.match(section, /下次自动运行：acme\/enabled/, 'the enabled repository is the next automatic run')
    assert.doesNotMatch(section, /acme\/paused/, 'a paused repository is never named as the next automatic run')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('with only paused repositories the dashboard says runs are paused and names no instant', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'next-run-disabled-only', status: 'approved' })
    const session = sessionFor(built, user)
    const paused = nextRunRepo(store, user, 'repo_dash_only_paused', 'paused')
    seedAllClear(store, user, paused.id)
    store.saveSchedule({ id: 'sch_dash_only_paused', repoId: paused.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    store.updateRepo(paused.id, { enabled: 0 })

    const dashboard = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: session.cookie } })
    assert.equal(dashboard.statusCode, 200)
    const section = /<section class="card" id="next-action"[\s\S]*?<\/section>/.exec(dashboard.body)?.[0] ?? ''
    assert.match(section, /data-next-action="clear"/, 'the fixture reaches the all-clear card')
    assert.match(section, /自动运行暂停：acme\/paused · 仓库已停用，自动运行不会开始/, 'the card says why nothing runs')
    assert.doesNotMatch(section, /\d{2}:\d{2}/, 'no instant is printed for a paused repository')
  } finally {
    await built.app.close()
    store.close()
  }
})
