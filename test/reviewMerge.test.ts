import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { JobRow, RepoRow } from '../src/db.js'
import { jobPage, repoPage } from '../src/views/pages.js'
import { makeTerminalJob, makeUser, testConfig } from './helpers.js'

// #264: review -> merge is the riskiest step of the loop, and the console spread
// it over five places — so the job page could not answer "what is the one thing
// to do now", and a verdict recorded at an older tip only surfaced when the
// merge was refused. These tests pin the one card: one sentence, one action, and
// a named state for a stale verdict, a moved base and a blocked check.

const SHA_TIP = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const SHA_OLD = '00112233445566778899aabbccddeeff00112233'

function verification(input: {
  sha?: string
  ok?: boolean
  failing?: string[]
  pending?: string[]
  changesRequested?: boolean
  mergeableState?: string
  reasons?: string[]
  ruleChange?: { paths: string[]; acknowledged: boolean }
}): string {
  const failing = input.failing ?? []
  const pending = input.pending ?? []
  return JSON.stringify({
    ok: input.ok ?? true,
    checkedAt: '2026-11-16T09:00:00.000Z',
    sha: input.sha ?? SHA_TIP,
    prState: 'open',
    draft: false,
    mergeableState: input.mergeableState ?? 'clean',
    checks: { total: failing.length + pending.length + 2, green: 2, failing, pending },
    combinedStatus: 'success',
    reviews: { changesRequested: input.changesRequested ?? false, approvals: 1 },
    testEvidence: { state: 'verified', claimed: true, greenChecks: ['tests'], failingChecks: [] },
    reasons: input.reasons ?? [],
    ...(input.ruleChange === undefined ? {} : { ruleChange: input.ruleChange }),
  })
}

const GUARD_OK = JSON.stringify({ ok: true, checkedFiles: 3, reportedFiles: 3, files: ['src/a.ts'], violations: [], allow: [], deny: [], truncated: false })

function fixture(input: {
  status?: JobRow['status']
  role?: 'maintainer' | 'developer'
  verificationJson?: string | null
  guardJson?: string | null
} = {}): { store: Store; repo: RepoRow; job: JobRow; close: () => void } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'review-merge-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_review_merge',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: input.role ?? 'maintainer',
    roleCheckedAt: new Date().toISOString(),
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const job = makeTerminalJob(store, {
    id: 'job_review_merge',
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: 'cb',
    platformTokenHash: '',
    kind: 'iterate',
    baseBranch: 'main',
  })
  store.updateJob(job.id, {
    status: input.status ?? 'succeeded',
    branch: 'fledge/fix',
    pr_url: 'https://github.com/o/r/pull/9',
    base_sha: SHA_OLD,
    ...(input.verificationJson === undefined ? { verification_json: verification({}) } : { verification_json: input.verificationJson }),
    ...(input.guardJson === undefined ? { path_guard_json: GUARD_OK } : { path_guard_json: input.guardJson }),
  })
  return {
    store,
    repo,
    job: store.getJob(job.id)!,
    close: () => store.close(),
  }
}

function render(input: {
  locale?: 'en' | 'zh'
  mergeableState?: string
  tip?: { headSha: string } | null
  merge?: boolean
  viewerRole?: 'maintainer' | 'developer' | 'viewer'
  events?: Parameters<typeof jobPage>[0]['events']
} & Parameters<typeof fixture>[0] = {}): string {
  const { store, repo, job, close } = fixture(input)
  try {
    return jobPage({
      config: testConfig(),
      locale: input.locale ?? 'en',
      viewer: { user: store.userById(job.user_id)!, csrfToken: 'csrf' },
      repo,
      job,
      pullTip: input.tip === undefined
        ? { headSha: SHA_TIP, state: 'open', draft: false, mergeableState: input.mergeableState ?? 'clean' }
        : input.tip === null ? null : { headSha: input.tip.headSha, state: 'open', draft: false, mergeableState: input.mergeableState ?? 'clean' },
      merge: input.merge === false ? undefined : { revision: 3, idempotencyKey: 'cmd-review-merge' },
      // #1132: the card is drawn for the actor's role; these fixtures render
      // directly, so they pass the value the route would have resolved.
      viewerRole: input.viewerRole ?? (input.role === 'developer' ? 'developer' : 'maintainer'),
      events: input.events,
    })
  } finally {
    close()
  }
}

function mergeForms(html: string): string[] {
  return [...html.matchAll(/<form[^>]+action="[^"]+\/merge"/g)].map((match) => match[0])
}

function stateOf(html: string): string | null {
  return /data-merge-state="([^"]+)"/.exec(html)?.[1] ?? null
}

test('a verified pull request at the current tip offers exactly one merge action', () => {
  const html = render()
  assert.equal(stateOf(html), 'merge')
  assert.match(html, /data-review-merge/, 'the card is on the page')
  assert.match(html, new RegExp(SHA_TIP), 'the head sha the verdict is pinned to is on the card')
  assert.equal(mergeForms(html).length, 1, 'one merge control, not two')
  assert.match(html, /idempotency_key" value="cmd-review-merge"/, 'the merge is the same command the repository page sends')
  assert.match(html, /name="expected_revision" value="3"/)
})

test('a verdict recorded at an older tip is refused as stale and explained', () => {
  const html = render({ verificationJson: verification({ sha: SHA_OLD }) })
  assert.equal(stateOf(html), 'stale')
  assert.match(html, new RegExp(SHA_OLD), 'the tip the verdict names is shown')
  assert.match(html, new RegExp(SHA_TIP), 'the tip the pull request is at now is shown')
  assert.equal(mergeForms(html).length, 0, 'a stale verdict never renders the merge control')
  assert.match(html, /action="[^"]+\/recheck"/, 'the one action is the re-check that records a fresh verdict')
})

test('a base that moved after the check has its own named state', () => {
  const html = render({ mergeableState: 'behind' })
  assert.equal(stateOf(html), 'moved-base')
  assert.equal(mergeForms(html).length, 0)
  assert.match(html, /behind/)
})

test('a failing check is a fix state that names the check', () => {
  const html = render({ verificationJson: verification({ ok: false, failing: ['review-gate'], reasons: ['Failing checks: review-gate'] }) })
  assert.equal(stateOf(html), 'checks')
  assert.equal(mergeForms(html).length, 0)
  assert.match(html, /review-gate/)
})

test('a pending check is the wait state, not a merge state', () => {
  const html = render({ verificationJson: verification({ pending: ['ci-ok'] }) })
  assert.equal(stateOf(html), 'checks')
  assert.equal(mergeForms(html).length, 0)
  assert.match(html, /ci-ok/)
})

test('no verdict yet is the review state with the re-check as its one action', () => {
  const html = render({ verificationJson: null, guardJson: null })
  assert.equal(stateOf(html), 'review')
  assert.equal(mergeForms(html).length, 0)
  assert.match(html, /action="[^"]+\/recheck"/)
})

test('a developer actor sees the state but never the merge control', () => {
  const html = render({ role: 'developer' })
  assert.equal(stateOf(html), 'blocked')
  assert.equal(mergeForms(html).length, 0)
})

test('a queued job answers with its queue state and no action', () => {
  const html = render({ status: 'queued' })
  assert.equal(stateOf(html), 'waiting')
  assert.equal(mergeForms(html).length, 0)
})

test('the card is bilingual: the same state reads in English and in Chinese', () => {
  const english = render({ locale: 'en' })
  const chinese = render({ locale: 'zh' })
  assert.equal(stateOf(english), 'merge')
  assert.equal(stateOf(chinese), 'merge')
  assert.match(english, /merge/i)
  assert.match(chinese, /合并/)
  assert.notEqual(english.match(/data-review-merge[\s\S]{0,400}/)?.[0], chinese.match(/data-review-merge[\s\S]{0,400}/)?.[0], 'the sentence is translated, not a copy of the other language')
})

test('the card keeps the four evidence facts in one place', () => {
  const html = render()
  const card = /data-review-merge[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
  assert.match(card, new RegExp(SHA_TIP), 'head sha')
  assert.match(card, /Verdict/, 'the verdict and the tip it names')
  assert.match(card, /Checks/, 'checks')
  assert.match(card, /[Pp]ath/, 'the path guard')
  assert.match(card, /[Bb]ase/, 'base movement')
  assert.match(card, /[Qq]ueue/, 'the queue state')
})

test('the repository page links to the card instead of holding a second merge control', () => {
  const { store, repo, job, close } = fixture()
  try {
    const html = repoPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(job.user_id)!, csrfToken: 'csrf' },
      repo,
      jobs: [job],
      prJobs: [job],
    })
    assert.equal(mergeForms(html).length, 0, 'no merge form is left on the repository page')
    assert.match(html, new RegExp(`/repos/${repo.id}/jobs/${job.id}#review-merge`), 'the row points at the card')
    assert.match(html, /Review and merge/)
  } finally {
    close()
  }
})
