import test from 'node:test'
import assert from 'node:assert/strict'
import type { JobRow } from '../src/db.js'
import { Store } from '../src/db.js'
import { summariseDelta, summariseSince, type TemporalDelta } from '../src/lib/temporal.js'
import { jobPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #366 slice 1: one line of temporal context in the goal, built by a pure
// function so the wording is decided here and not by whatever the reads
// happened to return. The two rules the issue pins down are tested below:
// a first job says so and calls nothing, and a capped or failed read is marked
// `partial` instead of reporting the smaller number it did get.

function delta(overrides: Partial<TemporalDelta> = {}): TemporalDelta {
  return { sinceSha: '4f2c1a9e8d3b2a1c0f9e8d7c6b5a4f3e2d1c0b9a', status: 'ahead', aheadBy: 3, mergedPrs: [], complete: true, ...overrides }
}

test('a first job says there is no previous run', () => {
  const line = summariseDelta(delta({ sinceSha: null, aheadBy: 0, mergedPrs: [] }))
  assert.equal(line, 'Since: no previous run')
})

test('a delta names the short previous sha, the commit count and the merged PRs', () => {
  const line = summariseDelta(delta({ mergedPrs: [812, 815] }))
  assert.equal(line, 'Since 4f2c1a9: 3 commits ahead, 2 merged PRs (#812, #815)')
})

test('single commit and single pull request are written in the singular', () => {
  assert.equal(summariseDelta(delta({ aheadBy: 1, mergedPrs: [7] })), 'Since 4f2c1a9: 1 commit ahead, 1 merged PR (#7)')
})

test('no merged pull requests says zero rather than dropping the clause', () => {
  assert.equal(summariseDelta(delta({ aheadBy: 2, mergedPrs: [] })), 'Since 4f2c1a9: 2 commits ahead, 0 merged PRs')
})

// The central rule: a capped page walk or a failed read is reported as partial,
// never as the count that happened to fit in the pages we did read.
test('a capped merged-PR walk is marked partial and reports no count at all', () => {
  const line = summariseDelta(delta({ mergedPrs: [801, 803], complete: false }))
  assert.equal(line, 'Since 4f2c1a9: 3 commits ahead, merged PRs partial')
  assert.doesNotMatch(line, /\d+ merged PRs/)
  assert.doesNotMatch(line, /#/)
})

test('a failed compare is marked partial and does not claim the base is unchanged', () => {
  const line = summariseDelta(delta({ status: 'unknown', aheadBy: 0, mergedPrs: [], complete: true }))
  assert.equal(line, 'Since 4f2c1a9: delta unavailable (partial)')
})

test('an identical base says no new commits and still reports the merged PRs it saw', () => {
  assert.equal(summariseDelta(delta({ status: 'identical', aheadBy: 0 })), 'Since 4f2c1a9: no new commits, 0 merged PRs')
  assert.equal(
    summariseDelta(delta({ status: 'identical', aheadBy: 0, mergedPrs: [900] })),
    'Since 4f2c1a9: no new commits, 1 merged PR (#900)',
  )
})

test('a base that moved backwards or diverged is named, not called ahead', () => {
  assert.equal(summariseDelta(delta({ status: 'behind', aheadBy: 0 })), 'Since 4f2c1a9: base is behind the previous run, 0 merged PRs')
  assert.equal(
    summariseDelta(delta({ status: 'diverged', aheadBy: 0, mergedPrs: [1, 2] })),
    'Since 4f2c1a9: diverged from the previous run, 2 merged PRs (#1, #2)',
  )
})

test('pull request numbers are sorted, deduplicated and capped with an ellipsis', () => {
  const line = summariseDelta(delta({ aheadBy: 9, mergedPrs: [815, 803, 801, 812, 803, 820, 826] }))
  assert.equal(line, 'Since 4f2c1a9: 9 commits ahead, 6 merged PRs (#801, #803, #812, #815, #820, …)')
})

test('the line is one line and carries no newline', () => {
  const line = summariseSince(delta({ mergedPrs: [1] }).sinceSha)
  assert.equal(line, 'Since 4f2c1a9')
  assert.doesNotMatch(summariseDelta(delta({ mergedPrs: [1, 2, 3] })), /\n/)
})

test('the delta survives a store round trip and a job without one reads as null', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_temporal', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    const job = store.createJob({ id: 'job_temporal', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h', platformTokenHash: '' })
    assert.equal(job.temporal_json, null)
    const delta = { sinceSha: '4f2c1a9e8d3b2a1c0f9e8d7c6b5a4f3e2d1c0b9a', status: 'ahead' as const, aheadBy: 3, mergedPrs: [812, 815], complete: true }
    store.updateJob(job.id, { temporal_json: JSON.stringify(delta) })
    assert.deepEqual(JSON.parse(store.getJob(job.id)!.temporal_json!), delta)
  } finally {
    store.close()
  }
})

test('the job page shows the line for a stored delta and nothing for a missing or broken one', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_temporal_page', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    // One active job per repository is a partial unique index, so the previous
    // fixture has to finish before the next one exists.
    const make = (id: string, temporal: string | null): JobRow => {
      for (const older of store.listJobsForRepo(repo.id, 10)) {
        if (older.finished_at === null) store.updateJob(older.id, { status: 'succeeded', finished_at: new Date().toISOString() })
      }
      const created = store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'fix bugs', callbackHash: 'h', platformTokenHash: '' })
      if (temporal !== null) store.updateJob(id, { temporal_json: temporal })
      return store.getJob(created.id)!
    }
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const page = (job: JobRow): string => jobPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, job, events: [] })
    const withDelta = page(make('job_t_page', JSON.stringify({ sinceSha: '4f2c1a9e8d3b2a1c0f9e8d7c6b5a4f3e2d1c0b9a', status: 'ahead', aheadBy: 3, mergedPrs: [812, 815], complete: true })))
    assert.match(withDelta, /data-temporal>Since 4f2c1a9: 3 commits ahead, 2 merged PRs \(#812, #815\)</)
    assert.doesNotMatch(page(make('job_t_plain', null)), /data-temporal/)
    assert.doesNotMatch(page(make('job_t_broken', 'not json')), /data-temporal/)
  } finally {
    store.close()
  }
})

test('the store answers the newest finished base directly, not from a page of newest rows', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_temporal_query', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    assert.equal(store.latestFinishedBaseSha(repo.id), null)
    const older = store.createJob({ id: 'job_q_old', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'old', callbackHash: 'h', platformTokenHash: '', baseSha: 'a'.repeat(40), createdAt: '2026-11-01T00:00:00.000Z' })
    store.updateJob(older.id, { status: 'succeeded', finished_at: '2026-11-01T00:05:00.000Z' })
    const newer = store.createJob({ id: 'job_q_new', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'new', callbackHash: 'h', platformTokenHash: '', baseSha: 'b'.repeat(40), createdAt: '2026-11-02T00:00:00.000Z' })
    store.updateJob(newer.id, { status: 'succeeded', finished_at: '2026-11-02T00:05:00.000Z' })
    // A finished job with no recorded base is not an answer; the newest job that
    // did record one is.
    const unbased = store.createJob({ id: 'job_q_none', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'none', callbackHash: 'h', platformTokenHash: '', createdAt: '2026-11-03T00:00:00.000Z' })
    store.updateJob(unbased.id, { status: 'succeeded', finished_at: '2026-11-03T00:05:00.000Z' })
    assert.equal(store.latestFinishedBaseSha(repo.id), 'b'.repeat(40))
  } finally {
    store.close()
  }
})

test('a job superseded before it could run is not the previous run', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_temporal_superseded', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    // #839 gives a mention-replaced job a status and a finished_at even though it
    // never ran. Counting it as the previous run would print "N commits ahead"
    // for work that never happened, so a superseded row is not an answer.
    const replaced = store.createJob({ id: 'job_s_replaced', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'replaced', callbackHash: 'h', platformTokenHash: '', baseSha: 'c'.repeat(40), createdAt: '2026-11-04T00:00:00.000Z' })
    store.updateJob(replaced.id, { status: 'superseded', finished_at: '2026-11-04T00:05:00.000Z' })
    assert.equal(store.latestFinishedBaseSha(repo.id), null)
    // It does not hide a run that did happen either, even when it is newer: the
    // question is which finished run recorded a base, not which row finished last.
    const real = store.createJob({ id: 'job_s_real', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'real', callbackHash: 'h', platformTokenHash: '', baseSha: 'd'.repeat(40), createdAt: '2026-11-05T00:00:00.000Z' })
    store.updateJob(real.id, { status: 'succeeded', finished_at: '2026-11-05T00:05:00.000Z' })
    const replacedLater = store.createJob({ id: 'job_s_replaced_later', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'replaced later', callbackHash: 'h', platformTokenHash: '', baseSha: 'e'.repeat(40), createdAt: '2026-11-06T00:00:00.000Z' })
    store.updateJob(replacedLater.id, { status: 'superseded', finished_at: '2026-11-06T00:05:00.000Z' })
    assert.equal(store.latestFinishedBaseSha(repo.id), 'd'.repeat(40))
  } finally {
    store.close()
  }
})

test('a parsable but structurally wrong row renders no line at all', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_temporal_bad', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const render = (id: string, temporal: string): string => {
      for (const older of store.listJobsForRepo(repo.id, 10)) {
        if (older.finished_at === null) store.updateJob(older.id, { status: 'succeeded', finished_at: new Date().toISOString() })
      }
      store.createJob({ id, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'h', platformTokenHash: '' })
      store.updateJob(id, { temporal_json: temporal })
      return jobPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, job: store.getJob(id)!, events: [] })
    }
    // Parsable JSON that is missing the fields the line is built from: the page
    // must render nothing rather than `undefined commits ahead`.
    const malformed = render('job_bad_shape', JSON.stringify({ sinceSha: 'abc1234', status: 'ahead' }))
    assert.doesNotMatch(malformed, /data-temporal/)
    assert.doesNotMatch(malformed, /undefined/)
    const badStatus = render('job_bad_status', JSON.stringify({ sinceSha: 'abc1234', status: 'sideways', aheadBy: 1, mergedPrs: [], complete: true }))
    assert.doesNotMatch(badStatus, /data-temporal/)
  } finally {
    store.close()
  }
})
