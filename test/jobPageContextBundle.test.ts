import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/db.js'
import { compileContextBundle } from '../src/lib/contextBundle.js'
import type { InstructionContractInput } from '../src/lib/instructions.js'
import { jobPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #369: the card is rendered HTML, so its verdicts are asserted on the page a
// reader opens rather than only on the module that computes them. The three
// states the card can print are driven from the stored row, exactly as the
// route hands it over.

function fixture(store: Store, name: string) {
  const user = makeUser(store, { login: `${name}-owner`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${name}`, userId: user.id, owner: 'o', name, defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  return { userId: user.id, repoId: repo.id, repo, viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' } }
}

function instructions(overrides: Partial<InstructionContractInput> = {}): InstructionContractInput {
  return {
    repo: { id: 'repo_bundle_page', fullName: 'o/bundle-page', defaultBranch: 'main' },
    goal: 'fix the job page',
    playbook: { version: '8', hash: 'a'.repeat(40) },
    contextFiles: [{ path: 'AGENTS.md', sha: 'b'.repeat(40) }],
    paths: { allow: ['src/'], deny: ['deploy/'] },
    branch: { base: 'main', name: 'dev/369' },
    required: { evidence: ['npm run check'], sections: ['Ran:'] },
    forbidden: ['force-push'],
    carryOver: ['earlier turn'],
    model: { provider: 'deepseek', name: 'DeepSeek-V4.1-Flash-1017' },
    role: 'developer',
    ...overrides,
  }
}

function bundleJob(store: Store, repoId: string, userId: string, id: string, input: InstructionContractInput): { id: string; hash: string; json: string } {
  const { bundle, hash } = compileContextBundle(input)
  const json = JSON.stringify(bundle)
  store.createJob({
    id, repoId, userId, trigger: 'manual', goal: input.goal,
    callbackHash: `cbh_${id}`, platformTokenHash: '',
    contextBundle: { hash, json },
  })
  return { id, hash, json }
}

test('the job page prints the bundle hash and says a missing echo is not a pass', () => {
  const store = new Store(':memory:')
  try {
    const f = fixture(store, 'bundle-page-missing')
    const recorded = bundleJob(store, f.repo.id, f.userId, 'job_page_bundle_missing', instructions())
    store.updateJob(recorded.id, { context_bundle_state: 'missing' })
    const page = jobPage({
      config: testConfig(), locale: 'en', viewer: f.viewer, repo: f.repo,
      job: store.getJob(recorded.id)!,
    })
    assert.match(page, /Context bundle/)
    assert.match(page, /Bundle hash/)
    assert.ok(page.includes(`<code>${recorded.hash}</code>`), 'the card prints the recorded bundle hash')
    assert.match(page, /The callback echoed no bundle hash, so the policy the run read cannot be confirmed\./)
    assert.doesNotMatch(page, /The callback echoed the same hash\./)
    assert.doesNotMatch(page, /The callback echoed a different bundle hash/)
  } finally {
    store.close()
  }
})

test('the job page refuses a bundle whose stored bytes disagree with the recorded hash', () => {
  const store = new Store(':memory:')
  try {
    const f = fixture(store, 'bundle-page-mismatch')
    const recorded = bundleJob(store, f.repo.id, f.userId, 'job_page_bundle_mismatch', instructions())
    const other = compileContextBundle(instructions({ goal: 'ship a different policy' }))
    // The row keeps the first bundle's hash while holding the second bundle's
    // bytes: the exact case a self-verifying bundle would pass.
    store.updateJob(recorded.id, {
      context_bundle_json: JSON.stringify(other.bundle),
      context_bundle_state: 'mismatch',
    })
    const page = jobPage({
      config: testConfig(), locale: 'en', viewer: f.viewer, repo: f.repo,
      job: store.getJob(recorded.id)!,
    })
    assert.match(page, /data-context-bundle-mismatch/)
    assert.match(page, /The record and the bytes disagree, so this is not verified\./)
    assert.doesNotMatch(page, /Recomputed from the stored bytes and it matches the hash the job records\./)
    assert.doesNotMatch(page, /The callback echoed the same hash\./)
    assert.ok(page.includes(`<code>${recorded.hash}</code>`), 'the refusal still names the hash the job records')
    assert.ok(page.includes(other.hash), 'the refusal names the hash the stored bytes produce')
  } finally {
    store.close()
  }
})

// #1129: the row's echo column is the callback's own claim, and the byte verdict
// is computed independently. A card that refuses the bytes and then confirms them
// in the next sentence contradicts itself, so every sentence is asserted on the
// card slice rather than anywhere on the page.
function card(page: string): string {
  const start = page.indexOf('id="job-context-bundle"')
  assert.notEqual(start, -1, 'the page renders the bundle card')
  return page.slice(start, page.indexOf('</section>', start))
}

test('a tampered bundle whose row still says the echo verified prints no unscoped confirmation', () => {
  const store = new Store(':memory:')
  try {
    const f = fixture(store, 'bundle-page-tampered-verified')
    const previous = bundleJob(store, f.repo.id, f.userId, 'job_page_tampered_previous', instructions())
    store.updateJob(previous.id, { status: 'succeeded' })
    const current = bundleJob(store, f.repo.id, f.userId, 'job_page_tampered_current', instructions({ goal: 'ship the bundle card' }))
    const other = compileContextBundle(instructions({ goal: 'ship a different policy' }))
    // The row keeps its best case: the callback's claim still reads `verified`
    // while the stored bytes belong to another bundle.
    store.updateJob(current.id, {
      context_bundle_json: JSON.stringify(other.bundle),
      context_bundle_state: 'verified',
    })
    const page = jobPage({
      config: testConfig(), locale: 'en', viewer: f.viewer, repo: f.repo,
      job: store.getJob(current.id)!, previousJob: store.getJob(previous.id)!,
    })
    const bundle = card(page)
    assert.match(bundle, /data-context-bundle-mismatch/)
    assert.doesNotMatch(bundle, /The callback echoed the same hash\./)
    assert.ok(bundle.includes('The callback reported the same hash as the record; the stored bytes do not verify, so this report is not evidence about them.'))
    assert.ok(bundle.includes('Changed since the previous bundle, read from the stored bytes that did not verify'))
    assert.doesNotMatch(bundle, /<h3 class="mt-16">Changed since the previous bundle<\/h3>/, 'the plain heading cannot stand beside a failed byte verdict')
    assert.match(bundle, /<th>Field<\/th>/, 'the table is relabelled, not removed')
  } finally {
    store.close()
  }
})

test('the job page does not call unreadable stored bytes a first or identical bundle', () => {
  const store = new Store(':memory:')
  try {
    const f = fixture(store, 'bundle-page-unreadable')
    const previous = bundleJob(store, f.repo.id, f.userId, 'job_page_unreadable_previous', instructions())
    store.updateJob(previous.id, { status: 'succeeded' })
    const current = bundleJob(store, f.repo.id, f.userId, 'job_page_unreadable_current', instructions({ goal: 'ship the bundle card' }))
    store.updateJob(current.id, { context_bundle_json: '{not json' })
    const page = jobPage({
      config: testConfig(), locale: 'en', viewer: f.viewer, repo: f.repo,
      job: store.getJob(current.id)!, previousJob: store.getJob(previous.id)!,
    })
    const bundle = card(page)
    assert.match(bundle, /data-context-bundle-mismatch/)
    assert.doesNotMatch(bundle, /This is the first bundle recorded for the repository\./)
    assert.doesNotMatch(bundle, /Identical to the previous job’s bundle\./)
    assert.ok(bundle.includes('No bundle could be read from the stored bytes, so there is nothing to compare.'))
  } finally {
    store.close()
  }
})

test('a verified bundle keeps its echo confirmation and the plain diff heading', () => {
  const store = new Store(':memory:')
  try {
    const f = fixture(store, 'bundle-page-control')
    const previous = bundleJob(store, f.repo.id, f.userId, 'job_page_control_previous', instructions())
    store.updateJob(previous.id, { status: 'succeeded' })
    const current = bundleJob(store, f.repo.id, f.userId, 'job_page_control_current', instructions({ goal: 'ship the bundle card' }))
    store.updateJob(current.id, { context_bundle_state: 'verified' })
    const page = jobPage({
      config: testConfig(), locale: 'en', viewer: f.viewer, repo: f.repo,
      job: store.getJob(current.id)!, previousJob: store.getJob(previous.id)!,
    })
    const bundle = card(page)
    assert.ok(bundle.includes('Recomputed from the stored bytes and it matches the hash the job records.'))
    assert.ok(bundle.includes('The callback echoed the same hash.'))
    assert.doesNotMatch(bundle, /The callback reported the same hash as the record;/)
    assert.match(bundle, /<h3 class="mt-16">Changed since the previous bundle<\/h3>/)
  } finally {
    store.close()
  }
})

test('the job page lists the previous-bundle changes in the contract order', () => {
  const store = new Store(':memory:')
  try {
    const f = fixture(store, 'bundle-page-diff')
    const previous = bundleJob(store, f.repo.id, f.userId, 'job_page_bundle_previous', instructions())
    // One active job per repository, so the previous one has to be finished
    // before the next row can exist.
    store.updateJob(previous.id, { status: 'succeeded' })
    const current = bundleJob(store, f.repo.id, f.userId, 'job_page_bundle_current', instructions({
      goal: 'ship the bundle card',
      paths: { allow: ['src/'], deny: ['deploy/', 'data/'] },
      branch: { base: 'release', name: 'dev/369' },
      required: { evidence: ['npm run check', 'npx tsx --test test/jobPageContextBundle.test.ts'], sections: ['Ran:'] },
    }))
    const page = jobPage({
      config: testConfig(), locale: 'en', viewer: f.viewer, repo: f.repo,
      job: store.getJob(current.id)!, previousJob: store.getJob(previous.id)!,
    })
    const start = page.indexOf('id="job-context-bundle"')
    assert.notEqual(start, -1, 'the page renders the bundle card')
    const card = page.slice(start, page.indexOf('</section>', start))
    assert.match(card, /Changed since the previous bundle/)
    const fields = [...card.matchAll(/<td><code>([^<]+)<\/code><\/td>/g)].map((match) => match[1])
    assert.deepEqual(fields, ['goal', 'paths.deny', 'branch.base', 'required.evidence', 'contractHash'])
    assert.ok(card.includes('data/, deploy/'), 'the changed deny list is shown')
  } finally {
    store.close()
  }
})
