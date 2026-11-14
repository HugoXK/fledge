import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { scheduleConsole } from '../src/schedules/console.js'
import { nextTime, parseSchedule } from '../src/schedules/next.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #544 slice 3A/3B, the console: the slice where a maintainer can read what the
// schedule says and change it. Two properties matter and both are asserted here:
// the console answers with the planner's own answer (never a second formula), and
// a value it cannot know is `unknown` rather than zero. The stored row exists
// (#661) and the lease exists (#662); until this slice nothing in the product
// called `saveSchedule`, so nobody could feel either.

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-16T00:00:00Z')

function harness(name: string): { store: Store; userId: string; repoId: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
  })
  return { store, userId: user.id, repoId: repo.id }
}

function cronRow(store: Store, repoId: string) {
  return store.saveSchedule({ id: `sch_${repoId}`, repoId, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
}

const noJobs = (): string | null => null

// -- the view model --------------------------------------------------------

test('a repository with no schedule answers unknown and never zero', () => {
  const { store, repoId } = harness('console-none')
  try {
    const state = scheduleConsole({ repoId, row: store.scheduleForRepo(repoId), occurrences: [], now: NOW, jobStatus: noJobs })
    assert.equal(state.kind, 'none')
    assert.equal(state.schedule, null)
    assert.equal(state.nextAt, null)
    assert.equal(state.last, null)
    assert.equal(state.lastSuccess, null)
    assert.equal(state.delivery, 'unknown', 'a delivery result nobody recorded is unknown, not "0 sent"')
    assert.deepEqual(state.occurrences, [])
  } finally { store.close() }
})

test('the console next run is the planner next run, not a second formula', () => {
  const { store, repoId } = harness('console-next')
  try {
    const row = cronRow(store, repoId)
    const parsed = parseSchedule({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    const state = scheduleConsole({ repoId, row, occurrences: [], now: NOW, jobStatus: noJobs })
    assert.equal(state.kind, 'cron')
    assert.equal(state.nextAt, nextTime(parsed.schedule, NOW))
    assert.equal(state.nextAt, Date.parse('2026-11-16T01:00:00Z'), 'a Monday 09:00 in Asia/Shanghai is 01:00 UTC')
    assert.equal(state.timingRevision, 1)
    assert.equal(state.misfire, 'skip')
  } finally { store.close() }
})

test('a row the planner cannot read is named unreadable instead of guessed', () => {
  const { store, repoId } = harness('console-unreadable')
  try {
    const row = store.saveSchedule({ id: 'sch_bad', repoId, kind: 'cron', expression: null, timezone: 'Asia/Shanghai' })
    const state = scheduleConsole({ repoId, row, occurrences: [], now: NOW, jobStatus: noJobs })
    assert.equal(state.kind, 'unreadable')
    assert.equal(state.nextAt, null)
  } finally { store.close() }
})

test('the last decision carries its reason, attempts and live lease', () => {
  const { store, repoId } = harness('console-decision')
  try {
    const row = cronRow(store, repoId)
    const at = Date.parse('2026-11-15T01:00:00Z')
    const claimed = store.claimScheduleOccurrence({
      id: 'occ_live', scheduleId: row.id, repoId, logicalTime: at, timingRevision: row.timing_revision,
      leaseToken: 'tok_live', leaseMs: HOUR, now: NOW,
    })
    assert.equal(claimed.claimed, true)
    const state = scheduleConsole({ repoId, row, occurrences: store.listScheduleOccurrences(repoId), now: NOW + 60_000, jobStatus: noJobs })
    assert.notEqual(state.last, null)
    assert.equal(state.last?.state, 'claimed')
    assert.equal(state.last?.attempts, 1)
    assert.equal(state.last?.leaseHeld, true, 'a lease that has not lapsed is held, and the console says so')
    assert.equal(state.last?.leaseExpiresAt, NOW + HOUR)
    assert.equal(state.last?.jobId, null, 'a claimed instant has not dispatched anything yet')
    assert.equal(state.lastSuccess, null, 'nothing succeeded yet, which is unknown, not a success at zero')
  } finally { store.close() }
})

test('the skipped instant keeps its reason and the last success is the newest succeeded job', () => {
  const { store, repoId, userId } = harness('console-skipped')
  try {
    const row = cronRow(store, repoId)
    const older = Date.parse('2026-11-13T01:00:00Z')
    const newer = Date.parse('2026-11-14T01:00:00Z')
    const skipped = Date.parse('2026-11-15T01:00:00Z')
    const succeeded = store.createJob({ id: 'job_ok', repoId, userId, trigger: 'schedule', goal: 'g', callbackHash: 'cb_ok', platformTokenHash: '' })
    store.updateJob(succeeded.id, { status: 'succeeded', finished_at: '2026-11-14T02:00:00Z' })
    const failed = store.createJob({ id: 'job_bad', repoId, userId, trigger: 'schedule', goal: 'g', callbackHash: 'cb_bad', platformTokenHash: '' })

    const claim = (id: string, logicalTime: number) => store.claimScheduleOccurrence({
      id, scheduleId: row.id, repoId, logicalTime, timingRevision: row.timing_revision,
      leaseToken: `tok_${id}`, leaseMs: HOUR, now: NOW,
    })
    claim('occ_old', older)
    store.settleScheduleOccurrence({ scheduleId: row.id, logicalTime: older, timingRevision: row.timing_revision, leaseToken: 'tok_occ_old', state: 'dispatched', jobId: failed.id, dispatchedAt: older, lagMs: 0, now: NOW })
    claim('occ_new', newer)
    store.settleScheduleOccurrence({ scheduleId: row.id, logicalTime: newer, timingRevision: row.timing_revision, leaseToken: 'tok_occ_new', state: 'dispatched', jobId: succeeded.id, dispatchedAt: newer, lagMs: 0, now: NOW })
    claim('occ_skip', skipped)
    store.settleScheduleOccurrence({ scheduleId: row.id, logicalTime: skipped, timingRevision: row.timing_revision, leaseToken: 'tok_occ_skip', state: 'skipped', reason: 'active-job', missed: 0, now: NOW })

    const rows = store.listScheduleOccurrences(repoId)
    const state = scheduleConsole({ repoId, row, occurrences: rows, now: NOW, jobStatus: (jobId) => store.getJob(jobId)?.status ?? null })
    assert.equal(state.last?.state, 'skipped')
    assert.equal(state.last?.reason, 'active-job', 'a skipped instant is recorded with a reason, not dropped silently')
    assert.equal(state.last?.attempts, 1)
    assert.equal(state.lastSuccess?.jobId, succeeded.id, 'the newest *succeeded* job is the last success, not the newest dispatch')
    assert.equal(state.lastSuccess?.logicalTime, newer)
    assert.equal(state.occurrences.length, 3)
  } finally { store.close() }
})

// -- the pages a maintainer touches ---------------------------------------

async function fixture(name: string): Promise<{ built: BuiltApp; user: ReturnType<typeof makeUser>; repoId: string; close: () => Promise<void> }> {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name,
    defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
  })
  return { built, user, repoId: repo.id, close: async () => { await built.close() } }
}

function saveSchedule(built: BuiltApp, user: ReturnType<typeof makeUser>, repoId: string, payload: Record<string, string>): Promise<{ statusCode: number; location: string }> {
  const session = sessionFor(built, user)
  return built.app.inject({
    method: 'POST',
    url: `/repos/${repoId}/schedule`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
    payload: formBody({ csrf: session.csrf, ...payload }),
  }).then((response) => ({ statusCode: response.statusCode, location: String(response.headers.location) }))
}

test('the console page shows the saved schedule and the planner next run', async () => {
  const f = await fixture('console-page')
  try {
    cronRow(f.built.store, f.repoId)
    const session = sessionFor(f.built, f.user)
    const response = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}/schedule`, headers: { cookie: session.cookie } })
    assert.equal(response.statusCode, 200)
    const body = response.body
    assert.match(body, /0 9 \* \* 1-5/, 'the stored expression is on the page')
    assert.match(body, /Asia\/Shanghai/)
    assert.match(body, /data-schedule-next="[^"]+"/, 'the next run is rendered as a machine-readable value')
    assert.match(body, /data-delivery="unknown"/, 'a delivery result nobody recorded is unknown')
    assert.match(body, /data-last-success="unknown"/, 'no succeeded run yet reads unknown, never zero')
  } finally { await f.close() }
})

test('saving a schedule from the console writes the row and audits it', async () => {
  const f = await fixture('console-save')
  try {
    const saved = await saveSchedule(f.built, f.user, f.repoId, { cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    assert.equal(saved.statusCode, 302)
    assert.match(saved.location, /saved=1/)
    const row = f.built.store.scheduleForRepo(f.repoId)
    assert.notEqual(row, undefined)
    assert.equal(row?.kind, 'cron')
    assert.equal(row?.expression, '0 9 * * 1-5')
    assert.equal(row?.timezone, 'Asia/Shanghai')
    const audits = f.built.store.listAudit(50).filter((entry) => entry.action === 'schedule.saved')
    assert.equal(audits.length, 1, 'the console writes the change to the audit log')
    assert.match(audits[0]?.detail ?? '', /0 9 \* \* 1-5/, 'the audit names what was saved')
  } finally { await f.close() }
})

test('an invalid schedule is refused and saves nothing', async () => {
  const f = await fixture('console-refuse')
  try {
    const refused = await saveSchedule(f.built, f.user, f.repoId, { cron: '0 9 * *', timezone: 'Asia/Shanghai' })
    assert.equal(refused.statusCode, 302)
    assert.match(refused.location, /refused=/)
    assert.equal(f.built.store.scheduleForRepo(f.repoId), undefined, 'a refused schedule does not half-save')
    assert.equal(f.built.store.listAudit(50).filter((entry) => entry.action === 'schedule.saved').length, 0)
  } finally { await f.close() }
})

test('the console is not readable for a repository the viewer does not own', async () => {
  const f = await fixture('console-other')
  try {
    const stranger = makeUser(f.built.store, { login: 'console-stranger', status: 'approved' })
    const session = sessionFor(f.built, stranger)
    const response = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}/schedule`, headers: { cookie: session.cookie } })
    assert.equal(response.statusCode, 404)
  } finally { await f.close() }
})

// The repository page used to print the legacy interval rule for every repository,
// including one whose schedule owned its cadence (#564's comment claimed the two
// agreed). It now reads the planner for a scheduled repository, so the page and
// the console answer with one number.
test('the repository page reads the planner for a scheduled repository', async () => {
  const f = await fixture('console-repo-page')
  try {
    const session = sessionFor(f.built, f.user)
    const before = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}`, headers: { cookie: session.cookie } })
    assert.equal(before.statusCode, 200)
    assert.match(before.body, new RegExp(`href="/repos/${f.repoId}/schedule"`), 'the console is reachable from the repository page')
    assert.match(before.body, /data-next-source="interval"/, 'a repository without a schedule row is answered by the legacy rule')

    cronRow(f.built.store, f.repoId)
    const after = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}`, headers: { cookie: session.cookie } })
    assert.equal(after.statusCode, 200)
    assert.match(after.body, /data-next-source="schedule"/, 'a scheduled repository is answered by the planner, not the legacy rule')

    f.built.store.saveSchedule({ id: 'sch_broken', repoId: f.repoId, kind: 'cron', expression: null, timezone: 'Asia/Shanghai' })
    const broken = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}`, headers: { cookie: session.cookie } })
    assert.match(broken.body, /unknown/, 'an unreadable schedule prints unknown instead of a guessed time')
  } finally { await f.close() }
})

// The stored interval is exact — `parseEvery` takes `90s` and the page's own
// example advertises it — so the form has to echo it exactly. Rounding it to
// `2m` would make one click on Save rewrite 90000 to 120000: a data change on a
// click, which is why this is a blocking case and not a cosmetic one.
test('a sub-minute interval is echoed exactly and survives an unchanged save', async () => {
  const f = await fixture('console-exact')
  try {
    const saved = await saveSchedule(f.built, f.user, f.repoId, { every: '90s' })
    assert.equal(saved.statusCode, 302)
    assert.match(saved.location, /saved=1/)
    assert.equal(f.built.store.scheduleForRepo(f.repoId)?.every_ms, 90_000, '90s is stored as 90000ms')

    const session = sessionFor(f.built, f.user)
    const page = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}/schedule`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    const field = page.body.match(/name="every" value="([^"]*)"/)
    assert.notEqual(field, null, 'the console has the interval field')
    assert.equal(field?.[1], '90s', 'the field echoes the stored value instead of a rounded one')
    assert.match(page.body, /<code>90s<\/code>/, 'the stored-schedule line reads the interval exactly too')

    const again = await saveSchedule(f.built, f.user, f.repoId, { every: String(field?.[1] ?? '') })
    assert.match(again.location, /saved=1/)
    assert.equal(f.built.store.scheduleForRepo(f.repoId)?.every_ms, 90_000, 'saving the page unchanged rewrites nothing')
  } finally { await f.close() }
})

// The page says a repository it does not own answers 404; until now only the GET
// was asserted. Both writes and the CSRF guard are refused here, and the row is
// read back afterwards so a refused write is proved not to have half-written.
test('a stranger cannot write the schedule and a bad CSRF token writes nothing', async () => {
  const f = await fixture('console-write-guard')
  try {
    cronRow(f.built.store, f.repoId)
    const post = (url: string, session: { cookie: string; csrf: string }, payload: Record<string, string>) => f.built.app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
      payload: formBody({ csrf: session.csrf, ...payload }),
    })

    const stranger = makeUser(f.built.store, { login: 'console-write-stranger', status: 'approved' })
    const strangerSession = sessionFor(f.built, stranger)
    const strangerSave = await post(`/repos/${f.repoId}/schedule`, strangerSession, { cron: '0 3 * * *', timezone: 'UTC' })
    assert.equal(strangerSave.statusCode, 404, 'a stranger cannot save a schedule')
    const strangerRemove = await post(`/repos/${f.repoId}/schedule/remove`, strangerSession, {})
    assert.equal(strangerRemove.statusCode, 404, 'a stranger cannot delete a schedule')

    const ownerSession = sessionFor(f.built, f.user)
    const badCsrf = await f.built.app.inject({
      method: 'POST',
      url: `/repos/${f.repoId}/schedule`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: ownerSession.cookie },
      payload: formBody({ csrf: 'not-the-session-token', cron: '0 4 * * *', timezone: 'UTC' }),
    })
    assert.equal(badCsrf.statusCode, 403, 'a write without the session token is refused')

    const row = f.built.store.scheduleForRepo(f.repoId)
    assert.equal(row?.expression, '0 9 * * 1-5', 'none of the refused writes changed the row')
    assert.equal(row?.timezone, 'Asia/Shanghai')
  } finally { await f.close() }
})
