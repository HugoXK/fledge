import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

test('review jobs use the review kind and update review state', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'reviewer', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_review',
      userId: user.id,
      owner: 'openJiuwen-ai',
      name: 'DigitalMate',
      defaultBranch: 'main',
      tokenEnc: 'x',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
      upstreamOwner: 'openJiuwen-ai',
      upstreamName: 'DigitalMate',
      forkOwner: 'reviewer',
      forkName: 'DigitalMate',
      isFork: true,
      permission: 'maintain',
      canReview: true,
      reviewerEnabled: true,
      reviewIntervalMinutes: 1440,
      upstreamHtmlUrl: 'https://github.com/openJiuwen-ai/DigitalMate',
      forkHtmlUrl: 'https://github.com/reviewer/DigitalMate',
    })
    assert.equal(store.listReviewRepos().length, 1)
    const result = await built.jobs.enqueue(repo, 'manual', undefined, 'review')
    assert.equal(result.ok, true)
    const job = result.job!
    assert.equal(job.kind, 'review')
    assert.equal(job.status, 'succeeded')
    assert.match(job.summary ?? '', /Mock review/)
    const updated = store.getRepo(repo.id)!
    assert.equal(updated.last_review_status, 'succeeded')
    assert.notEqual(updated.last_review_at, null)
    assert.equal(updated.last_status, null)
  } finally {
    await built.close()
  }
})
