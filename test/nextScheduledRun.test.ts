import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type WorkItemRow } from '../src/db.js'
import { nextRun } from '../src/lib/nextRun.js'
import { humanTimeShort } from '../src/lib/time.js'
import { dashboardPage, repoPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

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
  const match = /<span data-next-run>([^<]*)<\/span>/.exec(html)
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
