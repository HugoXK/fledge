import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { DEFAULT_TRIAGE_GOAL } from '../src/jobs/service.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #523: #390 shipped the `triage` work type and its job page, but nothing in the
// product could start one — no route, form or scheduler branch passed
// `kind='triage'`. Triage is repository-scoped, so the missing input is a
// repository and the control belongs on the repository page behind `ownedRepo`,
// not on the admin console (an operator-only start would leave the ordinary
// repository owner unable to triage their own repository).
//
// The route also accepts an optional issue URL that focuses the board. That is
// the one input the product passes through, so it is bound to the repository on
// the input side with the same rule the callback applies (`parseIssueUrl`):
// a foreign host or a foreign repository is refused with a visible error and no
// job row, instead of being caught only when the report comes back.
//
// The defect this card exists for was invisible to service-level tests, so every
// case below drives the HTTP route.

const CJK = /[\u3400-\u9fff]/

interface Harness {
  store: Store
  built: Awaited<ReturnType<typeof buildApp>>
  user: ReturnType<typeof makeUser>
  repo: ReturnType<Store['createRepo']>
  cookie: string
  csrf: string
  close: () => Promise<void>
}

async function harness(options: { repoRole?: 'maintainer' | 'developer' | null } = {}): Promise<Harness> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    // A runner that returns `running` leaves the row active, which is the state
    // the page has to show and the state the duplicate rule has to refuse.
    runner: { name: 'hold', async run() { return { status: 'running' as const } } },
    startScheduler: false,
  })
  const user = makeUser(store, { login: `triage-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    upstreamHtmlUrl: 'https://github.com/owner/repo',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: options.repoRole === undefined ? 'maintainer' : options.repoRole,
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const session = sessionFor(built, user)
  return { store, built, user, repo, cookie: session.cookie, csrf: session.csrf, close: () => built.close() }
}

function start(
  h: Harness,
  values: { issueUrl?: string; locale?: 'zh' | 'en' } = {},
): Promise<{ statusCode: number; headers: Record<string, unknown> }> {
  const locale = values.locale ?? 'en'
  const built = h.built
  return built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/triage`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${h.cookie}; fledge_lang=${locale}` },
    payload: formBody({ csrf: h.csrf, issueUrl: values.issueUrl }),
  })
}

function jobs(h: Harness): ReturnType<Store['listJobsForRepo']> {
  return h.store.listJobsForRepo(h.repo.id, 10)
}

function location(response: { headers: Record<string, unknown> }): string {
  return String(response.headers.location ?? '')
}

test('a person can start a triage job from their repository page', async () => {
  const h = await harness()
  try {
    const en = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: `${h.cookie}; fledge_lang=en` } })
    assert.equal(en.statusCode, 200)
    assert.match(en.body, new RegExp(`action="/repos/${h.repo.id}/triage"`), 'the repository page carries the triage start control')
    assert.match(en.body, /Issue URL \(optional\)/, 'the control names its one optional input')
    assert.match(en.body, /Triage now/, 'the control is labelled in English')
    const zh = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: `${h.cookie}; fledge_lang=zh` } })
    assert.match(zh.body, /开始分诊/, 'the control is labelled in Chinese too')

    const response = await start(h)
    assert.equal(response.statusCode, 302)
    assert.match(location(response), new RegExp(`^/repos/${h.repo.id}/jobs/job_`), 'a started triage lands on its own job page')

    const rows = jobs(h)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.kind, 'triage', 'the row is a triage job, not an iterate one')
    assert.equal(rows[0]!.work_type, 'triage', 'the row carries the triage work type')

    const page = await h.built.app.inject({ method: 'GET', url: location(response), headers: { cookie: `${h.cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /data-work-type="triage"/, 'the job page shows the triage contract card')
    assert.match(page.body, /data-triage/, 'the job page shows the triage result card')
    assert.match(page.body, /No triage result yet/, 'a queued triage says it has no result yet')
    const zhPage = await h.built.app.inject({ method: 'GET', url: location(response), headers: { cookie: `${h.cookie}; fledge_lang=zh` } })
    assert.match(zhPage.body, /还没有分诊结果/, 'the Chinese page says the same')
  } finally {
    await h.close()
  }
})

test('a start while one triage job is active is refused with JOB_ACTIVE and writes no second row', async () => {
  const h = await harness()
  try {
    await start(h)
    const second = await start(h)
    assert.equal(second.statusCode, 302)
    const message = decodeURIComponent(location(second))
    assert.match(message, /error=/)
    assert.match(message, /already (has a job|running)|已有任务在运行/i, `the refusal names the active job: ${message}`)
    assert.equal(jobs(h).length, 1, 'no second row appears')
  } finally {
    await h.close()
  }
})

test('a pasted issue URL from another host or another repository is refused on the input side', async () => {
  const h = await harness()
  try {
    const foreignRepo = await start(h, { issueUrl: 'https://github.com/someone/else/issues/1' })
    assert.equal(foreignRepo.statusCode, 302)
    let message = decodeURIComponent(location(foreignRepo))
    assert.match(message, /error=/)
    assert.match(message, /does not belong to this repository/, `a foreign repository is refused: ${message}`)
    assert.equal(jobs(h).length, 0, 'a refused start writes no row')

    const foreignHost = await start(h, { issueUrl: 'https://ghe.example.com/owner/repo/issues/1' })
    message = decodeURIComponent(location(foreignHost))
    assert.match(message, /error=/, 'a foreign host is refused too')
    assert.doesNotMatch(message.slice(message.indexOf('error=')), CJK, 'the English refusal is one sentence in the reader language')
    assert.equal(jobs(h).length, 0)
  } finally {
    await h.close()
  }
})

test('an issue URL from this repository focuses the board, and its number is the issue', async () => {
  const h = await harness()
  try {
    const response = await start(h, { issueUrl: 'https://github.com/owner/repo/issues/12' })
    assert.equal(response.statusCode, 302)
    assert.match(location(response), new RegExp(`^/repos/${h.repo.id}/jobs/job_`), 'a bound URL still starts the job')
    const rows = jobs(h)
    assert.equal(rows.length, 1)
    assert.match(rows[0]!.goal, /issues\/12/, 'the goal names the issue the board was asked to start with')
    assert.ok(rows[0]!.goal.startsWith(DEFAULT_TRIAGE_GOAL), 'the triage contract is still the goal it starts from')
  } finally {
    await h.close()
  }
})

test('no pasted URL starts a plain repository triage with the default contract', async () => {
  const h = await harness()
  try {
    const response = await start(h, { issueUrl: '' })
    assert.equal(response.statusCode, 302)
    const rows = jobs(h)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.goal, DEFAULT_TRIAGE_GOAL, 'the default goal is the triage contract, not the repository iterate goal')
  } finally {
    await h.close()
  }
})

test('another account cannot start a triage job on a repository it does not own', async () => {
  const h = await harness()
  try {
    // The owner's own start has to work first; otherwise a 404 below would only
    // prove the route is missing.
    const owned = await start(h)
    assert.equal(owned.statusCode, 302, 'the owner can start it')
    const other = makeUser(h.store, { login: `triage-other-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
    const otherSession = sessionFor(h.built, other)
    const response = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/triage`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${otherSession.cookie}; fledge_lang=en` },
      payload: formBody({ csrf: otherSession.csrf }),
    })
    assert.equal(response.statusCode, 404)
    assert.equal(jobs(h).length, 1, 'the other account added no row')
  } finally {
    await h.close()
  }
})

test('the control is disabled, not merely refused, while a job is running', async () => {
  const h = await harness()
  try {
    const job = h.store.createJob({ id: 'job_busy', repoId: h.repo.id, userId: h.user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    h.store.updateJob(job.id, { status: 'running' })
    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: `${h.cookie}; fledge_lang=en` } })
    assert.match(page.body, /name="issueUrl"[^>]*disabled/, 'the field says the job is busy before the submit is refused')
    assert.match(page.body, /Triage now/, 'the control is still named')
    assert.match(page.body, /already running; triage starts once it finishes/, 'the reason is next to the control')
  } finally {
    await h.close()
  }
})

test('a repository with no chosen role shows why triage is unavailable instead of a dead button', async () => {
  const h = await harness({ repoRole: null })
  try {
    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: `${h.cookie}; fledge_lang=en` } })
    assert.doesNotMatch(page.body, new RegExp(`action="/repos/${h.repo.id}/triage"`), 'no start control is offered without a role')
    assert.match(page.body, /Choose your role first; triage opens after that/, 'the page says what is missing')
  } finally {
    await h.close()
  }
})
