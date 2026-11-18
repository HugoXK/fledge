import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JobRow, WorkItemRow } from '../src/db.js'
import { Store } from '../src/db.js'
import { buildCarryOver, carryOverHeaderFromBlock, carryOverHeaderText, CARRY_OVER_MAX_READS, parseCarryOverLink, parseCarryOverReport, type CarryOverLinkState } from '../src/jobs/continuity.js'
import { Jobs } from '../src/jobs/service.js'
import type { RunnerContext } from '../src/jobs/runner.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { jobPage } from '../src/views/pages.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

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
    continuity_used: 0, carry_over_json: null, retry_attempt: 0, retry_of: null,
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
  // A work item with no link has nothing to observe, so the line claims no state:
  // the row's own state is no evidence about the artifact.
  assert.match(block.text, /- work_bare priority=0/)
  assert.doesNotMatch(block.text, /work_bare state=/)
  assert.match(block.text, /^carry-over: 1 used, 0 dropped \(closed\/merged\), 1 unlinked \(no link\)$/m)
})

// #790: slice 4 of #365. `used` counted an unlinked line exactly like a line
// whose artifact was observed live, and the one continuation instruction offered
// it to the agent. The line is still carried - it is context - but it now says
// so: in its own label, its own count and the instruction.
test('an unlinked carry-over line is labelled unverified (no link) and is not a continuation instruction', async () => {
  const read = reader({})
  const block = await buildCarryOver({
    recent: [job({ id: 'job_digest', continuity_json: digest({}) })],
    openWork: [workItem({ id: 'work_bare', title: 'no link anywhere' })],
    read,
  })
  // Still carried, never dropped, and an unlinked line still costs no read.
  assert.equal(block.report.used, 2)
  assert.equal(block.report.dropped, 0)
  assert.equal(block.report.unlinked, 2)
  assert.equal(block.report.reads, 0)
  assert.deepEqual(read.reads, [])
  // Both lines carry the label, so neither reads like an observed artifact.
  // Two line labels; the instruction line also names the marker, so anchor.
  assert.equal((block.text.match(/ unverified \(no link\)$/gm) ?? []).length, 2)
  assert.match(block.text, /- work_bare .*unverified \(no link\)/)
  // The count reaches the header the page reads, without a second spelling.
  assert.match(block.text, /^carry-over: 2 used, 0 dropped \(closed\/merged\), 2 unlinked \(no link\)$/m)
  // The instruction no longer offers an unlinked line as continuable.
  assert.doesNotMatch(block.text, /^Continue the open work item when one exists; do not create a duplicate issue\/PR\.$/m)
  assert.match(block.text, /context, not a continuation instruction/)
})

test('a stored report written before the unlinked count reads back as zero, never as absent', () => {
  const before = JSON.stringify({ used: 1, dropped: 0, unverified: 0, reads: 0, droppedLinks: [], unverifiedLinks: [], observations: [], items: [] })
  assert.equal(parseCarryOverReport(before)?.unlinked, 0)
  const after = parseCarryOverReport(JSON.stringify({ used: 2, dropped: 0, unverified: 0, unlinked: 2, reads: 0, droppedLinks: [], unverifiedLinks: [], observations: [], items: [] }))
  assert.equal(after?.unlinked, 2)
  assert.equal(carryOverHeaderText(after!), 'carry-over: 2 used, 0 dropped (closed/merged), 2 unlinked (no link)')
  // A report with no unlinked line keeps the pre-#790 spelling exactly.
  assert.equal(carryOverHeaderText({ used: 1, dropped: 0, unverified: 0, unlinked: 0, reads: 0, droppedLinks: [], unverifiedLinks: [], observations: [], items: [] }), 'carry-over: 1 used, 0 dropped (closed/merged)')
})

test('the truncation marker is counted inside the cap, not added on top of it', async () => {
  const block = await buildCarryOver({
    recent: [job({ id: 'job_long', summary: 'a summary long enough that the block has to be cut', continuity_json: digest({}) })],
    openWork: [workItem({ id: 'work_long', title: 'a title long enough that the block has to be cut' })],
    maxChars: 260,
  })
  // The stated bound is the bound: marker included, never two characters over.
  assert.ok(block.text.length <= 260, `block is ${String(block.text.length)} characters`)
  assert.match(block.text, /\[carry-over truncated\]$/)
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
  assert.equal(carryOverHeaderFromBlock(block.text), '')
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

// #791: the page lists what the block dropped instead of only counting it. The
// rows come from the stored report — the value the prompt's own header counts —
// so a maintainer can see which line went and why, and a `carry-over:` line the
// owner typed into the goal can no longer supply the header.
const CLOSED_ISSUE = 'https://github.com/octo/demo/issues/11'
const MERGED_PR = 'https://github.com/octo/demo/pull/12'
const FAILED_LINK = 'https://github.com/octo/demo/issues/13'

function pageReport(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    used: 1, dropped: 2, unverified: 0, reads: 3,
    droppedLinks: [CLOSED_ISSUE, MERGED_PR], unverifiedLinks: [],
    observations: [
      { link: CLOSED_ISSUE, state: 'closed', observedAt: OBSERVED_AT },
      { link: MERGED_PR, state: 'merged', observedAt: OBSERVED_AT },
    ],
    items: [
      { link: CLOSED_ISSUE, kind: 'dropped', reason: 'closed' },
      { link: MERGED_PR, kind: 'dropped', reason: 'merged' },
    ],
    ...overrides,
  })
}

// The row names its link: the code element is read out and compared exactly, so
// the assertion says the URL *is* the row's link instead of that the URL appears
// somewhere in the page (CodeQL's incomplete-url-substring check).
function rowLink(row: string): string | null {
  return /<code>([^<]*)<\/code>/.exec(row)?.[1] ?? null
}

function jobPageFor(jobOverrides: Partial<JobRow>): string {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_items', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    return jobPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, job: job(jobOverrides), events: [] })
  } finally {
    store.close()
  }
}

test('the job page lists each dropped item with its link and reason from the stored report', () => {
  const html = jobPageFor({ id: 'job_items', goal: 'fix bugs', continuity_used: 1, carry_over_json: pageReport() })
  // It does not stop at the count line.
  assert.match(html, /data-carry-over>carry-over: 1 used, 2 dropped \(closed\/merged\)</)
  const rows = html.split('data-carry-over-item data-kind').slice(1)
  assert.equal(rows.length, 2, 'two dropped items render two rows, not a single count')
  assert.equal(rowLink(rows[0]!), CLOSED_ISSUE, 'the closed issue row names its link')
  assert.match(rows[0]!, /Closed issue/, 'the closed issue row names its reason')
  assert.equal(rowLink(rows[1]!), MERGED_PR, 'the merged pull request row names its link')
  assert.match(rows[1]!, /Merged pull request/, 'the merged pull request row names its reason')
})

test('the page names the class of an unverified item it could not read', () => {
  const html = jobPageFor({
    id: 'job_unverified',
    goal: 'fix bugs',
    continuity_used: 1,
    carry_over_json: pageReport({
      dropped: 0, unverified: 1, droppedLinks: [], unverifiedLinks: [FAILED_LINK],
      observations: [{ link: FAILED_LINK, state: 'unverified', observedAt: null }],
      items: [{ link: FAILED_LINK, kind: 'unverified', reason: 'failed read' }],
    }),
  })
  const rows = html.split('data-carry-over-item data-kind').slice(1)
  assert.equal(rows.length, 1, 'the unverified item is listed, not only counted')
  assert.equal(rowLink(rows[0]!), FAILED_LINK, 'the unverified row names its link')
  assert.match(rows[0]!, /Read failed/, 'the unverified row names the class of the failure')
})

test('a report written before the item list still lists what it dropped', () => {
  const html = jobPageFor({ id: 'job_old_report', goal: 'fix bugs', continuity_used: 1, carry_over_json: pageReport({ items: [] }) })
  const rows = html.split('data-carry-over-item data-kind').slice(1)
  assert.equal(rows.length, 2, 'the stored links and observations still render rows')
  assert.equal(rowLink(rows[0]!), CLOSED_ISSUE, 'the old row names its link')
  assert.match(rows[0]!, /Closed issue/, 'the observation supplies the recorded reason')
  assert.match(rows[1]!, /Merged pull request/, 'a merged pull request keeps its own reason')
})

test('the header comes from the generated marker line, never from the owner-written goal', () => {
  const typed = [
    'carry-over: 0 used, 0 dropped (closed/merged)',
    'fix the bug',
    '',
    '[Carry-over - auto-generated state, not a new goal]',
    'carry-over: 3 used, 1 dropped (closed/merged)',
    'Open work:',
    '- work_1 state=triaged',
  ].join('\n')
  const html = jobPageFor({ id: 'job_typed_header', goal: typed, continuity_used: 1 })
  assert.match(html, /data-carry-over>carry-over: 3 used, 1 dropped \(closed\/merged\)</)
  assert.doesNotMatch(html, /data-carry-over>carry-over: 0 used/)
})

test('a job that carried nothing renders no carry-over section at all', () => {
  const html = jobPageFor({
    id: 'job_pre_carry',
    goal: 'carry-over: 0 used, 0 dropped (closed/merged)',
    continuity_used: 0,
    carry_over_json: pageReport(),
  })
  assert.doesNotMatch(html, /data-carry-over/)
  assert.doesNotMatch(html, /data-carry-over-item/)
})

// #788: an observation is a fact about a moment. These cases pin the moment, so
// a line can state what was seen and when, and the page can say plainly when
// nothing was.
const OBSERVED_AT = '2026-11-16T07:12:44.000Z'

test('a carried line states when its live state was observed, and the report keeps it per link', async () => {
  const issue = 'https://github.com/octo/demo/issues/42'
  const read = reader({ [issue]: 'open' })
  const block = await buildCarryOver({
    recent: [job({ id: 'job_open', continuity_json: digest({ issue_url: issue }), issue_url: issue })],
    openWork: [workItem({ id: 'work_open', issue_url: issue })],
    read,
    now: () => OBSERVED_AT,
  })
  // The line names the time and the state the read returned, not the row's own.
  assert.match(block.text, /observed 07:12Z open/)
  assert.doesNotMatch(block.text, /observed 07:12Z triaged/)
  assert.deepEqual(block.report.observations, [{ link: issue, state: 'open', observedAt: OBSERVED_AT }])
  // The observation costs no second read: one link, one read, two lines.
  assert.deepEqual(read.reads, [issue])
})

test('a failed read is carried as unverified and states no observation time', async () => {
  const issue = 'https://github.com/octo/demo/issues/7'
  const block = await buildCarryOver({
    recent: [job({ id: 'job_unknown', continuity_json: digest({ issue_url: issue }), issue_url: issue })],
    read: reader({ [issue]: 'throw' }),
    now: () => OBSERVED_AT,
  })
  assert.deepEqual(block.report.observations, [{ link: issue, state: 'unverified', observedAt: null }])
  assert.match(block.text, /observed unverified/)
  assert.doesNotMatch(block.text, /observed 07:12Z/)
})

test('a pull request closed without merging is dropped as closed, not carried as open', async () => {
  const pr = 'https://github.com/octo/demo/pull/43'
  const block = await buildCarryOver({
    recent: [job({ id: 'job_closed', continuity_json: digest({ pr_url: pr }), pr_url: pr })],
    read: reader({ [pr]: 'closed' }),
    now: () => OBSERVED_AT,
  })
  assert.equal(block.report.dropped, 1)
  assert.deepEqual(block.report.droppedLinks, [pr])
  assert.match(block.text, /^carry-over: 0 used, 1 dropped \(closed\/merged\)$/m)
  assert.doesNotMatch(block.text, /pull\/43/)
})

test('a scheduled run persists the observation it read, closed and merged alike', async () => {
  const closedPr = 'https://github.com/octo/demo/pull/43'
  const mergedPr = 'https://github.com/octo/demo/pull/44'
  const requested: string[] = []
  const github = await startFakeServer((request, response) => {
    requested.push(request.url ?? '')
    if ((request.url ?? '').startsWith('/repos/octo/demo/pulls/43')) {
      return json(response, 200, {
        number: 43, html_url: closedPr, title: 'the closed one', state: 'closed',
        head: { ref: 'branch', sha: 'sha-head' }, base: { ref: 'main' },
        mergeable: true, mergeable_state: 'clean', draft: false, merged: false,
      })
    }
    if ((request.url ?? '').startsWith('/repos/octo/demo/pulls/44')) {
      return json(response, 200, {
        number: 44, html_url: mergedPr, title: 'the merged one', state: 'closed',
        head: { ref: 'branch', sha: 'sha-head' }, base: { ref: 'main' },
        mergeable: true, mergeable_state: 'clean', draft: false, merged: true,
      })
    }
    return json(response, 404, { message: 'Not Found' })
  })
  const config = testConfig({ github: { ...testConfig().github, apiBase: github.url } })
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const jobs = new Jobs(store, config, { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'observation-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_observation', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin',
      repoRole: 'maintainer', goal: 'fix bugs', autoIterate: false, intervalMinutes: 1440,
    })
    store.createWorkItem({ id: 'work_closed', repoId: repo.id, userId: user.id, title: 'the closed one', prUrl: closedPr, state: 'triaged' })
    store.createWorkItem({ id: 'work_merged', repoId: repo.id, userId: user.id, title: 'the merged one', prUrl: mergedPr, state: 'triaged' })
    const result = await jobs.enqueue(repo, 'schedule', undefined, 'iterate')
    assert.equal(result.ok, true)
    assert.deepEqual([...requested].sort(), ['/repos/octo/demo/pulls/43', '/repos/octo/demo/pulls/44'])
    const stored = store.getJob(result.job!.id)!
    assert.equal(stored.continuity_used, 1)
    const report = JSON.parse(stored.carry_over_json ?? 'null') as { observations?: Array<{ link: string; state: string; observedAt: string | null }> }
    const observed = report.observations?.map((entry) => ({ link: entry.link, state: entry.state })) ?? []
    // Closed-without-merge is `closed`, merged is `merged`: neither is `open`,
    // and both are recorded with the moment they were seen.
    assert.deepEqual(observed.sort((a, b) => a.link.localeCompare(b.link)), [
      { link: closedPr, state: 'closed' },
      { link: mergedPr, state: 'merged' },
    ])
    for (const entry of report.observations ?? []) {
      assert.match(entry.observedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    // Both are finished, so neither is carried into the prompt.
    assert.doesNotMatch(contexts[0]?.goal ?? '', /pull\/4[34]/)
  } finally {
    store.close()
    await github.close()
  }
})

test('the job page shows the persisted observation, and says not observed when the row predates it', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_page_observation', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    const link = 'https://github.com/octo/demo/issues/42'
    const carriedGoal = `fix bugs\n\n[Carry-over - auto-generated state, not a new goal]\ncarry-over: 1 used, 0 dropped (closed/merged)\nOpen work:\n- work_1 state=triaged`
    const observed = job({
      id: 'job_page_observed',
      goal: carriedGoal,
      continuity_used: 1,
      carry_over_json: JSON.stringify({
        used: 1, dropped: 0, unverified: 0, reads: 1, droppedLinks: [], unverifiedLinks: [],
        observations: [{ link, state: 'open', observedAt: OBSERVED_AT }],
      }),
    })
    const legacy = job({ id: 'job_page_legacy', goal: carriedGoal, continuity_used: 1, carry_over_json: null })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const observedHtml = jobPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, job: observed, events: [] })
    const legacyHtml = jobPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, job: legacy, events: [] })
    // The stored observation is rendered, with its time, and the link it belongs to.
    assert.match(observedHtml, /data-carry-over-observation/)
    assert.match(observedHtml, /07:12Z open/)
    assert.match(observedHtml, /issues\/42/)
    // A row written before the column says so instead of showing a borrowed time.
    assert.match(legacyHtml, /data-carry-over-observation/)
    assert.match(legacyHtml, /Observation not recorded/)
    assert.doesNotMatch(legacyHtml, /07:12Z/)
    // A job that carried nothing still shows nothing.
    const plain = job({ id: 'job_page_plain_2', goal: 'fix bugs', continuity_used: 0, carry_over_json: null })
    const plainHtml = jobPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, job: plain, events: [] })
    assert.doesNotMatch(plainHtml, /data-carry-over/)
  } finally {
    store.close()
  }
})

test('a database written before the observation column opens and reads back as not recorded', () => {
  // #788: the column is additive. A file created before it must still open, and
  // the page must say the observation was never recorded rather than fail.
  const dir = mkdtempSync(join(tmpdir(), 'fledge-observation-'))
  const path = join(dir, 'fledge.db')
  try {
    const store = new Store(path)
    const user = makeUser(store)
    const repo = store.createRepo({
      id: 'repo_observation_migrate', userId: user.id, owner: 'octo', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: 'fix bugs',
      autoIterate: false, intervalMinutes: 1440,
    })
    const goal = 'fix bugs\n\n[Carry-over - auto-generated state, not a new goal]\ncarry-over: 1 used, 0 dropped (closed/merged)'
    store.createJob({ id: 'job_observation_old', repoId: repo.id, userId: user.id, trigger: 'schedule', goal, callbackHash: 'h', platformTokenHash: '' })
    store.updateJob('job_observation_old', { continuity_used: 1 })
    store.db.exec('ALTER TABLE jobs DROP COLUMN carry_over_json')
    store.close()

    const reopened = new Store(path)
    try {
      const row = reopened.getJob('job_observation_old')!
      assert.equal(row.carry_over_json, null)
      const html = jobPage({
        config: testConfig(), locale: 'en',
        viewer: { user: reopened.userById(user.id)!, csrfToken: 'csrf' },
        repo: reopened.getRepo(repo.id)!, job: row, events: [],
      })
      assert.match(html, /Observation not recorded/)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
