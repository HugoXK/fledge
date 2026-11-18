import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store, type RepoRow, type ScheduleRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { scheduleConsole } from '../src/schedules/console.js'
import { scheduleConsolePage } from '../src/views/pages.js'
import { encodeOccurrenceSnapshot, occurrenceSnapshot } from '../src/schedules/snapshot.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #544, the read side of the frozen snapshot. #994 stores what an instant was
// decided under; nothing read it, so the whole point — "what did this run as" —
// was unobservable and the column was write-only. The console is where an
// occurrence is inspected, so it answers from the row's own snapshot. Two
// properties decide whether that is honest: the frozen value wins over a later
// edit, and a row that recorded nothing prints unknown rather than today's
// values. Falling back to the live schedule is the bug, not a convenience.

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-16T00:00:00Z')
const LOGICAL = Math.floor(NOW / HOUR) * HOUR

function harness(name: string): { store: Store; userId: string; repoId: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'read', repoRole: 'triage',
    goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
  })
  return { store, userId: user.id, repoId: repo.id }
}

// The instant was claimed while the schedule said "weekdays 09:00 Asia/Shanghai"
// and the run acted as admin through installation 4242. Both rows have since
// been edited to an interval and to read/triage, which is exactly the case where
// the two answers differ.
function frozenSnapshot(repo: RepoRow): string {
  const then: ScheduleRow = {
    id: `sch_${repo.id}`, repo_id: repo.id, kind: 'cron', expression: '0 9 * * 1-5',
    every_ms: null, timezone: 'Asia/Shanghai', start_at: null, end_at: null,
    timing_revision: 1, misfire: 'skip', grace_ms: null, daily_runs: null,
    status: 'active', paused_at: null, last_occurrence_at: null, created_at: '2026-11-15T00:00:00Z',
    updated_at: '2026-11-15T00:00:00Z',
  }
  const acted: RepoRow = { ...repo, installation_id: 4242, permission: 'admin', repo_role: 'maintainer' }
  return encodeOccurrenceSnapshot(occurrenceSnapshot(then, acted))
}

/** The live row is an interval, so a page that echoed the schedule cannot print the frozen cron. */
function claimed(store: Store, repoId: string, snapshotJson: string | null): ReturnType<typeof store.saveSchedule> {
  const row = store.saveSchedule({ id: `sch_${repoId}`, repoId, kind: 'interval', everyMs: HOUR })
  store.claimScheduleOccurrence({
    id: `occ_${repoId}`, scheduleId: row.id, repoId, logicalTime: LOGICAL,
    timingRevision: row.timing_revision, leaseToken: 'tok', leaseMs: HOUR, now: NOW, snapshotJson,
  })
  return row
}

const noJobs = (): string | null => null

/** A row can carry a revision the snapshot never claimed; the page must not hide that. */
function claimedAt(store: Store, repoId: string, revision: number, snapshotJson: string | null): ReturnType<typeof store.saveSchedule> {
  const row = store.saveSchedule({ id: `sch_${repoId}`, repoId, kind: 'interval', everyMs: HOUR })
  store.claimScheduleOccurrence({
    id: `occ_${repoId}_r${String(revision)}`, scheduleId: row.id, repoId, logicalTime: LOGICAL,
    timingRevision: revision, leaseToken: 'tok', leaseMs: HOUR, now: NOW, snapshotJson,
  })
  return row
}

// -- the view model --------------------------------------------------------

test('the console answers what the newest instant was frozen under, not what the schedule says now', () => {
  const { store, repoId } = harness('snapshot-read')
  try {
    const repo = store.getRepo(repoId)!
    const row = claimed(store, repoId, frozenSnapshot(repo))
    const state = scheduleConsole({
      repoId, row, repo, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
    })
    assert.equal(state.frozen.snapshot?.config.expression, '0 9 * * 1-5')
    assert.equal(state.frozen.snapshot?.config.timezone, 'Asia/Shanghai')
    assert.equal(state.frozen.snapshot?.config.timingRevision, 1)
    assert.equal(state.frozen.snapshot?.authorization.permission, 'admin')
    assert.equal(state.frozen.snapshot?.authorization.installationId, 4242)
    assert.equal(state.frozen.snapshot?.authorization.repoRole, 'maintainer')
    assert.deepEqual(
      [...state.frozen.differs].sort(),
      ['kind', 'expression', 'everyMs', 'timezone', 'installation', 'permission', 'role'].sort(),
      'every field the edit moved is named, so the disagreement is not dropped',
    )
    assert.equal(state.occurrences[0]?.snapshot?.config.expression, '0 9 * * 1-5', 'the occurrence carries its own snapshot')
  } finally { store.close() }
})

test('a row with no snapshot answers unknown and names no disagreement', () => {
  const { store, repoId } = harness('snapshot-absent')
  try {
    const repo = store.getRepo(repoId)!
    const row = claimed(store, repoId, null)
    const state = scheduleConsole({
      repoId, row, repo, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
    })
    assert.equal(state.frozen.snapshot, null)
    assert.deepEqual(state.frozen.differs, [], 'nothing was frozen, so there is nothing to disagree with')
    assert.equal(state.schedule?.kind, 'interval', 'the live schedule still answers for itself')
  } finally { store.close() }
})

test('a snapshot written by a newer build is unreadable rather than guessed', () => {
  const { store, repoId } = harness('snapshot-future')
  try {
    const repo = store.getRepo(repoId)!
    const future = JSON.stringify({ ...JSON.parse(frozenSnapshot(repo)), version: 99 })
    const row = claimed(store, repoId, future)
    const state = scheduleConsole({
      repoId, row, repo, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
    })
    assert.equal(state.frozen.snapshot, null, 'a version this build cannot read is unknown, not a best effort')
  } finally { store.close() }
})

test('a snapshot whose own revision is not the row\'s revision is named, not printed as if it belonged', () => {
  const { store, repoId } = harness('snapshot-revision')
  try {
    const repo = store.getRepo(repoId)!
    // The row was decided under revision 99; the snapshot says revision 1.
    const row = claimedAt(store, repoId, 99, frozenSnapshot(repo))
    const state = scheduleConsole({
      repoId, row, repo, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
    })
    assert.equal(state.frozen.revisionMismatch, true)
    assert.ok(state.frozen.differs.includes('revision'), 'the mismatch is a named disagreement, not a silent parse')
    assert.equal(state.frozen.snapshot?.config.timingRevision, 1, 'the frozen revision is still reported')

    const html = page(store, repoId, row, 'en')
    assert.match(html, /data-snapshot-revision-mismatch="mismatch"/, 'the page tells the reader the record cannot be proven to belong here')
    assert.match(html, /timing revision 1/)
    assert.match(html, /belongs to revision 99/)
  } finally { store.close() }
})

test('a matching revision says nothing about a mismatch', () => {
  const { store, repoId } = harness('snapshot-revision-ok')
  try {
    const repo = store.getRepo(repoId)!
    const row = claimed(store, repoId, frozenSnapshot(repo))
    const html = page(store, repoId, row, 'en')
    assert.doesNotMatch(html, /data-snapshot-revision-mismatch/)
    assert.match(html, /data-snapshot-revision="1"/, 'the frozen revision is still printed')
  } finally { store.close() }
})

// -- the page --------------------------------------------------------------

function page(store: Store, repoId: string, row: ReturnType<typeof store.saveSchedule>, locale: 'zh' | 'en'): string {
  const repo = store.getRepo(repoId)!
  return scheduleConsolePage({
    config: testConfig(), locale, viewer: { user: store.userById(repo.user_id)!, csrfToken: 'csrf_test' }, repo,
    state: scheduleConsole({
      repoId, row, repo, occurrences: store.listScheduleOccurrences(repoId, 10), now: NOW, jobStatus: noJobs,
    }),
    form: { cron: '', every: '', timezone: '', startAt: '', endAt: '', misfire: 'skip', grace: '', dailyRuns: '' },
    runNowKey: 'cmd_snapshot',
  } as never)
}

test('the page prints the frozen values, the frozen ones win, and the disagreement is visible', () => {
  const { store, repoId } = harness('snapshot-page')
  try {
    const row = claimed(store, repoId, frozenSnapshot(store.getRepo(repoId)!))
    const html = page(store, repoId, row, 'en')
    assert.match(html, /data-snapshot="frozen"/, 'the card is machine-readable as frozen')
    assert.match(html, /data-snapshot-expression="0 9 \* \* 1-5"/, 'the frozen cron is what the page prints')
    assert.match(html, /data-snapshot-timezone="Asia\/Shanghai"/)
    assert.match(html, /data-snapshot-permission="admin"/)
    assert.match(html, /data-snapshot-installation="4242"/)
    assert.match(html, /data-snapshot-role="maintainer"/)
    assert.match(html, /data-snapshot-differs="[^"]*expression[^"]*"/, 'the page names the fields that moved instead of hiding them')
    assert.match(html, /frozen/i, 'the reader is told these are the values it ran under')
    assert.doesNotMatch(html, /data-snapshot-expression="—"/, 'a frozen read never shows the live interval as if it were frozen')
  } finally { store.close() }
})

test('a row that froze nothing prints unknown, never the live schedule', () => {
  const { store, repoId } = harness('snapshot-page-unknown')
  try {
    const row = claimed(store, repoId, null)
    const html = page(store, repoId, row, 'en')
    assert.match(html, /data-snapshot="unknown"/)
    assert.match(html, /data-snapshot-expression="unknown"/)
    assert.match(html, /data-snapshot-timezone="unknown"/)
    assert.match(html, /data-snapshot-permission="unknown"/)
    const frozen = /<section[^>]*data-snapshot="unknown"[\s\S]*?<\/section>/.exec(html)
    assert.notEqual(frozen, null, 'the unknown card exists rather than being omitted')
    assert.doesNotMatch(frozen![0], /data-snapshot-timezone="[^"]*Asia/, 'the live zone is not borrowed into the frozen card')
  } finally { store.close() }
})

test('the zh page carries the same frozen facts, not a translated live schedule', () => {
  const { store, repoId } = harness('snapshot-page-zh')
  try {
    const row = claimed(store, repoId, frozenSnapshot(store.getRepo(repoId)!))
    const html = page(store, repoId, row, 'zh')
    assert.match(html, /data-snapshot="frozen"/)
    assert.match(html, /data-snapshot-expression="0 9 \* \* 1-5"/)
    assert.match(html, /data-snapshot-permission="admin"/)
  } finally { store.close() }
})

// -- the route -------------------------------------------------------------

test('the schedule console route hands the frozen snapshot to the page', async () => {
  const store = new Store(':memory:')
  const built: BuiltApp = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'snapshot-route-owner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_snapshot_route', userId: user.id, owner: 'o', name: 'snapshot-route',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'read', repoRole: 'triage',
      goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    claimed(store, repo.id, frozenSnapshot(store.getRepo(repo.id)!))
    const session = sessionFor(built, user)
    const response = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/schedule`, headers: { cookie: session.cookie } })
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /data-snapshot="frozen"/, 'the route reads the occurrence row, not just the live schedule')
    assert.match(response.body, /data-snapshot-permission="admin"/, 'and the authorization it acted with')
  } finally { await built.close() }
})
