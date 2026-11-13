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

// #285: the filter is the URL, so every control on `/dashboard` may change only
// its own parameter. Three of the five links rebuilt the query from scratch and
// silently dropped the other half: the window buttons lost the filter, both
// "Clear filters" links lost the window, and the repository pager lost both.
// The href is the cause, so each case asserts the query keys; the rendered list
// and the selected values are the symptom a maintainer actually sees.
interface DashboardLink {
  href: string
  label: string
  hash: string
  params: URLSearchParams
}

/** Every `/dashboard` anchor in rendered HTML, with its plain-text label and parsed query. */
function dashboardLinks(html: string): DashboardLink[] {
  const links: DashboardLink[] = []
  // Every label this test selects by is plain text between the tags, so the
  // capture group stops at the next `<` and nothing is stripped afterwards: a
  // sanitize-looking helper in an assertion is its own defect, and an earlier
  // version of this line raised a CodeQL high result (incomplete multi-character
  // sanitization) on this file.
  const pattern = /<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)</g
  let match = pattern.exec(html)
  while (match !== null) {
    const href = match[1] ?? ''
    const label = (match[2] ?? '').trim()
    match = pattern.exec(html)
    if (!href.startsWith('/dashboard')) continue
    const hashAt = href.indexOf('#')
    const withoutHash = hashAt === -1 ? href : href.slice(0, hashAt)
    const queryAt = withoutHash.indexOf('?')
    const query = queryAt === -1 ? '' : withoutHash.slice(queryAt + 1)
    links.push({ href, label, hash: hashAt === -1 ? '' : href.slice(hashAt), params: dashboardQuery(query) })
  }
  return links
}

/**
 * The href is HTML-escaped, so the query separator arrives as `&amp;`. Split on
 * that entity instead of unescaping the string: no character sequence is
 * rewritten, and every value is still read back as data.
 */
function dashboardQuery(query: string): URLSearchParams {
  const params = new URLSearchParams()
  for (const pair of query.split('&amp;')) {
    const at = pair.indexOf('=')
    if (at === -1) continue
    params.set(pair.slice(0, at), decodeURIComponent(pair.slice(at + 1)))
  }
  return params
}

test('every dashboard control keeps the state it is not changing', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'filters-links', status: 'approved' })
    const cookie = `${sessionFor(built, user).cookie}; fledge_lang=en`
    // Twelve repositories so the repository table has a second page, and twelve
    // matching jobs so the jobs pager renders too: a pager that is absent cannot
    // be asserted about.
    const ids: string[] = []
    for (let index = 0; index < 12; index += 1) {
      const id = `repo_${String(index).padStart(2, '0')}`
      store.createRepo({ id, userId: user.id, owner: 'o', name: `n${index}`, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: false, intervalMinutes: 1440 })
      ids.push(id)
    }
    const repoA = ids[0] ?? ''
    const repoB = ids[1] ?? ''
    makeJobs(store, user.id, repoA, 'f', 12, 'failed', 'iterate')
    makeJobs(store, user.id, repoB, 's', 3, 'succeeded', 'iterate')

    const filteredUrl = `/dashboard?repo=${repoA}&status=failed&kind=iterate&window=30`
    const filtered = await built.app.inject({ method: 'GET', url: filteredUrl, headers: { cookie } })
    assert.equal(filtered.statusCode, 200)
    // The symptom, not only the cause: the list and the selects agree with the URL.
    assert.equal((filtered.body.match(/data-job-id="job_f/g) ?? []).length, 10, 'the filter fills the first page of jobs')
    assert.match(filtered.body, new RegExp(`<option value="${repoA}" selected>`), 'the repository select shows the filter')
    assert.match(filtered.body, /<option value="failed" selected>/, 'the status select shows the filter')
    assert.match(filtered.body, /<option value="iterate" selected>/, 'the kind select shows the filter')

    const links = dashboardLinks(filtered.body)

    // The window buttons are selected by label: the fix adds keys to their hrefs,
    // so a selector keyed on "a query whose only key is window" would match
    // nothing on the fixed page and pass over zero elements.
    const windowButtons = links.filter((link) => link.label === '7 days' || link.label === '30 days')
    assert.equal(windowButtons.length, 2, 'the page offers exactly the two window buttons')
    const seven = windowButtons.find((link) => link.label === '7 days')
    const thirty = windowButtons.find((link) => link.label === '30 days')
    assert.equal(seven?.params.get('window'), '7', 'the 7-day button switches only the window')
    assert.equal(thirty?.params.get('window'), '30', 'the 30-day button switches only the window')
    for (const link of windowButtons) {
      assert.equal(link.params.get('repo'), repoA, 'a window switch keeps the repository filter')
      assert.equal(link.params.get('status'), 'failed', 'a window switch keeps the status filter')
      assert.equal(link.params.get('kind'), 'iterate', 'a window switch keeps the kind filter')
    }

    // Both pagers: the repository pager must keep the window and the filter, and
    // the jobs pager is the positive control that already did. They are told
    // apart by their hash because each carries the other's page key.
    const pagers = links.filter((link) => link.params.has('reposPage') || link.params.has('jobsPage'))
    assert.equal(pagers.length, 2, 'both pagers render with one page link each')
    for (const link of pagers) {
      assert.equal(link.params.get('window'), '30', 'paging keeps the 30-day window')
      assert.equal(link.params.get('repo'), repoA, 'paging keeps the repository filter')
      assert.equal(link.params.get('status'), 'failed', 'paging keeps the status filter')
      assert.equal(link.params.get('kind'), 'iterate', 'paging keeps the kind filter')
    }
    assert.equal(pagers.filter((link) => link.hash === '#add-repo').length, 1, 'the repository table has its pager')
    assert.equal(pagers.filter((link) => link.hash === '#jobs').length, 1, 'the job table has its pager')

    // The "Clear filters" link on a filtered list must still drop the filter and
    // keep the window. Exactly one renders here: the form's.
    const clearOnFiltered = links.filter((link) => link.label === 'Clear filters')
    assert.equal(clearOnFiltered.length, 1, 'a filtered, non-empty list offers one clear link')
    assert.equal(clearOnFiltered[0]?.params.get('window'), '30', 'clearing the filter keeps the 30-day window')
    assert.equal(clearOnFiltered[0]?.params.get('repo'), null, 'clearing the filter drops the filter')

    // The empty state offers its own clear link, and it renders only when the
    // filter matches nothing — so it needs its own request, or "every clear link
    // carries window=30" would pass on the form link alone.
    const empty = await built.app.inject({ method: 'GET', url: `/dashboard?repo=${repoB}&status=failed&window=30`, headers: { cookie } })
    assert.equal(empty.statusCode, 200)
    assert.match(empty.body, /No jobs match these filters/, 'the filter with no rows renders the empty state')
    const clearOnEmpty = dashboardLinks(empty.body).filter((link) => link.label === 'Clear filters')
    assert.equal(clearOnEmpty.length, 2, 'the empty state renders the form clear link and its own')
    for (const link of clearOnEmpty) {
      assert.equal(link.params.get('window'), '30', 'both clear links keep the 30-day window')
      assert.equal(link.params.get('repo'), null, 'clear filters drops the filter it clears')
    }

    // Explicit exclusion: the navigation landing link is a fresh start, not a
    // state-carrying control, and it must stay bare.
    const bare = links.filter((link) => link.href === '/dashboard')
    assert.equal(bare.length, 1, 'the only state-free dashboard link is the navigation landing')
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

test('the kind filter offers every job kind a user can start, and nothing else', async () => {
  // A filter list that is a second, stale copy of the kinds silently hides the
  // jobs a user wants to find — `scope` and `verify` are started by the
  // work-item buttons, `triage` by the repository page — and offers a kind no
  // job can have. `discover` is the one kind left out on purpose: an account
  // never starts one by hand.
  assert.deepEqual([...JOB_FILTER_KINDS].sort(), ['iterate', 'plan', 'review', 'scope', 'triage', 'verify'], 'the filter list is the startable job kinds')

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
    store.createJob({ id: 'job_triage_a', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'triage', callbackHash: 'cb-triage', platformTokenHash: '', kind: 'triage', workType: 'triage' })
    store.updateJob('job_triage_a', { status: 'succeeded', finished_at: new Date().toISOString() })

    const page = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    for (const kind of ['iterate', 'review', 'plan', 'scope', 'verify', 'triage']) {
      assert.match(page.body, new RegExp(`<option value="${kind}"`), `the form offers ${kind}`)
    }
    assert.doesNotMatch(page.body, /<option value="research"/, 'the form offers no kind a job cannot have')

    const scope = await built.app.inject({ method: 'GET', url: '/dashboard?kind=scope', headers: { cookie } })
    assert.equal((scope.body.match(/data-job-id="job_scope/g) ?? []).length, 2, 'a scope job is filterable')
    assert.doesNotMatch(scope.body, /data-job-id="job_iter0"/, 'and the other kinds are not in the filtered page')

    const verify = await built.app.inject({ method: 'GET', url: '/dashboard?kind=verify', headers: { cookie } })
    assert.equal((verify.body.match(/data-job-id="job_verify/g) ?? []).length, 2, 'a verify job is filterable')

    const triage = await built.app.inject({ method: 'GET', url: '/dashboard?kind=triage', headers: { cookie } })
    assert.equal((triage.body.match(/data-job-id="job_triage_a"/g) ?? []).length, 1, 'a triage job is filterable')
    assert.doesNotMatch(triage.body, /data-job-id="job_iter0"/, 'and no other kind leaks into the triage page')

    const search = await built.app.inject({ method: 'GET', url: '/search?q=k', headers: { cookie } })
    assert.match(search.body, /<option value="triage"/, 'the search form offers triage too')

    assert.deepEqual(parseJobFilters({ kind: 'scope' }, [repo.id]), { repo: '', status: '', kind: 'scope' }, 'the parser keeps scope')
    assert.deepEqual(parseJobFilters({ kind: 'triage' }, [repo.id]), { repo: '', status: '', kind: 'triage' }, 'the parser keeps triage')
    assert.deepEqual(parseJobFilters({ kind: 'research' }, [repo.id]), { repo: '', status: '', kind: '' }, 'research is not a job kind, so it is dropped')
  } finally {
    await built.app.close()
    store.close()
  }
})
