import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'

// #1284 (a): a maintainer's terminal decision must survive a delivery that is
// not itself a close. GitHub sends `labeled` for an open pull request, and this
// project's own controller adds the risk-tier label after the pull request
// exists, so the delivery is routine rather than exotic.
const SIGNING_KEY = 'work-item-pr-state-signing-key-1284'

function signed(body: unknown): { raw: string; signature: string } {
  const raw = JSON.stringify(body)
  return { raw, signature: `sha256=${createHmac('sha256', SIGNING_KEY).update(raw).digest('hex')}` }
}

// The route refuses with 503 unless the GitHub App itself is configured, so the
// test carries the same minimal App shape the webhook-rotation suite uses.
function appConfig() {
  return testConfig({
    githubApp: {
      id: '1',
      slug: 'fledge-platform',
      privateKeyPath: '/tmp/fake.pem',
      webhookSecret: SIGNING_KEY,
      webhookSecretPrevious: '',
      webhookSecretPreviousUntil: '',
      useUserToken: false,
    },
  })
}

async function deliver(app: Awaited<ReturnType<typeof buildApp>>['app'], body: unknown, event = 'pull_request') {
  const { raw, signature } = signed(body)
  return app.inject({
    method: 'POST',
    url: '/api/github/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': signature,
      'x-github-delivery': `delivery-${Math.random().toString(16).slice(2)}`,
    },
    payload: raw,
  })
}

function labeled(prUrl: string, title: string) {
  return {
    action: 'labeled',
    installation: { id: 4242 },
    repository: { full_name: 'o/r' },
    pull_request: { state: 'open', merged: false, html_url: prUrl, title },
  }
}

test('a labeled delivery on an open pull request leaves a closed work item closed', async () => {
  const config = appConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'terminal-item' })
    const repo = store.createRepo({
      id: 'repo_terminal',
      userId: user.id,
      owner: 'o',
      name: 'r',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('token', config.tokenEncryptionKey),
      installationId: 4242,
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })

    store.createWorkItem({
      id: 'work_closed',
      repoId: repo.id,
      userId: user.id,
      title: 'Closed while the pull request was open',
      prUrl: 'https://github.com/o/r/pull/7',
      state: 'closed',
      prState: 'closed',
    })
    const closed = await deliver(built.app, labeled('https://github.com/o/r/pull/7', 'New title from the delivery'))
    assert.equal(closed.statusCode, 200)
    const terminal = store.getWorkItem('work_closed')
    assert.equal(terminal?.state, 'closed', 'a non-closing delivery does not reopen a closed item')
    assert.equal(terminal?.pr_state, 'closed', 'the pull-request state of a terminal item is untouched')
    assert.equal(terminal?.title, 'New title from the delivery', 'the title may still refresh')

    // The companion guard: an open item is what this branch exists for, and it
    // must keep tracking the pull request.
    store.createWorkItem({
      id: 'work_open',
      repoId: repo.id,
      userId: user.id,
      title: 'Open item',
      prUrl: 'https://github.com/o/r/pull/8',
      state: 'pr_ready',
      prState: 'open',
    })
    await deliver(built.app, labeled('https://github.com/o/r/pull/8', 'Open item retitled'))
    const open = store.getWorkItem('work_open')
    assert.equal(open?.state, 'pr_ready')
    assert.equal(open?.pr_state, 'open')
    assert.equal(open?.title, 'Open item retitled', 'an open item still tracks the pull request')
  } finally {
    await built.app.close()
    store.close()
  }
})

// #1284's third writer: a review submission on the linked pull request used to
// move any item to `approved`, including one the maintainer had merged or
// closed. An approval looks like progress, so this is the worst of the three.
function reviewed(prUrl: string, state: string) {
  return {
    action: 'submitted',
    installation: { id: 4242 },
    repository: { full_name: 'o/r' },
    pull_request: { state: 'open', merged: false, html_url: prUrl, title: 'Reviewed pull request' },
    review: { state },
  }
}

test('a review delivery does not move a closed or merged work item', async () => {
  const config = appConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'reviewed-item' })
    const repo = store.createRepo({
      id: 'repo_reviewed',
      userId: user.id,
      owner: 'o',
      name: 'r',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('token', config.tokenEncryptionKey),
      installationId: 4242,
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    store.createWorkItem({
      id: 'work_review_closed',
      repoId: repo.id,
      userId: user.id,
      title: 'Closed item',
      prUrl: 'https://github.com/o/r/pull/11',
      state: 'closed',
      prState: 'closed',
    })
    const delivered = await deliver(built.app, reviewed('https://github.com/o/r/pull/11', 'approved'), 'pull_request_review')
    assert.equal(delivered.statusCode, 200)
    const closed = store.getWorkItem('work_review_closed')
    assert.equal(closed?.state, 'closed', 'an approval does not reopen a closed item')
    assert.equal(closed?.pr_state, 'closed')

    store.createWorkItem({
      id: 'work_review_merged',
      repoId: repo.id,
      userId: user.id,
      title: 'Merged item',
      prUrl: 'https://github.com/o/r/pull/12',
      state: 'merged',
      prState: 'merged',
      mergedAt: '2026-11-02T00:00:00.000Z',
    })
    await deliver(built.app, reviewed('https://github.com/o/r/pull/12', 'changes_requested'), 'pull_request_review')
    const merged = store.getWorkItem('work_review_merged')
    assert.equal(merged?.state, 'merged', 'a changes-requested review does not move a merged item')
    assert.equal(merged?.pr_state, 'merged')
    assert.equal(merged?.merged_at, '2026-11-02T00:00:00.000Z')

    // Companion: an open item still takes the review state, which is what the
    // branch is for.
    store.createWorkItem({
      id: 'work_review_open',
      repoId: repo.id,
      userId: user.id,
      title: 'Open item',
      prUrl: 'https://github.com/o/r/pull/13',
      state: 'in_review',
      prState: 'open',
    })
    await deliver(built.app, reviewed('https://github.com/o/r/pull/13', 'approved'), 'pull_request_review')
    const open = store.getWorkItem('work_review_open')
    assert.equal(open?.state, 'approved', 'an open item still takes the review state')
    assert.equal(open?.pr_state, 'open')
  } finally {
    await built.app.close()
    store.close()
  }
})
