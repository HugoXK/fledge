import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #638 slice 1: the agent may propose a project-memory note from a job, and a
// human decides in the console. The defect class this card exists for is a
// proposal that becomes authoritative by itself, so every case below drives the
// HTTP routes: the job-scoped writer, the bound per run, the refusal to replace a
// human entry, and the two decisions a maintainer makes on the entry page.

const JOB_SECRET = 'callback-secret-for-the-agent-note-test'

interface Harness {
  store: Store
  built: Awaited<ReturnType<typeof buildApp>>
  user: ReturnType<typeof makeUser>
  repo: ReturnType<Store['createRepo']>
  jobId: string
  cookie: string
  csrf: string
  close: () => Promise<void>
}

async function harness(options: { repoRole?: 'maintainer' | 'developer' } = {}): Promise<Harness> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  const user = makeUser(store, { login: `agent-memory-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    upstreamHtmlUrl: 'https://github.com/owner/repo',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: options.repoRole ?? 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const jobId = `job_${Math.random().toString(36).slice(2, 8)}`
  store.createJob({ id: jobId, repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: createHash('sha256').update(JOB_SECRET).digest('hex'), platformTokenHash: '', kind: 'iterate' })
  store.updateJob(jobId, { status: 'running' })
  const session = sessionFor(built, user)
  return { store, built, user, repo, jobId, cookie: session.cookie, csrf: session.csrf, close: () => built.close() }
}

function propose(h: Harness, body: Record<string, unknown>): Promise<{ statusCode: number; body: string }> {
  return h.built.app.inject({
    method: 'POST',
    url: `/api/jobs/${h.jobId}/memory`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${JOB_SECRET}` },
    payload: JSON.stringify(body),
  })
}

function page(h: Harness, query = ''): Promise<{ statusCode: number; body: string }> {
  return h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}/memory${query}`, headers: { cookie: `${h.cookie}; fledge_lang=en` } })
}

function decide(h: Harness, key: string, action: 'accept' | 'reject'): Promise<{ statusCode: number; headers: Record<string, unknown> }> {
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/memory/${encodeURIComponent(key)}/${action}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${h.cookie}; fledge_lang=en` },
    payload: formBody({ csrf: h.csrf }),
  })
}

function humanWrite(h: Harness, values: Record<string, string>): Promise<{ statusCode: number; headers: Record<string, unknown> }> {
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/memory`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${h.cookie}; fledge_lang=en` },
    payload: formBody({
      csrf: h.csrf,
      key: 'migrations',
      kind: 'decision',
      status: 'active',
      verification: 'human_asserted',
      audience: 'project',
      scope: '',
      body: 'Migrations are additive and idempotent.',
      reason: 'recorded by a person',
      expected_revision: '0',
      ...values,
    }),
  })
}

test('an agent proposal appears unverified in the console and a human accepts it', async () => {
  const h = await harness()
  try {
    const proposed = await propose(h, { key: 'test-first', kind: 'convention', body: 'Write the red test before the fix.', sources: ['pr#724'] })
    assert.equal(proposed.statusCode, 200)
    const stored = h.store.getMemory(h.repo.id, 'test-first')
    assert.equal(stored?.owner_type, 'agent', 'the agent is recorded as the author')
    assert.equal(stored?.verification, 'unverified', 'a proposal is never born verified')
    assert.equal(stored?.status, 'needs_review')
    assert.equal(stored?.source_job_id, h.jobId, 'the proposal names the job that made it')

    // What the maintainer sees before deciding.
    const before = await page(h, '?key=test-first')
    assert.equal(before.statusCode, 200)
    assert.match(before.body, /data-memory-proposal="agent"/)
    assert.match(before.body, /data-memory-accept="test-first"/)
    assert.match(before.body, /data-memory-reject="test-first"/)
    assert.match(before.body, /Unverified/)

    const accepted = await decide(h, 'test-first', 'accept')
    assert.equal(accepted.statusCode, 302)
    const after = h.store.getMemory(h.repo.id, 'test-first')
    assert.equal(after?.revision, 2, 'accepting is a new revision, not an edit of the agent text')
    assert.equal(after?.verification, 'human_asserted')
    assert.equal(after?.status, 'active')
    assert.equal(after?.body, 'Write the red test before the fix.', 'the accepted text is the agent text')
    const acceptedPage = await page(h, '?key=test-first')
    assert.doesNotMatch(acceptedPage.body, /data-memory-accept="test-first"/, 'a decided proposal offers no second decision')
    assert.match(acceptedPage.body, /Human asserted/)
  } finally {
    await h.close()
  }
})

test('rejecting a proposal keeps the record and marks it revoked', async () => {
  const h = await harness()
  try {
    await propose(h, { key: 'noisy-log', kind: 'experience', body: 'The flaky test was the clock.' })
    const rejected = await decide(h, 'noisy-log', 'reject')
    assert.equal(rejected.statusCode, 302)
    const row = h.store.getMemory(h.repo.id, 'noisy-log')
    assert.equal(row?.status, 'revoked')
    assert.equal(row?.revision, 2)
    // The body is still there: the record of what was proposed is not destroyed.
    assert.equal(row?.body, 'The flaky test was the clock.')
    assert.equal(h.store.listMemoryVersions(row!.id).length, 2)
  } finally {
    await h.close()
  }
})

test('a fourth proposal in one run is refused', async () => {
  const h = await harness()
  try {
    for (const key of ['note-one', 'note-two', 'note-three']) {
      const ok = await propose(h, { key, kind: 'experience', body: `Body for ${key}.` })
      assert.equal(ok.statusCode, 200, `${key} should be accepted inside the bound`)
    }
    const fourth = await propose(h, { key: 'note-four', kind: 'experience', body: 'One too many.' })
    assert.equal(fourth.statusCode, 429)
    assert.match(fourth.body, /agent_note_limit/)
    assert.equal(h.store.getMemory(h.repo.id, 'note-four'), undefined, 'the refused note is not stored')
  } finally {
    await h.close()
  }
})

test('an agent proposal cannot replace a human entry, and a duplicate key is a conflict', async () => {
  const h = await harness()
  try {
    const human = await humanWrite(h, {})
    assert.equal(human.statusCode, 302)
    const proposed = await propose(h, { key: 'migrations', kind: 'decision', body: 'An agent rewrite that must never land.' })
    assert.equal(proposed.statusCode, 409)
    assert.match(proposed.body, /memory_exists/)
    const row = h.store.getMemory(h.repo.id, 'migrations')
    assert.equal(row?.body, 'Migrations are additive and idempotent.', 'the human body is untouched')
    assert.equal(row?.verification, 'human_asserted')
    assert.equal(row?.revision, 1, 'no revision was written by the refused proposal')

    // A decided entry cannot be decided again.
    await propose(h, { key: 'test-first', kind: 'convention', body: 'Red first.' })
    await decide(h, 'test-first', 'accept')
    const again = await decide(h, 'test-first', 'reject')
    assert.match(String(again.headers.location ?? ''), /not_a_proposal/)
  } finally {
    await h.close()
  }
})

test('a finished job cannot propose, and a bad secret is refused', async () => {
  const h = await harness()
  try {
    const badSecret = await h.built.app.inject({
      method: 'POST',
      url: `/api/jobs/${h.jobId}/memory`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-secret' },
      payload: JSON.stringify({ key: 'sneaky', kind: 'decision', body: 'nope' }),
    })
    assert.equal(badSecret.statusCode, 401)
    h.store.updateJob(h.jobId, { status: 'succeeded' })
    const finished = await propose(h, { key: 'late', kind: 'decision', body: 'too late' })
    assert.equal(finished.statusCode, 409)
    assert.match(finished.body, /job_finished/)
  } finally {
    await h.close()
  }
})
