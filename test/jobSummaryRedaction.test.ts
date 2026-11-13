import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { buildCarryOver } from '../src/jobs/continuity.js'
import { jobPage } from '../src/views/pages.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'
import { sha256Hex } from '../src/lib/secrets.js'

// Synthetic only: "SYNTHETIC" repeated, never a real credential.
const TOKEN = `ghp_${'SYNTHETIC'.repeat(4)}`
const SECRET = 'callback-secret'

function assertClean(value: string | null | undefined, where: string): void {
  const text = value ?? ''
  assert.equal(text.includes('ghp_'), false, `${where} kept the token prefix`)
  assert.equal(text.includes('SYNTHETIC'), false, `${where} kept a token fragment`)
}

function setup(): { store: Store; jobs: Jobs; mailer: MemoryMailer; user: { id: string }; repo: { id: string } } {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, mailer)
  const user = makeUser(store, { login: 'redact-user', status: 'approved' })
  const repo = store.createRepo({ id: 'repo_redact', userId: user.id, owner: 'o', name: 'redact', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  return { store, jobs, mailer, user, repo }
}

test('a callback summary never stores a secret-shaped literal', async () => {
  const { store, jobs, user, repo } = setup()
  try {
    store.createJob({ id: 'job_redact', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(SECRET), platformTokenHash: '' })
    store.updateJob('job_redact', { status: 'running' })
    const result = await jobs.handleCallback('job_redact', SECRET, { status: 'succeeded', summary: `done: used ${TOKEN} and left it in the summary` })
    assert.equal(result.ok, true)
    const job = store.getJob('job_redact')
    assertClean(job?.summary, 'stored summary')
    assertClean(job?.continuity_json, 'stored digest')
    for (const event of store.listJobEvents('job_redact')) assertClean(event.meta, `event ${event.kind}`)
  } finally {
    store.close()
  }
})

test('a callback error and a JSON-shaped progress summary are redacted too', async () => {
  const { store, jobs, mailer, user, repo } = setup()
  try {
    store.createJob({ id: 'job_redact_json', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(SECRET), platformTokenHash: '' })
    store.updateJob('job_redact_json', { status: 'running' })
    const progress = await jobs.handleCallback('job_redact_json', SECRET, { status: 'running', summary: JSON.stringify({ summary: `step ${TOKEN}` }) })
    assert.equal(progress.ok, true)
    assertClean(store.getJob('job_redact_json')?.summary, 'json summary')
    for (const event of store.listJobEvents('job_redact_json')) assertClean(event.meta, `json event ${event.kind}`)

    // One active job per repository (db.ts `jobs_one_active_per_repo`), and the
    // progress job above is still running, so the failure job needs its own repo.
    const second = store.createRepo({ id: 'repo_redact_err', userId: user.id, owner: 'o', name: 'redact-err', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.createJob({ id: 'job_redact_err', repoId: second.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(SECRET), platformTokenHash: '' })
    store.updateJob('job_redact_err', { status: 'running' })
    const failed = await jobs.handleCallback('job_redact_err', SECRET, { status: 'failed', error: `boom ${TOKEN}` })
    assert.equal(failed.ok, true)
    assertClean(store.getJob('job_redact_err')?.error, 'stored error')
    assertClean(store.getJob('job_redact_err')?.continuity_json, 'failed digest')
    for (const event of store.listJobEvents('job_redact_err')) assertClean(event.meta, `failed event ${event.kind}`)
    // The failure mail is the third surface: the same text leaves the process.
    assert.ok(mailer.messages.length > 0, 'the failure mail was sent')
    for (const message of mailer.messages) assertClean(`${message.subject}\n${message.text}\n${message.html ?? ''}`, 'failure mail')
  } finally {
    store.close()
  }
})

test('redaction happens before the 4000-character cut', async () => {
  const { store, jobs, user, repo } = setup()
  try {
    store.createJob({ id: 'job_redact_cut', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(SECRET), platformTokenHash: '' })
    store.updateJob('job_redact_cut', { status: 'running' })
    // The token starts at character 3990, so a slice-then-redact keeps "ghp_" as
    // a fragment of the cut; redact-then-slice does not.
    const summary = `${'x'.repeat(3990)}${TOKEN} and the rest`
    const result = await jobs.handleCallback('job_redact_cut', SECRET, { status: 'running', summary })
    assert.equal(result.ok, true)
    const stored = store.getJob('job_redact_cut')?.summary ?? ''
    assert.ok(stored.length <= 4000)
    assertClean(stored, 'truncated summary')
  } finally {
    store.close()
  }
})

test('both store writers redact a summary written directly', () => {
  const { store, user, repo } = setup()
  try {
    store.createJob({ id: 'job_backstop', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_backstop', { summary: `direct ${TOKEN}` })
    assertClean(store.getJob('job_backstop')?.summary, 'updateJob summary')
    store.updateJob('job_backstop', { status: 'running' })
    assert.equal(store.claimJobTerminal('job_backstop', 'succeeded', null, { summary: `terminal ${TOKEN}` }), true)
    assertClean(store.getJob('job_backstop')?.summary, 'claimJobTerminal summary')
  } finally {
    store.close()
  }
})

test('a pre-change digest row carries no literal into the next job goal', () => {
  const { store, user, repo } = setup()
  try {
    store.createJob({ id: 'job_old_digest', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    // A row written before this change: the digest summary holds the raw value,
    // and the token straddles the 220-character carry-over cut.
    const summary = `${'y'.repeat(210)}${TOKEN} tail`
    store.run('UPDATE jobs SET continuity_json = ? WHERE id = ?', JSON.stringify({ schema_version: 1, summary }), 'job_old_digest')
    const row = store.getJob('job_old_digest')
    const carry = buildCarryOver({ recent: [row!] })
    assertClean(carry, 'carry-over block')
  } finally {
    store.close()
  }
})

test('the job page never renders a secret-shaped summary from an old row', () => {
  const config = testConfig()
  const { store, user, repo } = setup()
  try {
    store.createJob({ id: 'job_old_page', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    // Bypass the writers on purpose: this is a row stored before the fix.
    store.run('UPDATE jobs SET summary = ?, status = ? WHERE id = ?', `done ${TOKEN}`, 'succeeded', 'job_old_page')
    const job = store.getJob('job_old_page')!
    const html = jobPage({ config, locale: 'en', viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' }, repo: store.getRepo(repo.id)!, job, events: [] })
    assertClean(html, 'job page')
  } finally {
    store.close()
  }
})
