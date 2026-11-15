import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { RepoRow, SecurityFindingRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { MockRunner } from '../src/jobs/mock.js'
import { findingId, parseFindings } from '../src/lib/securityFindings.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { jobPage, repoPage } from '../src/views/pages.js'
import type { Viewer } from '../src/views/layout.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #379 slice 1: reported security findings are kept per repository, so a fixed
// or dismissed finding that comes back is visible as `regressed` instead of
// looking new. The two properties this suite exists for are negative ones:
// absence of a finding in a later report is never evidence of a fix, and a
// dismissal or a fix without a written reason does not become a state.

const RULE = 'js/path-injection'
const PATH = 'src/app.ts'
const LINE = 120
const ID = `${RULE} ${PATH}:${LINE}`

// #472: a redirect sentence travels in the one-shot flash cookie and is stripped
// from Location before the browser sees it, so a refusal is read from the cookie
// rather than from the URL. Decoded here directly rather than imported, so this
// file fails on the behaviour and not on a missing helper.
function flashedText(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie']
  const lines = header === undefined ? [] : (Array.isArray(header) ? header : [header]).map(String)
  const line = lines.find((entry) => entry.startsWith('fledge_flash='))
  if (line === undefined) return ''
  const raw = line.slice('fledge_flash='.length).split(';')[0] ?? ''
  if (raw === '') return ''
  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { e?: { t?: unknown }; n?: { t?: unknown } }
  if (typeof parsed.e?.t === 'string') return parsed.e.t
  return typeof parsed.n?.t === 'string' ? parsed.n.t : ''
}

interface Harness {
  store: Store
  jobs: Jobs
  repo: RepoRow
  userId: string
  config: ReturnType<typeof testConfig>
}

function harness(): Harness {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, new MockRunner(), new MemoryMailer())
  const user = makeUser(store, { login: 'findings-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_findings',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, jobs, repo, userId: user.id, config }
}

function jobRow(h: Harness, id: string, secret: string): void {
  h.store.createJob({
    id,
    repoId: h.repo.id,
    userId: h.userId,
    trigger: 'manual',
    goal: 'g',
    callbackHash: sha256Hex(secret),
    platformTokenHash: '',
    kind: 'iterate',
    baseBranch: 'main',
  })
  h.store.updateJob(id, { status: 'running', started_at: new Date().toISOString(), branch: 'fledge/job' })
}

async function report(h: Harness, id: string, findings: unknown[]): Promise<void> {
  const secret = `secret-${id}`
  jobRow(h, id, secret)
  const result = await h.jobs.handleCallback(id, secret, { status: 'succeeded', summary: 'done', evidence: { findings } })
  assert.equal(result.ok, true, result.error ?? 'the callback was refused')
}

function viewer(h: Harness): Viewer {
  const user = h.store.userById(h.userId)
  assert.ok(user !== undefined)
  return { user, csrfToken: 'csrf' }
}

test('the reported list is bounded at 100 and a malformed entry is dropped and counted', () => {
  const valid = Array.from({ length: 100 }, (_, index) => ({ rule: 'js/x', path: `src/f${index}.ts`, line: index + 1 }))
  const parsed = parseFindings([
    ...valid,
    // The 101st valid entry is over the bound.
    { rule: 'js/x', path: 'src/over.ts', line: 1 },
    { rule: 'r'.repeat(121), path: 'src/a.ts', line: 1 },
    { rule: 'js/x', path: 'p'.repeat(201), line: 1 },
    { rule: 'js/x', path: 'src/a.ts', line: 0 },
    { rule: 'js/x', path: 'src/a.ts', line: 1.5 },
    { rule: '', path: 'src/a.ts', line: 1 },
    { rule: 'js/x', path: 'src/a.ts', line: 1, state: 'fixed' },
    null,
  ])
  assert.equal(parsed.findings.length, 100, 'the ledger keeps at most 100 findings per report')
  assert.equal(parsed.dropped, 8, 'every refused entry is counted, not silently ignored')
  const first = parsed.findings[0]
  assert.ok(first !== undefined)
  assert.equal(first.state, 'open', 'a finding with no state is reported as open')
})

test('the id is rule plus path plus line, so one rule on two paths is two findings', () => {
  assert.equal(findingId({ rule: RULE, path: PATH, line: LINE }), ID)
  assert.notEqual(
    findingId({ rule: RULE, path: 'src/a.ts', line: LINE }),
    findingId({ rule: RULE, path: 'src/b.ts', line: LINE }),
  )
})

test('a reported finding is open, a dismissal needs a reason, and a re-report is regressed', async () => {
  const h = harness()
  try {
    await report(h, 'job-a', [{ rule: RULE, path: PATH, line: LINE }])
    const opened = h.store.getSecurityFinding(h.repo.id, ID)
    assert.equal(opened?.state, 'open')
    assert.equal(opened?.first_seen_job, 'job-a')
    assert.equal(opened?.last_seen_job, 'job-a')

    // The store refuses a dismissal without a written reason, so it can never be
    // stored as a silent accept.
    assert.equal(h.store.setSecurityFindingState(h.repo.id, ID, 'dismissed', '   '), false)
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID)?.state, 'open')
    assert.equal(h.store.setSecurityFindingState(h.repo.id, ID, 'dismissed', 'false positive in the fixture'), true)
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID)?.state, 'dismissed')

    await report(h, 'job-b', [{ rule: RULE, path: PATH, line: LINE }])
    const regressed = h.store.getSecurityFinding(h.repo.id, ID)
    assert.equal(regressed?.state, 'regressed', 'a dismissed finding that comes back is regressed, not fresh')
    assert.equal(regressed?.last_seen_job, 'job-b')
    assert.equal(regressed?.dismissed_in_job, 'job-a')

    const html = jobPage({
      config: h.config,
      locale: 'en',
      viewer: viewer(h),
      repo: h.repo,
      job: h.store.getJob('job-b')!,
      findings: h.store.listSecurityFindingsForJob('job-b'),
    })
    // The label is capitalised like every other state label; what this asserts is
    // the parenthetical, which is the job the dismissal was recorded in.
    assert.match(html, /regressed \(dismissed in job job-a\)/i, 'the job page names the job the finding was dismissed in')
  } finally {
    h.store.close()
  }
})

test('two findings with the same rule on different paths are two rows', async () => {
  const h = harness()
  try {
    await report(h, 'job-a', [
      { rule: RULE, path: 'src/a.ts', line: 1 },
      { rule: RULE, path: 'src/b.ts', line: 1 },
    ])
    assert.equal(h.store.listSecurityFindings(h.repo.id).length, 2)
    assert.equal(h.store.getSecurityFinding(h.repo.id, `${RULE} src/a.ts:1`)?.state, 'open')
    assert.equal(h.store.getSecurityFinding(h.repo.id, `${RULE} src/b.ts:1`)?.state, 'open')
  } finally {
    h.store.close()
  }
})

test('a replayed callback writes one row and leaves one last_seen value', async () => {
  const h = harness()
  try {
    const secret = 'replay-secret'
    jobRow(h, 'job-a', secret)
    const payload = { status: 'succeeded' as const, summary: 'done', evidence: { findings: [{ rule: RULE, path: PATH, line: LINE }] } }
    assert.equal((await h.jobs.handleCallback('job-a', secret, payload)).ok, true)
    const firstSeen = h.store.getSecurityFinding(h.repo.id, ID)?.updated_at
    assert.equal((await h.jobs.handleCallback('job-a', secret, payload)).duplicate, true)
    assert.equal(h.store.listSecurityFindings(h.repo.id).length, 1)
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID)?.updated_at, firstSeen, 'a replay does not touch the row')
  } finally {
    h.store.close()
  }
})

test('a finding missing from a later report is not evidence of a fix', async () => {
  const h = harness()
  try {
    await report(h, 'job-a', [{ rule: RULE, path: PATH, line: LINE }])
    await report(h, 'job-b', [{ rule: RULE, path: 'src/other.ts', line: 7 }])
    const untouched = h.store.getSecurityFinding(h.repo.id, ID)
    assert.equal(untouched?.state, 'open', 'absence changes nothing: only a reported id may move a row')
    assert.equal(untouched?.last_seen_job, 'job-a')
    // An empty report is the strongest form of absence and must not claim a fix.
    await report(h, 'job-c', [])
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID)?.state, 'open')
  } finally {
    h.store.close()
  }
})

test('a fix needs evidence, and a fixed finding that comes back is regressed', async () => {
  const h = harness()
  try {
    await report(h, 'job-a', [{ rule: RULE, path: PATH, line: LINE }])
    assert.equal(h.store.setSecurityFindingState(h.repo.id, ID, 'fixed', ''), false, 'a fix without evidence is refused')
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID)?.state, 'open')
    assert.equal(h.store.setSecurityFindingState(h.repo.id, ID, 'fixed', 'removed the sink in 4a1b2c3'), true)
    const fixed = h.store.getSecurityFinding(h.repo.id, ID)
    assert.equal(fixed?.state, 'fixed')
    assert.equal(fixed?.reason, 'removed the sink in 4a1b2c3')

    await report(h, 'job-b', [{ rule: RULE, path: PATH, line: LINE }])
    const regressed = h.store.getSecurityFinding(h.repo.id, ID)
    assert.equal(regressed?.state, 'regressed', 'the ledger refuses to keep claiming fixed once the finding is seen again')
    assert.match(regressed?.reason ?? '', /4a1b2c3/, 'the evidence the fix rested on is kept with the regression')
    const html = jobPage({
      config: h.config,
      locale: 'en',
      viewer: viewer(h),
      repo: h.repo,
      job: h.store.getJob('job-b')!,
      findings: h.store.listSecurityFindingsForJob('job-b'),
    })
    assert.match(html, /Regressed/)
    assert.doesNotMatch(html, /Fixed —/, 'the page does not present the re-opened finding as fixed')
  } finally {
    h.store.close()
  }
})

test('a callback that reports a dismissal without a reason does not become a state', async () => {
  const h = harness()
  try {
    await report(h, 'job-a', [{ rule: RULE, path: PATH, line: LINE, state: 'dismissed' }])
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID), undefined, 'refused, not stored as open')
    const audit = h.store.listAudit(20).find((row) => row.action === 'security_finding.dismissal_refused')
    assert.ok(audit !== undefined, 'the refusal is audited rather than silent')
    assert.match(String(audit.detail), /job-a/)
    // A recorded dismissal carries its reason; a report never invents one.
    await report(h, 'job-b', [{ rule: RULE, path: PATH, line: LINE }])
    const row = h.store.getSecurityFinding(h.repo.id, ID)
    assert.equal(row?.state, 'open')
    assert.equal(row?.reason, null)
  } finally {
    h.store.close()
  }
})

test('a finding the report no longer names leaves a fixed row fixed and its evidence intact', async () => {
  const h = harness()
  try {
    await report(h, 'job-a', [{ rule: RULE, path: PATH, line: LINE }])
    assert.equal(h.store.setSecurityFindingState(h.repo.id, ID, 'fixed', 'removed the sink in 4a1b2c3'), true)
    await report(h, 'job-b', [])
    const row = h.store.getSecurityFinding(h.repo.id, ID)
    assert.equal(row?.state, 'fixed')
    assert.equal(row?.reason, 'removed the sink in 4a1b2c3')
  } finally {
    h.store.close()
  }
})

test('a ledger write that fails leaves the job finished and says so', async () => {
  const h = harness()
  const secret = 'secret-job-write-fails'
  jobRow(h, 'job-write-fails', secret)
  const original = h.store.writeSecurityFindings.bind(h.store)
  try {
    // The ledger is memory, not the job. A write that fails (a locked file, a
    // constraint the report trips) must not leave the terminal transition's
    // side effects half done or the callback failing after the row committed —
    // and it must not vanish either, so the failure gets a durable row.
    Object.defineProperty(h.store, 'writeSecurityFindings', {
      value: () => {
        throw new Error('database is locked')
      },
      configurable: true,
    })
    const result = await h.jobs.handleCallback('job-write-fails', secret, {
      status: 'succeeded',
      summary: 'done',
      evidence: { findings: [{ rule: RULE, path: PATH, line: LINE }] },
    })
    assert.equal(result.ok, true, result.error ?? 'the job still finishes')
    assert.equal(h.store.getJob('job-write-fails')?.status, 'succeeded')
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID), undefined, 'a failed ledger write stores no row')
    assert.ok(
      h.store.listAudit(50).some((entry) => entry.action === 'security_finding.write_failed'),
      'the failed write is recorded instead of disappearing into a log',
    )
  } finally {
    Object.defineProperty(h.store, 'writeSecurityFindings', { value: original, configurable: true })
    h.store.close()
  }
})

test('the dismiss route refuses an empty reason and accepts a written one', async () => {
  const h = harness()
  const built = await buildApp({ config: h.config, store: h.store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    await report(h, 'job-a', [{ rule: RULE, path: PATH, line: LINE }])
    const session = sessionFor(built, h.store.userById(h.userId)!)
    const url = `/repos/${h.repo.id}/security-findings/${encodeURIComponent(ID)}/dismiss`
    const headers = { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'en' }
    const refused = await built.app.inject({ method: 'POST', url, headers, payload: formBody({ csrf: session.csrf, reason: '  ' }) })
    assert.equal(refused.statusCode, 302)
    assert.match(flashedText(refused), /reason/i)
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID)?.state, 'open', 'a refusal writes no state')

    const accepted = await built.app.inject({ method: 'POST', url, headers, payload: formBody({ csrf: session.csrf, reason: 'false positive in the fixture' }) })
    assert.equal(accepted.statusCode, 302)
    assert.match(flashedText(accepted), /dismissed/i)
    const row = h.store.getSecurityFinding(h.repo.id, ID)
    assert.equal(row?.state, 'dismissed')
    assert.equal(row?.reason, 'false positive in the fixture')
    assert.ok(h.store.listAudit(20).some((entry) => entry.action === 'security_finding.dismissed'))
  } finally {
    await built.close()
  }
})

test('the fix route refuses a fix without evidence', async () => {
  const h = harness()
  const built = await buildApp({ config: h.config, store: h.store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    await report(h, 'job-a', [{ rule: RULE, path: PATH, line: LINE }])
    const session = sessionFor(built, h.store.userById(h.userId)!)
    const url = `/repos/${h.repo.id}/security-findings/${encodeURIComponent(ID)}/fix`
    const headers = { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'en' }
    const refused = await built.app.inject({ method: 'POST', url, headers, payload: formBody({ csrf: session.csrf, evidence: '' }) })
    assert.equal(refused.statusCode, 302)
    assert.match(flashedText(refused), /evidence/i)
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID)?.state, 'open', 'a fix without evidence leaves the finding open')
    const accepted = await built.app.inject({ method: 'POST', url, headers, payload: formBody({ csrf: session.csrf, evidence: 'removed the sink in 4a1b2c3' }) })
    assert.equal(accepted.statusCode, 302)
    assert.equal(h.store.getSecurityFinding(h.repo.id, ID)?.state, 'fixed')
  } finally {
    await built.close()
  }
})

test('the repository page lists the four states, and a fixed row with no evidence is not called verified', async () => {
  const h = harness()
  try {
    await report(h, 'job-a', [{ rule: RULE, path: PATH, line: LINE }])
    await report(h, 'job-a2', [{ rule: 'js/x', path: 'src/a.ts', line: 1 }])
    assert.equal(h.store.setSecurityFindingState(h.repo.id, 'js/x src/a.ts:1', 'dismissed', 'not reachable from user input'), true)
    await report(h, 'job-b', [{ rule: 'js/x', path: 'src/b.ts', line: 2 }])
    assert.equal(h.store.setSecurityFindingState(h.repo.id, 'js/x src/b.ts:2', 'fixed', 'removed in 4a1b2c3'), true)
    await report(h, 'job-c', [{ rule: 'js/x', path: 'src/b.ts', line: 2 }])
    // A row whose evidence is gone cannot be written through the store, so the
    // view is handed one directly: it must not call it verified fixed.
    const evidenceGone: SecurityFindingRow = {
      repo_id: h.repo.id, id: 'js/x src/c.ts:3', state: 'fixed', first_seen_job: 'job-a',
      last_seen_job: 'job-a', reason: null, dismissed_in_job: null, updated_at: new Date().toISOString(),
    }
    const html = repoPage({
      config: h.config,
      locale: 'en',
      viewer: viewer(h),
      repo: h.repo,
      jobs: [],
      securityFindings: [...h.store.listSecurityFindings(h.repo.id), evidenceGone],
    })
    assert.match(html, /Security findings/)
    assert.match(html, /Open/)
    assert.match(html, /Fixed/)
    assert.match(html, /Regressed/)
    assert.match(html, /Dismissed/)
    assert.match(html, /no evidence recorded/, 'a fixed row without evidence is shown as unverified')
    assert.match(html, /reported by jobs, not GitHub/, 'the card says these are reported ids, not the alert store')
  } finally {
    h.store.close()
  }
})
