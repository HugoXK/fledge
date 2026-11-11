import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { MockRunner } from '../src/jobs/mock.js'
import { adminPage } from '../src/views/pages.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #317: a stopped platform has to look stopped on `/admin`. The stop route
// reports once through `?notice=` and that line is gone on reload, so an
// operator (or a second admin) could not tell a stopped platform from a quiet
// one, and "why is nothing being enqueued?" had no answer on screen.
//
// The record is `{at, by, reason}` from `jobs.platformStop()`. Two of its shapes
// must not be flattened into a healthy page or into fabricated facts: the
// unreadable row (`{at:'', by:'', reason:''}`, which is how a corrupt row
// parses) still means stopped, and a cleared row means the banner is gone.

const MARKER = 'data-platform-stopped'
// The key `platformStop()` reads; the service keeps it private, and this suite
// must not widen that surface to assert a banner.
const STOP_KEY = 'platform.stop'

function renderAdmin(
  store: Store,
  input: { locale: 'zh' | 'en'; login: string; platformStop?: { at: string; by: string; reason: string } | null; notice?: string },
): string {
  const user = makeUser(store, { login: input.login, status: 'approved', superadmin: true })
  return adminPage({
    config: testConfig(),
    locale: input.locale,
    viewer: { user: store.userById(user.id)!, csrfToken: 'csrf-banner' },
    users: [],
    jobs: [],
    jobsPage: 1,
    jobsTotal: 0,
    audit: [],
    auditPage: 1,
    auditTotal: 0,
    perPage: 10,
    notice: input.notice,
    platformStop: input.platformStop,
  } as Parameters<typeof adminPage>[0])
}

test('the admin page names the operator, the time and the reason, in both languages', () => {
  const store = new Store(':memory:')
  try {
    const stop = { at: '2026-11-11T16:01:02.000Z', by: 'operator-login', reason: 'provider incident' }
    const zh = renderAdmin(store, { locale: 'zh', login: 'banner-zh', platformStop: stop })
    const en = renderAdmin(store, { locale: 'en', login: 'banner-en', platformStop: stop })

    for (const page of [zh, en]) {
      assert.match(page, new RegExp(MARKER), 'the banner marker must be rendered while the platform is stopped')
      assert.match(page, /operator-login/, 'the operator login must be on the page')
      assert.match(page, /2026-11-11T16:01:02\.000Z/, 'the stop time must be on the page')
      assert.match(page, /provider incident/, 'the reason must be on the page')
    }
    assert.match(zh, /平台已停止/)
    assert.match(en, /Platform is stopped/)
    assert.match(zh, /恢复平台/)
    assert.match(en, /Resume platform/)
  } finally {
    store.close()
  }
})

test('a running platform renders no banner at all', () => {
  const store = new Store(':memory:')
  try {
    for (const locale of ['zh', 'en'] as const) {
      const page = renderAdmin(store, { locale, login: `banner-open-${locale}`, platformStop: null })
      assert.doesNotMatch(page, new RegExp(MARKER))
      assert.doesNotMatch(page, /operator-login/)
    }
  } finally {
    store.close()
  }
})

test('an unreadable record still says stopped, and invents neither an operator nor a time', () => {
  const store = new Store(':memory:')
  try {
    const zh = renderAdmin(store, { locale: 'zh', login: 'banner-unreadable-zh', platformStop: { at: '', by: '', reason: '' } })
    const en = renderAdmin(store, { locale: 'en', login: 'banner-unreadable-en', platformStop: { at: '', by: '', reason: '' } })

    for (const page of [zh, en]) {
      assert.match(page, new RegExp(MARKER), 'a corrupt row is still a stop')
      assert.doesNotMatch(page, /Operator: @|操作者：@/, 'no empty operator may be rendered as if it were a fact')
    }
    assert.match(zh, /停机记录无法读取/)
    assert.match(en, /stop record cannot be read/)
  } finally {
    store.close()
  }
})

test('the notice redirect alone cannot produce the banner, and the record needs no notice', () => {
  const store = new Store(':memory:')
  try {
    const noticeOnly = renderAdmin(store, { locale: 'en', login: 'banner-notice', platformStop: null, notice: 'Platform is stopped.' })
    assert.doesNotMatch(noticeOnly, new RegExp(MARKER), '?notice= is a one-shot line, not the stop record')
    assert.match(noticeOnly, /Platform is stopped\./, 'the notice itself still renders')

    const recordOnly = renderAdmin(store, {
      locale: 'en',
      login: 'banner-record',
      platformStop: { at: '2026-11-11T16:01:02.000Z', by: 'operator-login', reason: '' },
    })
    assert.match(recordOnly, new RegExp(MARKER))
  } finally {
    store.close()
  }
})

test('the banner follows the recorded row: gone after a resume clears it', async () => {
  const store = new Store(':memory:')
  try {
    const jobs = new Jobs(store, testConfig(), new MockRunner(), new MemoryMailer())
    store.setSetting(STOP_KEY, JSON.stringify({ at: '2026-11-11T16:01:02.000Z', by: 'operator-login', reason: 'provider incident' }))
    const stopped = renderAdmin(store, { locale: 'en', login: 'banner-cleared', platformStop: jobs.platformStop() })
    assert.match(stopped, new RegExp(MARKER))
    assert.match(stopped, /operator-login/)

    store.deleteSetting(STOP_KEY)
    const resumed = renderAdmin(store, { locale: 'en', login: 'banner-cleared-2', platformStop: jobs.platformStop() })
    assert.doesNotMatch(resumed, new RegExp(MARKER))
    assert.doesNotMatch(resumed, /operator-login/)
  } finally {
    store.close()
  }
})
