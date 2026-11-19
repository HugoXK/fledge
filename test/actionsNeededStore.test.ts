import assert from 'node:assert/strict'
import test from 'node:test'
import { Store, type NotificationRow } from '../src/db.js'
import { jobFailedEmail } from '../src/email/templates.js'
import { dashboardPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #633 first slice: one action id is shared by the in-app row and the mail, a
// duplicate failure does not repeat the notice, resolving clears it, and the
// mail carries no exception string, address, path or token.

interface ActionRecord {
  id: string
  kind: string
  state: string
}

interface ActionApi {
  recordAction(input: {
    userId: string
    kind: string
    repoId: string
    objectId: string
    reason: string
    href: string
    label: string
    urgent: boolean
    at: string
  }): { action: ActionRecord; created: boolean }
  listActions(userId: string): ActionRecord[]
  resolveAction(id: string): void
  markActionRead(id: string): void
  notificationsForAction(id: string): NotificationRow[]
}

function fixture(store: Store, name: string): { userId: string; repoId: string; jobId: string } {
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name, defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  const job = store.createJob({ id: `job_${name}`, repoId: repo.id, userId: user.id, trigger: 'schedule', goal: 'g', callbackHash: `cb_${name}`, platformTokenHash: '' })
  return { userId: user.id, repoId: repo.id, jobId: job.id }
}

function record(api: ActionApi, fixtureIds: { userId: string; repoId: string; jobId: string }, reason = '任务失败，可以重跑。'): { action: ActionRecord; created: boolean } {
  return api.recordAction({
    userId: fixtureIds.userId, kind: 'failed', repoId: fixtureIds.repoId, objectId: fixtureIds.jobId,
    reason, href: `/jobs/${fixtureIds.jobId}`, label: '重跑', urgent: true, at: '2026-11-19T02:00:00.000Z',
  })
}

test('a duplicate failure records one action and sends one notice', () => {
  const store = new Store(':memory:')
  try {
    const ids = fixture(store, 'dup')
    const api = store as unknown as ActionApi
    const first = record(api, ids)
    const second = record(api, ids)
    assert.equal(first.created, true)
    assert.equal(second.created, false, 'the second failure is the same action, not a second one')
    assert.equal(first.action.id, second.action.id)
    // The caller inserts the in-app row only when the action is new, so the
    // duplicate failure leaves exactly one row behind.
    if (first.created) store.notify(ids.userId, 'job', first.action.id, null, first.action.id)
    assert.equal(api.notificationsForAction(first.action.id).length, 1)
  } finally {
    store.close()
  }
})

test('resolving clears the action and a later failure reopens it', () => {
  const store = new Store(':memory:')
  try {
    const ids = fixture(store, 'resolve')
    const api = store as unknown as ActionApi
    const first = record(api, ids)
    assert.equal(api.listActions(ids.userId).length, 1)
    api.resolveAction(first.action.id)
    assert.equal(api.listActions(ids.userId).length, 0, 'a resolved action is not listed')
    const again = record(api, ids)
    assert.equal(again.created, true, 'the next failure is news again')
    assert.equal(again.action.state, 'open')
  } finally {
    store.close()
  }
})

test('the in-app row and the mail carry the same action id, and reading marks the row', () => {
  const store = new Store(':memory:')
  try {
    const ids = fixture(store, 'shared')
    const api = store as unknown as ActionApi
    const { action } = record(api, ids, '任务失败：可以重跑。')
    store.notify(ids.userId, 'job', action.id, null, action.id)
    const user = store.userById(ids.userId)!
    const actionUrl = `https://fledge.example/actions/${action.id}`
    const mail = jobFailedEmail(user, {
      repo: 'o/shared', jobId: ids.jobId, kind: 'iterate', teamUrl: 'https://fledge.example/jobs/x',
      issueUrl: null, prUrl: null, summary: '', error: 'boom', reviewScore: null,
      actionId: action.id, actionUrl,
    })
    assert.ok(mail.text.includes(actionUrl), 'the mail links the action by id')
    assert.ok(mail.text.includes(action.id))
    assert.ok(api.notificationsForAction(action.id).every((row) => row.read_at === null))
    api.markActionRead(action.id)
    assert.ok(api.notificationsForAction(action.id).every((row) => row.read_at !== null), 'opening the action reads its rows')
  } finally {
    store.close()
  }
})

test('the failed-action mail does not carry an exception, address, path or token', () => {
  const store = new Store(':memory:')
  try {
    const ids = fixture(store, 'leak')
    const user = store.userById(ids.userId)!
    const error = `ENOENT: no such file, open '/srv/fledge/data/db.sqlite' at Object.<anonymous> (src/jobs/service.ts:12:3) token ghp_${'b'.repeat(36)} owner@example.com`
    const mail = jobFailedEmail(user, {
      repo: 'o/leak', jobId: ids.jobId, kind: 'iterate', teamUrl: 'https://fledge.example/jobs/x',
      issueUrl: null, prUrl: null, summary: '', error, reviewScore: null,
      actionId: 'act_0123456789ab', actionUrl: 'https://fledge.example/actions/act_0123456789ab',
    })
    const combined = `${mail.subject}\n${mail.text}\n${mail.html}`
    assert.doesNotMatch(combined, /ENOENT|Object\.<anonymous>|src\/jobs|ghp_|owner@example\.com|srv\/fledge/)
    assert.match(mail.subject, /失败/, 'the subject stays a human sentence')
  } finally {
    store.close()
  }
})

test('the dashboard renders the open action with the id the mail uses, in English', () => {
  const store = new Store(':memory:')
  try {
    const ids = fixture(store, 'page')
    const api = store as unknown as ActionApi
    const { action } = record(api, ids)
    const html = dashboardPage({
      config: testConfig(), locale: 'en', viewer: { user: store.userById(ids.userId)!, csrfToken: 'csrf' },
      repos: [], jobs: [], notifications: [], actions: store.listActions(ids.userId),
    })
    assert.match(html, /Needs your decision/)
    assert.ok(html.includes(`/actions/${action.id}`), 'the row links the action by id')
    assert.ok(html.includes(`/actions/${action.id}/resolve`), 'the row offers the resolve form')
    assert.match(html, /The job failed; you can retry it\./, 'the stored sentence is localized on an English page')
    assert.doesNotMatch(html, /任务失败，可以重跑/, 'the Chinese sentence is not shown on an English page')
    assert.match(html, />Retry</, 'the action label is localized on an English page')
    assert.doesNotMatch(html, />重跑</, 'the Chinese label is not shown on an English page')
  } finally {
    store.close()
  }
})
