import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { dashboardPage } from '../src/views/pages.js'
import { humanTime, humanTimeShort } from '../src/lib/time.js'
import { makeUser, testConfig } from './helpers.js'

// One helper renders every console timestamp, and 39 lines of
// `src/views/pages.ts` call it. It printed the UTC wall clock with no zone, so
// a reader in Asia/Shanghai saw 09:33 where their own clock said 17:33 and
// nothing on the page said which clock was meant. The console names
// `Asia/Shanghai` for the digest on the very next screen, so the unlabelled
// value is not a neutral default: it contradicts a labelled one.
//
// These cases pin the label on the helper and on a rendered cell. The render
// case compares the cell with the helper for the same instant, so a second
// formatter added later cannot drift from it unnoticed.

const UTC_INSTANT = '2026-11-12T09:33:16.000Z'
const UTC_RENDERED = '2026-11-12 09:33:16 UTC'

test('humanTimeShort labels a console timestamp as UTC', () => {
  assert.equal(humanTimeShort(UTC_INSTANT), UTC_RENDERED)
})

test('the label names the UTC instant, not the reader zone, so the hour does not move', () => {
  // The same instant written with an offset: the displayed wall clock is UTC,
  // and the label says so. A "fix" that rendered the local zone would fail
  // here, which is the point — this card labels the current output, it does
  // not change which zone it shows.
  assert.equal(humanTimeShort('2026-11-12T17:33:16+08:00'), UTC_RENDERED)
  assert.equal(humanTimeShort('2026-11-12T09:33:16Z'), UTC_RENDERED)
})

test('a missing or unparseable timestamp still renders as the em dash', () => {
  for (const value of [null, undefined, '', 'not-a-date']) {
    assert.equal(humanTimeShort(value), '—', `${String(value)} must stay an em dash`)
  }
})

test('a repository with no last run keeps the em dash, not a labelled empty value', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'time-empty', status: 'approved' })
    const repo = createRepo(store, user.id, 'repo_time_empty')
    const html = dashboardPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repos: [store.getRepo(repo.id)!],
      jobs: [],
      notifications: [],
    })
    assert.equal(lastRunCell(html, 'repo_time_empty'), '—')
  } finally {
    store.close()
  }
})

test('the dashboard Last run cell carries the zone label', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'time-dashboard', status: 'approved' })
    const repo = createRepo(store, user.id, 'repo_time')
    store.updateRepo(repo.id, { last_run_at: UTC_INSTANT })

    const html = dashboardPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repos: [store.getRepo(repo.id)!],
      jobs: [],
      notifications: [],
    })

    const cell = lastRunCell(html, 'repo_time')
    assert.equal(cell, UTC_RENDERED, `the Last run cell must state the zone, got: ${cell}`)
    // Relationship, not a second copy of the literal: whatever the helper
    // prints for this instant is what the cell shows.
    assert.equal(cell, humanTimeShort(store.getRepo(repo.id)!.last_run_at), 'the rendered cell drifted from the shared helper')
  } finally {
    store.close()
  }
})

test('the Chinese console labels the zone too, with the same UTC wall clock', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'time-dashboard-zh', status: 'approved' })
    const repo = createRepo(store, user.id, 'repo_time_zh')
    store.updateRepo(repo.id, { last_run_at: UTC_INSTANT })

    const zh = dashboardPage({
      config: testConfig(),
      locale: 'zh',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repos: [store.getRepo(repo.id)!],
      jobs: [],
      notifications: [],
    })
    const cell = zhLastRunCell(zh)
    assert.equal(cell, UTC_RENDERED, `the Chinese Last run cell must state the zone, got: ${cell}`)
  } finally {
    store.close()
  }
})

test('humanTime keeps its ISO form, so the two helpers stay distinguishable', () => {
  // humanTime has no call site today; pinning it keeps a later edit from
  // collapsing the two formats into one while the console label is added.
  assert.equal(humanTime(UTC_INSTANT), '2026-11-12 09:33:16Z')
})

function createRepo(store: Store, userId: string, id: string) {
  return store.createRepo({
    id,
    userId,
    owner: 'o',
    name: id,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: 'keep it small',
    autoIterate: false,
    intervalMinutes: 1440,
  })
}

function rowFor(html: string, repoId: string): string {
  return new RegExp(`<tr data-repo-id="${repoId}">([\\s\\S]*?)</tr>`).exec(html)?.[1] ?? ''
}

function lastRunCell(html: string, repoId: string): string {
  const row = rowFor(html, repoId)
  assert.notEqual(row, '', 'the dashboard must render the repository row')
  const cell = /<td data-label="Last run">([\s\S]*?)<\/td>/.exec(row)?.[1] ?? ''
  assert.notEqual(cell, '', 'the row must keep its Last run cell')
  return cell.trim()
}

function zhLastRunCell(html: string, repoId = 'repo_time_zh'): string {
  const row = rowFor(html, repoId)
  assert.notEqual(row, '', 'the Chinese dashboard must render the repository row')
  const cell = /<td data-label="上次运行">([\s\S]*?)<\/td>/.exec(row)?.[1] ?? ''
  assert.notEqual(cell, '', 'the row must keep its Last run cell')
  return cell.trim()
}
