import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { parseAdversarialRecord } from '../src/lib/adversarialReview.js'
import { Jobs } from '../src/jobs/service.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

// #556 Slice A: the adversarial pass refuses when it could not read the whole
// change. Every test here is a shape that used to record `skipped` with
// `block: null` and let the automatic merge proceed.
const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

interface FileRow { filename: string; patch?: string }

// The fake repository: one pull request, one page of files (plus an optional
// empty second page for the truncated-listing case), and a recorded merge.
async function runPass(input: {
  changedFiles: number
  files: FileRow[]
  secondPageEmpty?: boolean
  model?: () => Promise<string>
  modelMode?: 'throw' | 'unconfigured'
}): Promise<{ merges: number; events: Array<{ step: string | null; meta: string | null }>; notifications: string[] }> {
  const merges: number[] = []
  const github = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    if (method === 'GET' && url === '/repos/o/r/pulls/1') {
      json(response, 200, {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        title: 'fix',
        state: 'open',
        head: { ref: 'fledge/fix', sha: HEAD },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean',
        draft: false,
        merged: false,
        changed_files: input.changedFiles,
      })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${HEAD}/check-runs?per_page=100`) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (method === 'GET' && url === `/repos/o/r/commits/${HEAD}/status`) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/reviews?per_page=100') {
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main') {
      json(response, 200, { name: 'main', commit: { sha: BASE } })
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/files?per_page=100&page=1') {
      json(response, 200, input.files.map((file) => ({ filename: file.filename, status: 'modified', additions: 1, deletions: 1, ...(file.patch === undefined ? {} : { patch: file.patch }) })))
      return
    }
    if (method === 'GET' && url === '/repos/o/r/pulls/1/files?per_page=100&page=2') {
      // An empty page makes the client stop below the reported count: the
      // listing really is incomplete, which is the shape this card refuses.
      json(response, 200, [])
      return
    }
    if (method === 'GET' && url === '/repos/o/r/branches/main/protection') {
      json(response, 200, { required_status_checks: { contexts: ['ci'] }, required_pull_request_reviews: { required_approving_review_count: 0 } })
      return
    }
    if (method === 'PUT' && url === '/repos/o/r/pulls/1/merge') {
      merges.push(1)
      json(response, 200, { merged: true, sha: 'def' })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url }, autoMerge: { ...base.autoMerge, reconcileMinutes: 0 } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'incomplete-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_incomplete', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey), permission: 'admin', repoRole: 'maintainer', autoMerge: true, upstreamHtmlUrl: 'https://github.com/o/r', forkHtmlUrl: 'https://github.com/o/r', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const secret = 'incomplete-secret'
    store.createJob({ id: 'job_incomplete', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex(secret), platformTokenHash: '', kind: 'iterate', baseBranch: 'main' })
    store.updateJob('job_incomplete', { status: 'running', branch: 'fledge/fix', started_at: new Date().toISOString() })
    if (input.modelMode === 'throw') jobs.adversarialModel = async () => { throw new Error('adversarial model answered HTTP 502') }
    else if (input.modelMode === 'unconfigured') jobs.adversarialModel = null
    else jobs.adversarialModel = input.model ?? (async () => 'No concrete risk\nChecks: read the diff')
    await jobs.handleCallback('job_incomplete', secret, { status: 'succeeded', prUrl: 'https://github.com/o/r/pull/1', summary: 'done' })
    const events = store.listJobEvents('job_incomplete')
      .filter((event) => event.kind === 'job.adversarial')
      .map((event) => ({ step: event.step, meta: event.meta }))
    const notifications = store.listNotifications(user.id).map((row) => row.message)
    return { merges: merges.length, events, notifications }
  } finally {
    store.close()
    await github.close()
  }
}

test('a diff cut at the character limit refuses the merge and names what it did not read', async () => {
  // The decoy is the whole first file and it is bigger than the cut, so the real
  // change never reaches the model. Before #556 this recorded `skipped` and merged.
  const decoy = 'diff --git a/src/decoy.ts b/src/decoy.ts\n@@ -0,0 +1 @@\n+' + 'x'.repeat(70_000)
  const result = await runPass({ changedFiles: 1, files: [{ filename: 'src/decoy.ts', patch: decoy }] })
  assert.equal(result.merges, 0, 'a cut diff is not a reviewed diff, so the merge is refused')
  const event = result.events.find((entry) => entry.step === 'incomplete')
  assert.ok(event !== undefined, 'the refusal is recorded as incomplete, not as a skip')
  const meta = JSON.parse(String(event?.meta ?? '{}')) as { truncated?: boolean; omittedFiles?: string[]; omittedBytes?: number }
  assert.equal(meta.truncated, true)
  assert.ok((meta.omittedBytes ?? 0) > 0, 'the record says how many bytes were not read')
  assert.ok((meta.omittedFiles ?? []).includes('src/decoy.ts'), 'the record names the file that was cut')
  // The page reads the record back: an incomplete pass stores a risk-shaped
  // verdict so the same tip re-blocks, but reporting that as a concrete risk
  // would claim the model named one it never named.
  assert.equal(parseAdversarialRecord(event?.meta)?.status, 'incomplete')
  // The notification and the merge message are the same report: a refusal must
  // not be announced as a concrete risk at a `:0` locator the model never named.
  assert.ok(result.notifications.some((row) => /未能读完整改动/.test(row)), 'the owner is told the pass could not read the change')
  assert.ok(result.notifications.every((row) => !/具体风险/.test(row)), 'a refusal is never announced as a concrete risk')
})

test('a cut diff refuses even when the model errors, because the cut is not the outage', async () => {
  // The cut is determinable from the change alone. Asking the model first and
  // letting its outage decide is the fail-open this card closes, reached through
  // the one carve-out that stays: an outage is not the author's fault, but an
  // unread diff is still unread, and its refusal cannot depend on the model.
  const decoy = 'diff --git a/src/decoy.ts b/src/decoy.ts\n@@ -0,0 +1 @@\n+' + 'x'.repeat(70_000)
  const result = await runPass({ changedFiles: 1, files: [{ filename: 'src/decoy.ts', patch: decoy }], modelMode: 'throw' })
  assert.equal(result.merges, 0, 'an outage must not convert a determinate refusal into a merge')
  const event = result.events.find((entry) => entry.step === 'incomplete')
  assert.ok(event !== undefined, 'the refusal is recorded as incomplete, not as an unavailable skip')
  const meta = JSON.parse(String(event?.meta ?? '{}')) as { truncated?: boolean; outage?: string }
  assert.equal(meta.truncated, true)
  assert.match(String(meta.outage ?? ''), /502/, 'the record keeps the outage that could not be asked')
})

test('an incomplete changed-file listing refuses instead of skipping', async () => {
  // 100 files on page 1, an empty page 2, and a pull request that reports 150:
  // the listing never reached the count, so the pass cannot claim it read it.
  const files: FileRow[] = Array.from({ length: 100 }, (_, index) => ({ filename: `src/f${index}.ts`, patch: '@@ -1 +1 @@\n-a\n+b' }))
  const result = await runPass({ changedFiles: 150, files })
  assert.equal(result.merges, 0, 'a truncated listing must not merge')
  const event = result.events.find((entry) => entry.step === 'incomplete')
  assert.ok(event !== undefined, 'the refusal is recorded as incomplete')
  assert.match(String(event?.meta ?? ''), /truncated/)
  assert.doesNotMatch(String(event?.meta ?? ''), /"status":"skipped"/)
})

test('a patch-less file outside the asset allowlist among readable ones refuses and names it', async () => {
  const result = await runPass({
    changedFiles: 2,
    files: [
      { filename: 'src/x.ts', patch: '@@ -1 +1 @@\n-const a = 0\n+const a = 1' },
      { filename: 'secrets/large.bin' },
    ],
  })
  assert.equal(result.merges, 0)
  const event = result.events.find((entry) => entry.step === 'incomplete')
  assert.ok(event !== undefined)
  assert.match(String(event?.meta ?? ''), /secrets\/large\.bin/)
})

test('a pull request whose every file is patch-less refuses instead of skipping', async () => {
  // Before #556 this produced an empty diff and took the `diff === ''` branch:
  // `skipped` with `block: null`, and the merge went through.
  const result = await runPass({ changedFiles: 2, files: [{ filename: 'data/a.bin' }, { filename: 'scripts/b.zip' }] })
  assert.equal(result.merges, 0, 'an all-patch-less non-asset change must not merge')
  const event = result.events.find((entry) => entry.step === 'incomplete')
  assert.ok(event !== undefined)
  const meta = String(event?.meta ?? '')
  assert.match(meta, /data\/a\.bin/)
  assert.match(meta, /scripts\/b\.zip/)
})

test('an image-only pull request still merges, and the record says the files were unread', async () => {
  // The exemption that keeps screenshot PRs alive: assets under public/ or docs/
  // cannot be read by a text model, and refusing them would block a class of
  // change this gate was never meant to judge.
  const result = await runPass({ changedFiles: 1, files: [{ filename: 'public/shots/after.png' }] })
  assert.equal(result.merges, 1, 'an asset-only change keeps auto-merging')
  const skipped = result.events.find((entry) => entry.step === 'skipped')
  assert.ok(skipped !== undefined, 'the skip is recorded, not silent')
  assert.match(String(skipped?.meta ?? ''), /public\/shots\/after\.png/)
})

test('a binary asset alongside readable code is reviewed and merges', async () => {
  const result = await runPass({
    changedFiles: 2,
    files: [
      { filename: 'docs/logo.png' },
      { filename: 'src/x.ts', patch: '@@ -1 +1 @@\n-const a = 0\n+const a = 1' },
    ],
  })
  assert.equal(result.merges, 1, 'the readable half is still reviewed, and the asset does not block it')
  const reviewed = result.events.find((entry) => entry.step === 'none')
  assert.ok(reviewed !== undefined, 'the model saw the readable file and answered')
})

test('a model error stays fail-open with a recorded reason', async () => {
  // A change cannot cause the model to fail, so this refusal would punish the
  // author for an outage. It stays a skip and the merge proceeds (#556 keeps it).
  const result = await runPass({ changedFiles: 1, files: [{ filename: 'src/x.ts', patch: '@@ -1 +1 @@\n-a\n+b' }], modelMode: 'throw' })
  assert.equal(result.merges, 1, 'a model error is not a reason to block a change')
  const event = result.events.find((entry) => entry.step === 'unavailable')
  assert.ok(event !== undefined, 'the outage is recorded, not swallowed')
  assert.match(String(event?.meta ?? ''), /502/)
})

test('an unconfigured platform model stays fail-open with a recorded reason', async () => {
  const result = await runPass({ changedFiles: 1, files: [{ filename: 'src/x.ts', patch: '@@ -1 +1 @@\n-a\n+b' }], modelMode: 'unconfigured' })
  assert.equal(result.merges, 1, 'an unconfigured model is not a reason to block a change')
  const event = result.events.find((entry) => entry.step === 'skipped')
  assert.ok(event !== undefined)
  assert.match(String(event?.meta ?? ''), /not configured/)
})
