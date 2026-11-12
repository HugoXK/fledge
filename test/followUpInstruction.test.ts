import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #251: the review webhook read only `review.state` and built the follow-up's
// reason from a fixed template, so the maintainer's words never reached the
// agent. These are the two halves the Jobs unit cases cannot see: the sentence
// has to leave the webhook, and it has to be readable — escaped — on the job
// page. A body of `<b>x</b>` is used on purpose: it is the shortest proof that
// a review body is data on this page, never markup.

test('a changes_requested review carries its body into the follow-up goal', async () => {
  const base = testConfig()
  // The route verifies an HMAC over the raw body and refuses to work unless the
  // GitHub App is configured. This path never mints an app token, so the key
  // path may point at nothing; the secret is the only thing that matters here.
  const config = testConfig({ githubApp: { ...base.githubApp, id: '1', privateKeyPath: '/nonexistent/private-key.pem', webhookSecret: 'webhook-secret-251' } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'webhook-review', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_webhook', userId: user.id, owner: 'o', name: 'w', defaultBranch: 'main', tokenEnc: 'x', installationId: 42, upstreamOwner: 'o', upstreamName: 'w', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const prUrl = 'https://github.com/o/w/pull/12'
    // The handler only follows up on a PR that already has a job here.
    store.createJob({ id: 'job_pr_head', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'earlier work', callbackHash: 'cb-head', platformTokenHash: '' })
    store.updateJob('job_pr_head', { pr_url: prUrl, branch: 'fledge/w', status: 'succeeded' })

    const payload = {
      action: 'submitted',
      installation: { id: 42 },
      repository: { full_name: 'o/w' },
      review: { state: 'changes_requested', body: 'Please keep the 404 path out of this PR.' },
      pull_request: { number: 12, html_url: prUrl, head: { ref: 'fledge/w', sha: 'abc123' }, base: { ref: 'main' } },
    }
    const raw = Buffer.from(JSON.stringify(payload))
    const signature = `sha256=${createHmac('sha256', 'webhook-secret-251').update(raw).digest('hex')}`
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-event': 'pull_request_review', 'x-github-delivery': 'delivery-251-review' },
      payload: raw,
    })
    assert.equal(response.statusCode, 200)
    const followup = store.listJobsPageForUser(user.id, 50, 0).find((job) => job.trigger === 'followup')
    assert.ok(followup !== undefined, 'the review starts a follow-up job on the same branch')
    assert.match(followup?.goal ?? '', /Please keep the 404 path out of this PR\./, 'the reviewer’s sentence reaches the goal the agent is given')
  } finally {
    await built.app.close()
    store.close()
  }
})

test('the job page shows the reviewer’s instruction, escaped', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'instruction-page', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_page', userId: user.id, owner: 'o', name: 'pg', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const cookie = `${sessionFor(built, user).cookie}; fledge_lang=en`
    store.createJob({ id: 'job_followup_page', repoId: repo.id, userId: user.id, trigger: 'followup', goal: 'Follow-up on the existing pull request https://github.com/o/pg/pull/3 (branch fledge/pg).\nReason: review requested changes.\nReviewer asked: <b>x</b>\nContinue on the same branch and update the existing PR.', callbackHash: 'cb-page', platformTokenHash: '' })
    store.updateJob('job_followup_page', { pr_url: 'https://github.com/o/pg/pull/3', branch: 'fledge/pg' })

    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/job_followup_page`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Reviewer asked/, 'the page names what the agent was told')
    assert.match(page.body, /&lt;b&gt;x&lt;\/b&gt;/, 'the sentence is shown escaped')
    assert.doesNotMatch(page.body, /<b>x<\/b>/, 'a review body never becomes markup on the page')
  } finally {
    await built.app.close()
    store.close()
  }
})
