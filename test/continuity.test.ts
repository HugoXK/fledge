import test from 'node:test'
import assert from 'node:assert/strict'
import type { JobRow, WorkItemRow } from '../src/db.js'
import { Store } from '../src/db.js'
import { buildCarryOver, carryOverHeaderFromGoal, CARRY_OVER_MAX_READS, parseCarryOverLink, type CarryOverLinkState } from '../src/jobs/continuity.js'
import { jobPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

function iso(offsetMs: number): string {
  return new Date(1_763_000_000_000 + offsetMs).toISOString()
}

function digest(overrides: { issue_url?: string | null; pr_url?: string | null }): string {
  return JSON.stringify({
    schema_version: 1,
    job_id: 'job_prev',
    kind: 'iterate',
    status: 'succeeded',
    output_kind: overrides.pr_url ? 'pr' : 'issue',
    started_at: iso(-3_600_000),
    finished_at: iso(-3_000_000),
    summary: 'did the thing',
    issue_url: overrides.issue_url ?? null,
    pr_url: overrides.pr_url ?? null,
    work_item_id: null,
  })
}

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: 'job_1', repo_id: 'repo_1', user_id: 'usr_1', status: 'succeeded',
    trigger: 'schedule', goal: 'fix bugs', branch: null, base_branch: 'main',
    pr_url: null, summary: 'did a thing', error: null, cost_usd: 0,
    platform_token_hash: null, callback_hash: 'h', kind: 'iterate',
    issue_url: null, pr_state: null, review_score: null,
    attribution_json: null, evidence_json: null, checkpoint: null,
    team_stats_json: null, work_item_id: null, priority: 0,
    plan_approved_at: null, plan_approved_by: null, plan_rejected_at: null,
    plan_allow_paths: null, plan_deny_paths: null, base_sha: null,
    callback_fingerprint: null, path_guard_json: null,
    verification_json: null, continuity_json: null, output_kind: null,
    continuity_used: 0, retry_attempt: 0, retry_of: null,
    created_at: iso(-3_600_000), started_at: iso(-3_000_000),
    last_callback_at: null, finished_at: iso(-2_400_000), ...overrides,
  } as JobRow
}

function workItem(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
  return {
    id: 'work_1', repo_id: 'repo_1', user_id: 'usr_1', title: 'fix the thing',
    detail: '', issue_url: null, pr_url: null,
    state: 'triaged', closed_reason: null, priority: 0, assignee_user_id: null, job_id: null,
    pr_state: null, merged_at: null, merge_commit: null,
    created_at: iso(-3_600_000), updated_at: iso(-3_600_000), ...overrides,
  }
}

//: A reader that answers from a table and records every link it was asked
//: about, so the seven-read ceiling is asserted rather than described.
function reader(states: Record<string, CarryOverLinkState | 'throw'>): { read: (link: string) => Promise<CarryOverLinkState>; reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    read: async (link: string) => {
      reads.push(link)
      const state = states[link]
      if (state === undefined || state === 'throw') throw new Error('cannot read')
      return state
    },
  }
}

test('a merged pull request is dropped and counted, an open issue is carried', async () => {
  const openIssue = 'https://github.com/octo/demo/issues/42'
  const mergedPr = 'https://github.com/octo/demo/pull/43'
  const read = reader({ [openIssue]: 'open', [mergedPr]: 'merged' })
  const block = await buildCarryOver({
    recent: [
      job({ id: 'job_open', continuity_json: digest({ issue_url: openIssue }), issue_url: openIssue }),
      job({ id: 'job_merged', continuity_json: digest({ pr_url: mergedPr }), pr_url: mergedPr }),
    ],
    read,
  })
  assert.equal(block.report.used, 1)
  assert.equal(block.report.dropped, 1)
  assert.deepEqual(block.report.droppedLinks, [mergedPr])
  // The dropped line is gone from the text, not merely counted.
  assert.doesNotMatch(block.text, /pull\/43/)
  assert.match(block.text, /issues\/42/)
  // Asserted exactly: the page and the prompt share one spelling.
  assert.match(block.text, /^carry-over: 1 used, 1 dropped \(closed\/merged\)$/m)
  // One read per line, no second read for the line that was kept.
  assert.deepEqual(read.reads, [openIssue, mergedPr])
})

test('a failed read keeps the line and counts it unverified, never dropped', async () => {
  const issue = 'https://github.com/octo/demo/issues/7'
  const block = await buildCarryOver({
    recent: [job({ id: 'job_unknown', continuity_json: digest({ issue_url: issue }), issue_url: issue })],
    read: reader({ [issue]: 'throw' }),
  })
  assert.equal(block.report.used, 1)
  assert.equal(block.report.dropped, 0)
  assert.equal(block.report.unverified, 1)
  assert.deepEqual(block.report.unverifiedLinks, [issue])
  assert.match(block.text, /issues\/7/)
  assert.match(block.text, /^carry-over: 1 used, 0 dropped \(closed\/merged\), 1 unverified$/m)
})

test('a work item with no link is kept and never counted as dropped', async () => {
  const read = reader({})
  const block = await buildCarryOver({
    openWork: [workItem({ id: 'work_bare', title: 'no link anywhere' })],
    read,
  })
  assert.equal(block.report.used, 1)
  assert.equal(block.report.dropped, 0)
  assert.equal(block.report.unverified, 0)
  assert.equal(block.report.reads, 0)
  assert.deepEqual(read.reads, [])
  assert.match(block.text, /work_bare state=triaged/)
  assert.match(block.text, /^carry-over: 1 used, 0 dropped \(closed\/merged\)$/m)
})

test('the block spends at most seven reads and never reads one link twice', async () => {
  const shared = 'https://github.com/octo/demo/issues/1'
  const states: Record<string, CarryOverLinkState> = { [shared]: 'open' }
  const recent = [0, 1, 2].map((index) => {
    const link = `https://github.com/octo/demo/pull/${100 + index}`
    states[link] = 'open'
    return job({ id: `job_${index}`, continuity_json: digest({ pr_url: link }), pr_url: link })
  })
  const work = [0, 1, 2, 3].map((index) => workItem({
    id: `work_${index}`,
    issue_url: index === 0 ? shared : `https://github.com/octo/demo/issues/${200 + index}`,
  }))
  for (const item of work) {
    if (item.issue_url !== null && states[item.issue_url] === undefined) states[item.issue_url] = 'open'
  }
  const read = reader(states)
  await buildCarryOver({ recent, openWork: work, read })
  // 3 digests + 4 work items, one link each; the shared issue costs one read.
  assert.equal(read.reads.length, 7)
  assert.equal(new Set(read.reads).size, 7)
  assert.equal(CARRY_OVER_MAX_READS, 7)
})

test('a link is parsed only when it is one issue or pull request URL', () => {
  assert.deepEqual(parseCarryOverLink('https://github.com/octo/demo/issues/42'), { owner: 'octo', name: 'demo', kind: 'issue', number: 42 })
  assert.deepEqual(parseCarryOverLink('https://github.com/octo/demo/pull/43/files'), { owner: 'octo', name: 'demo', kind: 'pull', number: 43 })
  assert.equal(parseCarryOverLink('https://github.com/octo/demo/commit/abc123'), null)
  assert.equal(parseCarryOverLink('https://github.com/octo/demo/issues/42/../../other'), null)
  assert.equal(parseCarryOverLink('not a link'), null)
})

test('with no reader the block claims no counts at all', async () => {
  const block = await buildCarryOver({ recent: [job({ id: 'job_a', continuity_json: digest({ issue_url: 'https://github.com/octo/demo/issues/9' }) })] })
  assert.equal(carryOverHeaderFromGoal(block.text), '')
  assert.match(block.text, /not a new goal/)
})

test('the job page shows the carry-over line only for a job that carried one', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_page', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    const carried = job({
      id: 'job_page_carried',
      goal: `fix bugs\n\n[Carry-over - auto-generated state, not a new goal]\ncarry-over: 1 used, 1 dropped (closed/merged)\nOpen work:\n- work_1 state=triaged`,
      continuity_used: 1,
    })
    const plain = job({ id: 'job_page_plain', goal: 'fix bugs', continuity_used: 1 })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const carriedHtml = jobPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, job: carried, events: [] })
    const plainHtml = jobPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, job: plain, events: [] })
    assert.match(carriedHtml, /data-carry-over>carry-over: 1 used, 1 dropped \(closed\/merged\)</)
    assert.doesNotMatch(plainHtml, /data-carry-over/)
  } finally {
    store.close()
  }
})
