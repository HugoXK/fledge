import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { scheduleConsole } from '../src/schedules/console.js'
import { scheduleConsolePage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'
import type { RepoRow } from '../src/db.js'

// #1003: a repository whose `repo_role` was never chosen still iterates by hand
// (Run now hands the route's resolved role to the service), but every scheduled
// caller passes no actor role, so the tick's `enqueue` is refused
// `ROLE_REQUIRED` and the due instant settles as a skipped occurrence. The
// console was the one surface that said nothing about it: `ownedRepo` resolves
// the owner as `maintainer`, so the owner saw a working Run now and no note.
// These renders pin the sentence to `repo.repo_role === null` alone, so it does
// not come and go with the viewer's resolved role.

const NOW = Date.parse('2026-11-16T00:00:00Z')

function fixture(name: string, repoRole: string | null): { store: Store; repo: RepoRow; userId: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole, goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
  })
  store.saveSchedule({ id: `sch_${name}`, repoId: repo.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
  return { store, repo, userId: user.id }
}

function render(f: ReturnType<typeof fixture>, locale: 'zh' | 'en', role = 'maintainer'): string {
  const repo = f.store.getRepo(f.repo.id)!
  const user = f.store.userById(f.userId)!
  return scheduleConsolePage({
    config: testConfig(),
    locale,
    viewer: { user, csrfToken: 'csrf_test' },
    repo,
    state: scheduleConsole({
      repoId: repo.id,
      row: f.store.scheduleForRepo(repo.id),
      repo,
      occurrences: [],
      now: NOW,
      jobStatus: () => null,
    }),
    role,
    form: { cron: '', every: '', timezone: '', startAt: '', endAt: '', misfire: 'skip', grace: '', dailyRuns: '' },
    runNowKey: 'cmd_role_paused',
  })
}

test('a NULL repo_role says scheduled runs are paused, in both locales, and keeps Run now', () => {
  const f = fixture('role-paused', null)
  try {
    const zh = render(f, 'zh')
    assert.match(zh, /data-scheduled-paused="role-missing"/, 'the console marks the unchosen role instead of staying silent')
    assert.match(zh, /定时运行保持暂停/, 'the zh console says scheduled runs stay paused')
    assert.match(zh, /每个到期的时刻都会被跳过/, 'the zh console says each due instant is skipped')
    assert.match(zh, new RegExp(`action="/repos/${f.repo.id}/schedule/run-now"`), 'Run now is still offered for a manual run')

    const en = render(f, 'en')
    assert.match(en, /data-scheduled-paused="role-missing"/, 'the attribute is locale-independent')
    assert.match(en, /scheduled runs stay paused/, 'the en console says scheduled runs stay paused')
    assert.match(en, /every due instant is skipped/, 'the en console says each due instant is skipped')
    assert.match(en, new RegExp(`action="/repos/${f.repo.id}/schedule/run-now"`), 'Run now is still offered for a manual run')
  } finally {
    f.store.close()
  }
})

test('a chosen role drops the sentence and the console reads as before', () => {
  const f = fixture('role-chosen', 'developer')
  try {
    for (const locale of ['zh', 'en'] as const) {
      const html = render(f, locale)
      assert.doesNotMatch(html, /data-scheduled-paused/, `${locale}: a repository with a role is not called paused`)
      assert.match(html, new RegExp(`action="/repos/${f.repo.id}/schedule/run-now"`), `${locale}: Run now is still there`)
    }
  } finally {
    f.store.close()
  }
})

test('a viewer of a NULL-role repository gets the pause sentence and keeps the viewer note', () => {
  const f = fixture('role-paused-viewer', null)
  try {
    for (const locale of ['zh', 'en'] as const) {
      const html = render(f, locale, 'viewer')
      assert.match(html, /data-scheduled-paused="role-missing"/, `${locale}: the scheduled half is paused whatever the viewer resolved`)
      assert.match(html, /data-run-now-role="viewer"/, `${locale}: the existing viewer note is untouched`)
      assert.doesNotMatch(html, /action="\/repos\/[^"]+\/schedule\/run-now"/, `${locale}: a viewer is still not handed the control`)
    }
  } finally {
    f.store.close()
  }
})
