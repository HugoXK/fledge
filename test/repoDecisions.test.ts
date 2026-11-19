import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type AlertView, type JobRow, type RepoRow, type UserRow } from '../src/db.js'
import { dashboardPage, type InboxQuestion } from '../src/views/pages.js'
import type { Locale } from '../src/i18n.js'
import { makeUser, testConfig } from './helpers.js'

// #655: the home answers "what needs me now?" once per repository. The single
// card it used to carry named one action for the whole account, so a second
// repository with a pending question waited behind whichever repository the
// store happened to return first. These cases read the queue by repository, so
// one row gaining an action cannot hide another repository's answer.

const config = testConfig()

const CJK = /[\u4e00-\u9fff]/

interface Seed {
  repos: RepoRow[]
  jobs?: JobRow[]
  questions?: InboxQuestion[]
  alerts?: AlertView[]
}

function render(locale: Locale, seed: (store: Store, user: UserRow) => Seed): string {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'repo-decisions', status: 'approved' })
    const seeded = seed(store, user)
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    return dashboardPage({
      config,
      locale,
      viewer,
      repos: seeded.repos,
      jobs: [],
      // The route reads each repository's own newest runs, not the paged slice.
      decisionJobs: seeded.jobs ?? [],
      notifications: [],
      alerts: seeded.alerts ?? [],
      questions: seeded.questions ?? [],
    })
  } finally {
    store.close()
  }
}

function queue(html: string): string {
  return html.match(/<section class="card" id="decisions"[\s\S]*?<\/section>/)?.[0] ?? ''
}

function rows(html: string): string[] {
  return queue(html).match(/<li class="decision-row"[\s\S]*?<\/li>/g) ?? []
}

function rowFor(html: string, repoId: string): string {
  return rows(html).find((row) => row.includes(`data-decision-repo="${repoId}"`)) ?? ''
}

function repo(store: Store, userId: string, id: string, name: string): RepoRow {
  return store.createRepo({ id, userId, owner: 'o', name, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'developer', goal: '', autoIterate: true, intervalMinutes: 60 })
}

function question(repoId: string, repoLabel: string): InboxQuestion {
  return {
    id: `q_${repoId}`,
    sessionId: 'session_1',
    question: 'Which branch should the fix land on?',
    detail: '',
    options: [],
    multiSelect: false,
    repoId,
    repoLabel,
  }
}

test('each repository gets its own row, and the answer outranks the failure', () => {
  const html = render('en', (store, user) => {
    const asked = repo(store, user.id, 'repo_asked', 'asked')
    const broken = repo(store, user.id, 'repo_broken', 'broken')
    store.createJob({ id: 'job_broken', repoId: broken.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_broken', { status: 'failed', error: 'bridge refused the run' })
    return {
      repos: [broken, asked],
      jobs: store.listJobsForRepo(broken.id, 5),
      questions: [question(asked.id, 'o/asked')],
    }
  })
  const ordered = rows(html)
  assert.equal(ordered.length, 2, 'one row per repository')
  assert.match(ordered[0]!, /data-decision="question"/, 'the repository waiting on an answer comes first')
  assert.match(ordered[1]!, /data-decision="job"/, 'the failed job follows it')
  assert.ok(ordered[0]!.includes('data-decision-repo="repo_asked"'))
})

test('one repository carries one primary action even when several things are open', () => {
  const html = render('en', (store, user) => {
    const target = repo(store, user.id, 'repo_both', 'both')
    store.createJob({ id: 'job_both', repoId: target.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_both', { status: 'failed', error: 'bridge refused the run' })
    return {
      repos: [target],
      jobs: store.listJobsForRepo(target.id, 5),
      questions: [question(target.id, 'o/both')],
      alerts: [{ kind: 'job_stalled', level: 'critical', repoId: target.id, jobId: 'job_both', minutes: 30, message: 'stalled' }],
    }
  })
  const row = rowFor(html, 'repo_both')
  assert.match(row, /data-decision="question"/, 'the question is the one action')
  assert.equal((row.match(/data-decision-action/g) ?? []).length, 1, 'the row names one action, not one per open signal')
  assert.equal((row.match(/class="btn"/g) ?? []).length, 0, 'the page keeps its single primary button in the headline card')
  // The two signals the row does not lead with are still on the page, so nothing
  // is silently dropped: the attention table keeps them.
  assert.match(html, /id="attention"/)
})

test('a repository that needs nothing is calm: no button, and it names the next automatic run', () => {
  const html = render('en', (store, user) => {
    const quiet = repo(store, user.id, 'repo_quiet', 'quiet')
    return { repos: [quiet], jobs: [] }
  })
  const row = rowFor(html, 'repo_quiet')
  assert.match(row, /data-decision="growing"/)
  assert.equal((row.match(/data-decision-action/g) ?? []).length, 0, 'a calm row offers nothing to press')
  assert.match(row, /Next automatic run:/, 'it says when the platform runs here on its own')
  assert.match(row, /Nothing has run yet\./, 'and that nothing has run, instead of a zero')
})

test('a failure outside the visible job table still reaches the queue', () => {
  const html = render('en', (store, user) => {
    const hidden = repo(store, user.id, 'repo_hidden', 'hidden')
    store.createJob({ id: 'job_hidden', repoId: hidden.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob('job_hidden', { status: 'failed', error: 'bridge refused the run' })
    return { repos: [hidden], jobs: store.listJobsForRepo(hidden.id, 5) }
  })
  assert.match(rowFor(html, 'repo_hidden'), /data-decision="job"/)
  assert.match(queue(html), /\/repos\/repo_hidden\/jobs\/job_hidden/, 'the row links the failed job itself')
})

test('the queue speaks the page language and names no internal code', () => {
  const html = render('en', (store, user) => {
    const target = repo(store, user.id, 'repo_en', 'en')
    return { repos: [target], jobs: [], questions: [question(target.id, 'o/en')] }
  })
  const block = queue(html)
  assert.equal(CJK.test(block), false, 'an English queue carries no Chinese sentence')
  for (const code of ['JOB_ACTIVE', 'stage_evidence', 'PR_READY']) {
    assert.equal(block.includes(code), false, `no internal code (${code}) in the primary path`)
  }
})
