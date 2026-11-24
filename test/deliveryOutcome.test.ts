import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Store } from '../src/db.js'
import { buildApp } from '../src/app.js'
import { followUpLinks, revertMatchOf, summariseDeliveries, type DeliveryOutcomeRow } from '../src/lib/deliveryOutcome.js'
import { RETENTION_CLASSES, retentionDefaultWindows } from '../scripts/lib/retention.mjs'
import { Jobs } from '../src/jobs/service.js'
import { MockRunner } from '../src/jobs/mock.js'
import { GithubClient } from '../src/repos/github.js'
import { quotaMoney } from '../src/views/layout.js'
import { repoPage } from '../src/views/pages.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// #371: Fledge records that a pull request merged, then forgets it. These cases
// pin the ledger the card asks for: one row per merged pull request, a revert
// counted once, follow-up links and post-merge failures counted once each, a
// windowed summary where a missing number is `—` and never a confident zero, and
// a retention class that deletes the row in the same run as the job it describes.

const MERGE_A = 'a'.repeat(40)
const MERGE_B = 'b'.repeat(40)
const REVERT_A = 'c'.repeat(40)

function receiver(store: Store, tag: string): { repoId: string; userId: string } {
  const user = makeUser(store, { login: `delivery-${tag}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_delivery_${tag}`, userId: user.id, owner: 'o', name: `delivery-${tag}`, defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  return { repoId: repo.id, userId: user.id }
}

function job(store: Store, repoId: string, userId: string, id: string, cost: number | null, finishedAt = new Date().toISOString()): void {
  store.createJob({
    id, repoId, userId, trigger: 'manual', goal: 'fix the adder', callbackHash: `cb-${id}`, platformTokenHash: '',
    kind: 'implement', baseBranch: 'main',
  })
  store.updateJob(id, { status: 'succeeded', finished_at: finishedAt, ...(cost === null ? {} : { cost_usd: cost }) })
}

test('a merged pull request becomes one outcome row and a replay adds nothing', () => {
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'row')
    job(store, repoId, userId, 'job_delivery_row', 1.5)
    const input = {
      repoId, jobId: 'job_delivery_row', prUrl: 'https://github.com/o/delivery-row/pull/1', mergeCommit: MERGE_A,
      mergedAt: '2026-11-18T10:00:00.000Z', title: 'fix the adder carry', costUsd: 1.5, model: 'v4.1', playbook: 'implement',
    }
    store.recordDeliveryOutcome(input)
    store.recordDeliveryOutcome(input)
    const rows = store.listDeliveryOutcomes(repoId, '2026-11-01T00:00:00.000Z')
    assert.equal(rows.length, 1, 'one row per merged pull request, not one per delivery of the event')
    assert.equal(rows[0]?.merge_commit, MERGE_A)
    assert.equal(rows[0]?.pr_url, input.prUrl)
    assert.equal(rows[0]?.reverted_at, null, 'a fresh merge is not a revert')
    assert.equal(rows[0]?.revert_commit, null)
    assert.equal(rows[0]?.cost_usd, 1.5)
    assert.equal(rows[0]?.follow_up_json, '[]', 'no link yet is an empty list, not a made-up count')
  } finally {
    store.close()
  }
})

test('a revert is recorded once even when the scan sees it twice', () => {
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'revert')
    job(store, repoId, userId, 'job_delivery_revert', 2)
    store.recordDeliveryOutcome({
      repoId, jobId: 'job_delivery_revert', prUrl: 'https://github.com/o/delivery-revert/pull/2', mergeCommit: MERGE_A,
      mergedAt: '2026-11-10T10:00:00.000Z', title: 'fix the adder carry', costUsd: 2, model: 'v4.1', playbook: 'implement',
    })
    const first = store.markDeliveryReverted({ repoId, mergeCommit: MERGE_A, revertCommit: REVERT_A, revertedAt: '2026-11-12T10:00:00.000Z' })
    const second = store.markDeliveryReverted({ repoId, mergeCommit: MERGE_A, revertCommit: REVERT_A, revertedAt: '2026-11-13T10:00:00.000Z' })
    assert.equal(first, true)
    assert.equal(second, false, 'the second sighting changes nothing')
    const row = store.listDeliveryOutcomes(repoId, '2026-11-01T00:00:00.000Z')[0]
    assert.equal(row?.reverted_at, '2026-11-12T10:00:00.000Z', 'the first sighting keeps its own instant')
    assert.equal(row?.revert_commit, REVERT_A)
    assert.equal(summariseDeliveries(store.listDeliveryOutcomes(repoId, '2026-11-01T00:00:00.000Z')).reverted, 1)
  } finally {
    store.close()
  }
})

test('a follow-up link and a post-merge failure are counted once per fact', () => {
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'facts')
    job(store, repoId, userId, 'job_delivery_facts', 3)
    store.recordDeliveryOutcome({
      repoId, jobId: 'job_delivery_facts', prUrl: 'https://github.com/o/delivery-facts/pull/3', mergeCommit: MERGE_A,
      mergedAt: '2026-11-10T10:00:00.000Z', title: 'fix the adder carry', costUsd: 3, model: 'v4.1', playbook: 'implement',
    })
    const link = 'https://github.com/o/delivery-facts/issues/9'
    assert.equal(store.linkDeliveryFollowUp(repoId, MERGE_A, link), true)
    assert.equal(store.linkDeliveryFollowUp(repoId, MERGE_A, link), false, 'a comment on the same issue does not count twice')
    assert.equal(store.recordPostMergeFailure(repoId, MERGE_A, '2026-11-15T09:00:00.000Z'), true)
    assert.equal(store.recordPostMergeFailure(repoId, MERGE_A, '2026-11-16T09:00:00.000Z'), true, 'a second failing run is a second fact')
    const summary = summariseDeliveries(store.listDeliveryOutcomes(repoId, '2026-11-01T00:00:00.000Z'))
    assert.equal(summary.merged, 1)
    assert.equal(summary.withFollowUp, 1)
    assert.equal(summary.postMergeFailures, 2)
  } finally {
    store.close()
  }
})

test('the commit matcher reads a revert and leaves an ordinary commit alone', () => {
  assert.equal(revertMatchOf(`Revert "fix the adder carry"\n\nThis reverts commit ${MERGE_A}.`), MERGE_A)
  assert.equal(revertMatchOf('Revert "fix the adder carry"'), null, 'a title alone names no commit to match')
  assert.equal(revertMatchOf('fix the adder carry\n\nThis fixes a bug.'), null)
  assert.equal(revertMatchOf(''), null)
})

test('the windowed summary prints a missing number as null, never zero', () => {
  const rows: DeliveryOutcomeRow[] = [
    {
      id: 'delivery_1', repo_id: 'repo', job_id: 'job', title: 'fix the adder', model: 'v4.1', playbook: 'implement',
      pr_url: 'https://github.com/o/r/pull/1', merge_commit: MERGE_A, merged_at: '2026-11-18T10:00:00.000Z', reverted_at: null,
      revert_commit: null, cost_usd: 2, follow_up_json: '[]', post_merge_failures: 0,
    },
    {
      id: 'delivery_2', repo_id: 'repo', job_id: null, title: 'fix the carry', model: null, playbook: null,
      pr_url: 'https://github.com/o/r/pull/2', merge_commit: MERGE_B, merged_at: '2026-11-17T10:00:00.000Z', reverted_at: '2026-11-18T10:00:00.000Z',
      revert_commit: 'c'.repeat(40), cost_usd: null, follow_up_json: '["https://github.com/o/r/issues/2"]', post_merge_failures: 1,
    },
  ]
  const summary = summariseDeliveries(rows)
  assert.equal(summary.merged, 2)
  assert.equal(summary.reverted, 1)
  assert.equal(summary.kept, 1)
  assert.equal(summary.withFollowUp, 1)
  assert.equal(summary.postMergeFailures, 1)
  assert.equal(summary.costUsd, 2, 'a missing cost is left out of the sum rather than counted as zero')
  assert.equal(summary.costPerKeptChange, 2)
  assert.equal(summariseDeliveries([{ ...rows[1]!, reverted_at: null }]).costPerKeptChange, null, 'a cost that is not known is null')
})

test('the retention class deletes the outcome row in the run that deletes the job', () => {
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'retention')
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString()
    job(store, repoId, userId, 'job_delivery_old', 1, old)
    store.recordDeliveryOutcome({
      repoId, jobId: 'job_delivery_old', prUrl: 'https://github.com/o/delivery-retention/pull/4', mergeCommit: MERGE_A,
      mergedAt: old, title: 'fix the adder carry', costUsd: 1, model: 'v4.1', playbook: 'implement',
    })
    const cls = RETENTION_CLASSES.find((entry: { id: string }) => entry.id === 'deliveryOutcomes')
    assert.ok(cls !== undefined, 'the ledger names its retention class')
    assert.equal(cls.table, 'delivery_outcomes')
    assert.equal(cls.defaultDays, 365, 'the ledger and the jobs it describes share one window')
    const windows = { ...retentionDefaultWindows(), jobs: 1, deliveryOutcomes: 1 }
    store.pruneOldData(windows)
    assert.equal(store.getJob('job_delivery_old'), undefined, 'the job row is gone')
    assert.equal(store.listDeliveryOutcomes(repoId, '2000-01-01T00:00:00.000Z').length, 0, 'and its outcome row with it')
  } finally {
    store.close()
  }
})

// #1062 review: the rate's numerator summed *failing runs* while its denominator
// counted deliveries, so one delivery with two failing runs printed 200% — a rate
// that cannot exist. The rate counts deliveries that carried a failure; the run
// total stays a count of runs and is printed per row.
test('the post-merge failure rate counts deliveries, never failing runs', () => {
  const summary = summariseDeliveries([rowFor('repo_rate', 'one', { post_merge_failures: 2 })])
  assert.equal(summary.merged, 1)
  assert.equal(summary.postMergeFailures, 2, 'the run total stays the run total')
  assert.equal(summary.withPostMergeFailure, 1, 'one delivery carries both failing runs')

  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'delivery-rate', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_delivery_rate', userId: user.id, owner: 'o', name: 'delivery-rate', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const page = repoPage({
      config,
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      jobs: [],
      deliveryOutcomes: [rowFor(repo.id, 'one', { post_merge_failures: 2 })],
    })
    assert.match(page, /data-delivery-merged="1"/)
    assert.match(page, /data-delivery-post-merge-failure-rate="100%"/, 'one delivery out of one carried a failure')
    assert.doesNotMatch(page, /200%/, 'a rate above 100% is never printed')
  } finally {
    store.close()
  }
})

function rowFor(repoId: string, id: string, patch: Partial<DeliveryOutcomeRow> = {}): DeliveryOutcomeRow {
  return {
    id, repo_id: repoId, job_id: null, title: `delivered ${id}`, model: 'v4.1', playbook: 'implement',
    pr_url: `https://github.com/o/delivery-page/pull/${id}`, merge_commit: MERGE_A, merged_at: '2026-11-18T10:00:00.000Z',
    reverted_at: null, revert_commit: null, cost_usd: 1, follow_up_json: '[]', post_merge_failures: 0,
    ...patch,
  }
}

test('the repo page prints what happened after each merge, and — where a fact is missing', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'delivery-page', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_delivery_page', userId: user.id, owner: 'o', name: 'delivery-page', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const rows: DeliveryOutcomeRow[] = [
      rowFor(repo.id, 'one', {
        title: 'fix the adder carry', merge_commit: MERGE_A, reverted_at: '2026-11-18T12:00:00.000Z', revert_commit: REVERT_A,
        cost_usd: 3, follow_up_json: '["https://github.com/o/delivery-page/issues/1","https://github.com/o/delivery-page/issues/2"]',
        post_merge_failures: 2,
      }),
      rowFor(repo.id, 'two', { title: 'fix the carry', merge_commit: MERGE_B, model: null, playbook: null, cost_usd: null }),
    ]
    const page = repoPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo, jobs: [], deliveryOutcomes: rows })
    assert.match(page, /id="delivery-outcomes" data-delivery-outcomes="2"/)
    assert.match(page, /data-delivery-merged="2" data-delivery-reverted="1"/)
    assert.match(page, /data-delivery-revert-rate="50%"/)
    assert.match(page, /data-delivery-follow-up-rate="50%"/)
    assert.match(page, new RegExp(`data-delivery-cost-per-kept="${quotaMoney(3 * config.quota.usdCny).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))
    // The row that recorded everything counts a revert, two follow-ups, two failures and its cost.
    assert.match(page, /data-delivery-row="aaaaaaaaaaaa"/)
    assert.match(page, /<code>cccccccccccc<\/code>/)
    assert.match(page, /<td data-label="Follow-ups">2<\/td>/)
    assert.match(page, /<td data-label="Post-merge failures">2<\/td>/)
    // The row that recorded nothing prints — for every fact it never had, model and role included.
    assert.match(page, /<td data-label="Reverted">—<\/td>/)
    assert.match(page, /<td data-label="Follow-ups">—<\/td>/)
    assert.match(page, /<td data-label="Post-merge failures">—<\/td>/)
    assert.match(page, /<td data-label="Cost">—<\/td>/)
    assert.match(page, /<td data-label="Model \/ role"><small class="muted">—<\/small><\/td>/)
  } finally {
    store.close()
  }
})

test('one delivery is a hint, not a rate, and an empty ledger says so in words', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'delivery-page-one', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_delivery_page_one', userId: user.id, owner: 'o', name: 'delivery-page-one', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const one = repoPage({ config, locale: 'en', viewer, repo, jobs: [], deliveryOutcomes: [rowFor(repo.id, 'only')] })
    assert.match(one, /data-delivery-merged="1" data-delivery-reverted="0"/)
    assert.match(one, /Too few deliveries to be a rate, shown as a hint only/)
    const none = repoPage({ config, locale: 'en', viewer, repo, jobs: [], deliveryOutcomes: [] })
    assert.match(none, /data-delivery-outcomes="0"/)
    assert.match(none, /No delivery has merged in this repository yet/)
    assert.doesNotMatch(none, /data-delivery-merged=/)
  } finally {
    store.close()
  }
})

test('a merge copies the producing job cost and model, and a merge with no job carries neither', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const { repoId, userId } = receiver(store, 'copy')
    job(store, repoId, userId, 'job_delivery_copy', 1.5)
    store.updateJob('job_delivery_copy', { provider_model: 'deepseek/v4.1', work_type: 'implement' })
    const jobs = new Jobs(store, config, new MockRunner(), new MemoryMailer())
    jobs.recordMergedDelivery({
      repoId, jobId: 'job_delivery_copy', prUrl: 'https://github.com/o/delivery-copy/pull/1',
      mergeCommit: MERGE_A, mergedAt: '2026-11-18T10:00:00.000Z', title: 'fix the adder carry',
    })
    const row = store.getDeliveryOutcomeByMerge(repoId, MERGE_A)!
    assert.equal(row.cost_usd, 1.5)
    assert.equal(row.model, 'deepseek/v4.1', 'the window can be read per model without a join')
    assert.equal(row.playbook, 'implement')
    jobs.recordMergedDelivery({
      repoId, jobId: null, prUrl: 'https://github.com/o/delivery-copy/pull/2',
      mergeCommit: MERGE_B, mergedAt: '2026-11-18T11:00:00.000Z', title: 'a human merge',
    })
    const human = store.getDeliveryOutcomeByMerge(repoId, MERGE_B)!
    assert.equal(human.job_id, null)
    assert.equal(human.cost_usd, null, 'no job means no cost to copy, and the card prints —')
    assert.equal(human.model, null)
    assert.equal(human.playbook, null)
  } finally {
    store.close()
  }
})

test('the commit read returns one page and drops an entry it cannot name', async () => {
  const seen: string[] = []
  const github = await startFakeServer((request, response) => {
    seen.push(request.url ?? '')
    if ((request.url ?? '').startsWith('/repos/o/recent/commits')) {
      return json(response, 200, [
        { sha: MERGE_A, commit: { message: `fix the adder\n\nThis reverts commit ${MERGE_B}.` } },
        { sha: MERGE_B },
        { commit: { message: 'no sha to name' } },
      ])
    }
    return json(response, 200, { message: 'not a list' })
  })
  try {
    const client = new GithubClient('token', github.url)
    const commits = await client.listRecentCommits('o', 'recent', 'main')
    assert.deepEqual(commits, [{ sha: MERGE_A, message: `fix the adder\n\nThis reverts commit ${MERGE_B}.` }])
    assert.match(seen[0] ?? '', /^\/repos\/o\/recent\/commits\?sha=main&per_page=50$/)
    assert.deepEqual(await client.listRecentCommits('o', 'other', 'main'), [], 'a response that is not a list is no history, not a guess')
  } finally {
    await github.close()
  }
})

test('a follow-up list that cannot be parsed is no link, never a thrown page', () => {
  assert.deepEqual(followUpLinks({ follow_up_json: 'not json' }), [])
  assert.deepEqual(followUpLinks({ follow_up_json: '{"a":1}' }), [], 'an object is not a list of links')
  assert.deepEqual(followUpLinks({ follow_up_json: '["https://github.com/o/r/issues/1",2]' }), ['https://github.com/o/r/issues/1'])
})

function signWebhook(body: Buffer, secret = 'secret'): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

async function webhookApp(tag: string): Promise<{ built: Awaited<ReturnType<typeof buildApp>>; store: Store; repoId: string; github: { close: () => Promise<void> } }> {
  // Every GitHub call answers 500: the revert scan and the log fetch are
  // best-effort, so a refused read must leave the delivery recorded and the
  // failure counted, not throw out of the webhook.
  const github = await startFakeServer((_request, response) => json(response, 500, { message: 'no installation token' }))
  const config = testConfig({
    github: { ...testConfig().github, apiBase: github.url },
    githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: 'secret', useUserToken: false },
  })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: `delivery-webhook-${tag}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_delivery_webhook_${tag}`, userId: user.id, owner: 'o', name: `delivery-webhook-${tag}`, defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', installationId: 4242, goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  return { built, store, repoId: repo.id, github }
}

test('a merged pull request webhook writes the delivery the repository page reads', async () => {
  const { built, store, repoId, github } = await webhookApp('merge')
  try {
    const fullName = 'o/delivery-webhook-merge'
    const prUrl = `https://github.com/${fullName}/pull/9`
    const sendPull = async (action: string, pull: Record<string, unknown>, delivery: string): Promise<number> => {
      const body = Buffer.from(JSON.stringify({
        action, installation: { id: 4242 }, repository: { full_name: fullName }, pull_request: pull,
      }))
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': delivery, 'x-hub-signature-256': signWebhook(body) },
        payload: body,
      })
      return response.statusCode
    }
    // The opened event is what creates the work item the close path attaches to;
    // a close for a pull request Fledge never saw is dropped on purpose.
    assert.equal(await sendPull('opened', { number: 9, html_url: prUrl, title: 'fix the adder carry', merged: false, state: 'open' }, 'delivery-opened-9'), 200)
    const response = { statusCode: await sendPull('closed', { number: 9, html_url: prUrl, title: 'fix the adder carry', merged: true, state: 'closed', merge_commit_sha: MERGE_A }, 'delivery-merged-9') }
    assert.equal(response.statusCode, 200)
    const rows = store.listDeliveryOutcomes(repoId, '2000-01-01T00:00:00.000Z')
    assert.equal(rows.length, 1, 'the merge is the delivery, written before the page can read it')
    assert.equal(rows[0]?.merge_commit, MERGE_A)
    assert.equal(rows[0]?.title, 'fix the adder carry')
    assert.equal(rows[0]?.job_id, null, 'a merge with no job still lands')
    assert.equal(store.findWorkItemByPrUrl(repoId, `https://github.com/${fullName}/pull/9`)?.state, 'merged')
  } finally {
    // built.close() closes the store it was given.
    await built.close()
    await github.close()
  }
})

// #1290: the payload carries the instant GitHub merged the pull request, so a
// redelivered or replayed event must not move the merge to the day Fledge heard
// about it. The receipt time stays as the fallback for a payload without one.
test("a merge is recorded at the pull request's merged_at, not at receipt", async () => {
  const { built, store, repoId, github } = await webhookApp('merged-at')
  try {
    const fullName = 'o/delivery-webhook-merged-at'
    const prUrl = `https://github.com/${fullName}/pull/21`
    const mergedAt = '2026-11-20T10:00:00Z'
    const send = async (action: string, pull: Record<string, unknown>, delivery: string): Promise<number> => {
      const body = Buffer.from(JSON.stringify({
        action, installation: { id: 4242 }, repository: { full_name: fullName }, pull_request: pull,
      }))
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': delivery, 'x-hub-signature-256': signWebhook(body) },
        payload: body,
      })
      return response.statusCode
    }
    // A close for a pull request Fledge never saw is dropped on purpose, so the
    // opened event comes first and creates the item the close attaches to.
    assert.equal(await send('opened', { number: 21, html_url: prUrl, title: 'date the merge', merged: false, state: 'open' }, 'delivery-opened-21'), 200)
    assert.equal(await send('closed', { number: 21, html_url: prUrl, title: 'date the merge', merged: true, state: 'closed', merge_commit_sha: MERGE_A, merged_at: mergedAt }, 'delivery-merged-21'), 200)
    const rows = store.listDeliveryOutcomes(repoId, '2000-01-01T00:00:00.000Z')
    assert.equal(rows.length, 1, 'the merge is one delivery')
    assert.equal(rows[0]?.merged_at, mergedAt, "the row is dated by the pull request's merged_at, not by the webhook's receipt")
    assert.equal(store.findWorkItemByPrUrl(repoId, prUrl)?.merged_at, mergedAt, 'the board item reads the same instant as the ledger')
  } finally {
    // built.close() closes the store it was given.
    await built.close()
    await github.close()
  }
})

test('a merge with no merged_at in the payload is still dated at receipt', async () => {
  const { built, store, repoId, github } = await webhookApp('no-merged-at')
  try {
    const fullName = 'o/delivery-webhook-no-merged-at'
    const prUrl = `https://github.com/${fullName}/pull/22`
    const send = async (action: string, pull: Record<string, unknown>, delivery: string): Promise<number> => {
      const body = Buffer.from(JSON.stringify({
        action, installation: { id: 4242 }, repository: { full_name: fullName }, pull_request: pull,
      }))
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': delivery, 'x-hub-signature-256': signWebhook(body) },
        payload: body,
      })
      return response.statusCode
    }
    assert.equal(await send('opened', { number: 22, html_url: prUrl, title: 'no merged_at', merged: false, state: 'open' }, 'delivery-opened-22'), 200)
    const before = Date.now()
    const closed = { number: 22, html_url: prUrl, title: 'no merged_at', merged: true, state: 'closed', merge_commit_sha: MERGE_B }
    assert.equal(await send('closed', closed, 'delivery-merged-22'), 200)
    const after = Date.now()
    assert.equal(await send('closed', closed, 'delivery-merged-22-replay'), 200)
    const rows = store.listDeliveryOutcomes(repoId, '2000-01-01T00:00:00.000Z')
    assert.equal(rows.length, 1, 'a replayed merge delivery inserts nothing')
    const recorded = Date.parse(rows[0]?.merged_at ?? '')
    assert.ok(recorded >= before - 1000 && recorded <= after + 1000, 'without a merged_at the row keeps the receipt instant')
  } finally {
    // built.close() closes the store it was given.
    await built.close()
    await github.close()
  }
})

test('a failing default-branch run at a merge commit counts one post-merge failure per run', async () => {
  const { built, store, repoId, github } = await webhookApp('fail')
  try {
    const fullName = 'o/delivery-webhook-fail'
    const prUrl = `https://github.com/${fullName}/pull/11`
    store.recordDeliveryOutcome({ repoId, jobId: null, prUrl, mergeCommit: MERGE_A, mergedAt: '2026-11-18T10:00:00.000Z', title: 'fix the carry', costUsd: null })
    const send = async (id: number): Promise<number> => {
      const body = Buffer.from(JSON.stringify({
        action: 'completed',
        installation: { id: 4242 },
        repository: { full_name: fullName },
        workflow_run: {
          id, name: 'ci', conclusion: 'failure', run_attempt: 1, head_branch: 'main', head_sha: MERGE_A,
          event: 'push', html_url: `https://github.com/${fullName}/actions/runs/${id}`,
        },
      }))
      const response = await built.app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        headers: { 'content-type': 'application/json', 'x-github-event': 'workflow_run', 'x-github-delivery': `delivery-run-${id}`, 'x-hub-signature-256': signWebhook(body) },
        payload: body,
      })
      return response.statusCode
    }
    assert.equal(await send(55), 200)
    assert.equal(store.getDeliveryOutcomeByMerge(repoId, MERGE_A)?.post_merge_failures, 1)
    assert.equal(await send(56), 200)
    assert.equal(store.getDeliveryOutcomeByMerge(repoId, MERGE_A)?.post_merge_failures, 2, 'a second failing run is a second fact, not the same one seen twice')
  } finally {
    // built.close() closes the store it was given.
    await built.close()
    await github.close()
  }
})
