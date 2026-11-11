import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { JOB_FILTER_KINDS, jobFilterIsActive, jobFilterParams, parseJobFilters } from '../src/lib/jobFilters.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #232: the dashboard's job table is ten rows per page with no way to narrow it,
// so finding one failed job or one repository's delivery means paging through
// history. The filters are a GET on `/dashboard`, compose with the 7/30-day
// window and the existing `jobsPage`, and the state lives in the URL — no new
// client store. The unit half covers validation; the HTTP half proves the URL
// and the result set move together, pagination keeps them, and an invalid value
// is dropped rather than turned into an error page.

// A page is ordered by `created_at`, and inserting a batch in one millisecond
// leaves every row tied, so the recorded order has to be stated rather than
// raced. Each seeded job steps the clock by one second off a fixed origin, and
// each call continues after the previous one, so a later batch really is newer.
let jobClock = Date.parse('2026-01-01T00:00:00.000Z')

function makeJobs(store: Store, userId: string, repoId: string, prefix: string, count: number, status: 'failed' | 'succeeded', kind = 'iterate'): void {
  for (let index = 0; index < count; index += 1) {
    const id = `job_${prefix}${index}`
    jobClock += 1000
    store.createJob({ id, repoId, userId, trigger: 'manual', goal: 'goal', callbackHash: `hash-${id}`, platformTokenHash: '', kind, createdAt: new Date(jobClock).toISOString() })
    store.updateJob(id, { status })
  }
}

test('a filter keeps only the values this account can use', () => {
  const parsed = parseJobFilters({ repo: 'r1', status: 'failed', kind: 'review' }, ['r1', 'r2'])
  assert.deepEqual(parsed, { repo: 'r1', status: 'failed', kind: 'review' })

  assert.deepEqual(parseJobFilters({ repo: 'r9', status: 'failed', kind: 'review' }, ['r1', 'r2']), { repo: '', status: 'failed', kind: 'review' }, 'a repository this account does not own is dropped')
  assert.deepEqual(parseJobFilters({ repo: 'r1', status: 'exploded', kind: 'review' }, ['r1']), { repo: 'r1', status: '', kind: 'review' }, 'an unknown status is dropped, not an error')
  assert.deepEqual(parseJobFilters({ repo: 'r1', status: 'failed', kind: 'gossip' }, ['r1']), { repo: 'r1', status: 'failed', kind: '' }, 'an unknown kind is dropped')
  assert.deepEqual(parseJobFilters({}, []), { repo: '', status: '', kind: '' }, 'no query is no filter')
})

test('the filter turns back into URL parameters and reports whether it is active', () => {
  assert.deepEqual(jobFilterParams({ repo: 'r1', status: 'failed', kind: 'review' }), { repo: 'r1', status: 'failed', kind: 'review' })
  assert.deepEqual(jobFilterParams({ repo: 'r1', status: '', kind: '' }), { repo: 'r1' }, 'empty values do not reach the URL')
  assert.deepEqual(jobFilterParams({ repo: '', status: '', kind: '' }), {})
  assert.equal(jobFilterIsActive({ repo: '', status: '', kind: '' }), false)
  assert.equal(jobFilterIsActive({ repo: '', status: '', kind: 'review' }), true)
})

test('the store filters compose, and the count matches the rows', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'filters-store', status: 'approved' })
    const r1 = store.createRepo({ id: 'r1', userId: user.id, owner: 'o', name: 'one', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const r2 = store.createRepo({ id: 'r2', userId: user.id, owner: 'o', name: 'two', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    makeJobs(store, user.id, r1.id, 'a', 3, 'failed', 'review')
    makeJobs(store, user.id, r1.id, 'b', 2, 'succeeded', 'iterate')
    makeJobs(store, user.id, r2.id, 'c', 4, 'failed', 'iterate')

    const none = { repo: '', status: '', kind: '' }
    assert.equal(store.countJobsForUser(user.id, none), 9)
    assert.equal(store.countJobsForUser(user.id, { ...none, repo: r1.id }), 5)
    assert.equal(store.countJobsForUser(user.id, { ...none, status: 'failed' as const }), 7, 'the status filter is a filter, not a page slice')
    assert.equal(store.countJobsForUser(user.id, { ...none, repo: r1.id, status: 'failed' as const, kind: 'review' }), 3)

    const page = store.listJobsPageForUser(user.id, 10, 0, { ...none, repo: r1.id, status: 'failed' as const, kind: 'review' })
    assert.deepEqual(page.map((job) => job.id).sort(), ['job_a0', 'job_a1', 'job_a2'])
    const second = store.listJobsPageForUser(user.id, 2, 2, { ...none, status: 'failed' as const })
    assert.equal(second.length, 2, 'the filter survives the page offset')
  } finally {
    store.close()
  }
})

// #232: the CI failure this pins. A batch of jobs written in the same
// millisecond ties on `created_at`, and without a tiebreaker SQLite is free to
// return them in storage order — the same row can then sit on page 1 and page 2
// at once, or fall out of both. `rowid DESC` makes the newest insert of a tie
// come first, so the pages partition the set.
test('jobs written in the same millisecond page in insertion order', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'filters-ties', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_ties', userId: user.id, owner: 'o', name: 'ties', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const createdAt = '2026-01-01T00:00:00.000Z'
    for (const id of ['job_t0', 'job_t1', 'job_t2']) {
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'goal', callbackHash: `hash-${id}`, platformTokenHash: '', kind: 'iterate', createdAt })
      store.updateJob(id, { status: 'failed' })
    }

    const first = store.listJobsPageForUser(user.id, 2, 0, { repo: '', status: '', kind: '' })
    const second = store.listJobsPageForUser(user.id, 2, 2, { repo: '', status: '', kind: '' })
    assert.deepEqual(first.map((job) => job.id), ['job_t2', 'job_t1'], 'a tie is broken by insertion order, newest first')
    assert.deepEqual(second.map((job) => job.id), ['job_t0'], 'the pages partition the set instead of overlapping')
  } finally {
    store.close()
  }
})

test('the URL and the result set move together, and pagination keeps the filter', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'filters-route', status: 'approved' })
    const session = sessionFor(built, user)
    const cookie = `${session.cookie}; fledge_lang=en`
    const repoA = store.createRepo({ id: 'repo_a', userId: user.id, owner: 'o', name: 'a', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const repoB = store.createRepo({ id: 'repo_b', userId: user.id, owner: 'o', name: 'b', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    makeJobs(store, user.id, repoA.id, 'f', 12, 'failed')
    makeJobs(store, user.id, repoB.id, 's', 3, 'succeeded')

    const filtered = await built.app.inject({ method: 'GET', url: '/dashboard?status=failed', headers: { cookie } })
    assert.equal(filtered.statusCode, 200)
    assert.equal((filtered.body.match(/data-job-id="job_f/g) ?? []).length, 10, 'the failed filter fills the first page')
    assert.doesNotMatch(filtered.body, /data-job-id="job_s0"/, 'the succeeded jobs are not in the filtered page')
    assert.match(filtered.body, /status=failed/, 'pagination carries the filter')
    assert.match(filtered.body, /data-job-filter/, 'the form reports which filter is applied')

    const secondPage = await built.app.inject({ method: 'GET', url: '/dashboard?status=failed&jobsPage=2', headers: { cookie } })
    assert.equal((secondPage.body.match(/data-job-id="job_f/g) ?? []).length, 2, 'the second page holds the rest of the filtered set')

    const invalid = await built.app.inject({ method: 'GET', url: '/dashboard?status=exploded', headers: { cookie } })
    assert.equal(invalid.statusCode, 200, 'an invalid filter is not an error page')
    assert.match(invalid.body, /data-job-id="job_s0"/, 'an invalid status falls back to the unfiltered list')

    const empty = await built.app.inject({ method: 'GET', url: '/dashboard?repo=repo_b&status=failed', headers: { cookie } })
    assert.equal(empty.statusCode, 200)
    assert.match(empty.body, /No jobs match these filters/, 'an empty filtered result says so')
    assert.match(empty.body, /Failed/, 'the empty state names the active filter')
    assert.match(empty.body, /href="\/dashboard#jobs"/, 'the empty state offers one-click clear')

    const cleared = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.match(cleared.body, /data-job-id="job_s0"/, 'clearing restores the unfiltered list')
    assert.doesNotMatch(cleared.body, /No jobs match these filters/)
    const newer = cleared.body.indexOf('data-job-id="job_s2"')
    const older = cleared.body.indexOf('data-job-id="job_s0"')
    assert.ok(newer !== -1 && older !== -1 && newer < older, 'the page is ordered newest first, so job_s2 precedes job_s0')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('applying a filter keeps the 30-day window it was set in', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'filters-window', status: 'approved' })
    const cookie = `${sessionFor(built, user).cookie}; fledge_lang=en`
    const repo = store.createRepo({ id: 'repo_w', userId: user.id, owner: 'o', name: 'w', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    makeJobs(store, user.id, repo.id, 'w', 11, 'failed')

    const wide = await built.app.inject({ method: 'GET', url: '/dashboard?window=30&status=failed', headers: { cookie } })
    assert.match(wide.body, /<input type="hidden" name="window" value="30" \/>/, 'the filter form carries the window it is applied in')
    assert.match(wide.body, /window=30/, 'pagination keeps the window as well')

    const narrow = await built.app.inject({ method: 'GET', url: '/dashboard?status=failed', headers: { cookie } })
    assert.doesNotMatch(narrow.body, /name="window" value="30"/, 'the default 7-day view adds no parameter')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('the kind filter offers every job kind the runner can start, and nothing else', async () => {
  // The kinds a job can have are the JobKind union in `src/jobs/runner.ts`:
  // iterate, review, plan, scope, verify. A filter list that is a second, stale
  // copy of that union silently hides the jobs a user wants to find — `scope`
  // and `verify` are started by the work-item buttons — and offers a kind no job
  // can have.
  assert.deepEqual([...JOB_FILTER_KINDS].sort(), ['iterate', 'plan', 'review', 'scope', 'verify'], 'the filter list is the JobKind union')

  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'filters-kinds', status: 'approved' })
    const cookie = `${sessionFor(built, user).cookie}; fledge_lang=en`
    const repo = store.createRepo({ id: 'repo_k', userId: user.id, owner: 'o', name: 'k', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    makeJobs(store, user.id, repo.id, 'scope', 2, 'succeeded', 'scope')
    makeJobs(store, user.id, repo.id, 'verify', 2, 'succeeded', 'verify')
    makeJobs(store, user.id, repo.id, 'iter', 2, 'succeeded', 'iterate')

    const page = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    for (const kind of ['iterate', 'review', 'plan', 'scope', 'verify']) {
      assert.match(page.body, new RegExp(`<option value="${kind}"`), `the form offers ${kind}`)
    }
    assert.doesNotMatch(page.body, /<option value="research"/, 'the form offers no kind a job cannot have')

    const scope = await built.app.inject({ method: 'GET', url: '/dashboard?kind=scope', headers: { cookie } })
    assert.equal((scope.body.match(/data-job-id="job_scope/g) ?? []).length, 2, 'a scope job is filterable')
    assert.doesNotMatch(scope.body, /data-job-id="job_iter0"/, 'and the other kinds are not in the filtered page')

    const verify = await built.app.inject({ method: 'GET', url: '/dashboard?kind=verify', headers: { cookie } })
    assert.equal((verify.body.match(/data-job-id="job_verify/g) ?? []).length, 2, 'a verify job is filterable')

    assert.deepEqual(parseJobFilters({ kind: 'scope' }, [repo.id]), { repo: '', status: '', kind: 'scope' }, 'the parser keeps scope')
    assert.deepEqual(parseJobFilters({ kind: 'research' }, [repo.id]), { repo: '', status: '', kind: '' }, 'research is not a job kind, so it is dropped')
  } finally {
    await built.app.close()
    store.close()
  }
})
