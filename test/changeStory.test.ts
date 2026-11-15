import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { changeStoryFacts, readChangeStory } from '../src/lib/changeStory.js'
import { summarizePullRequestFiles } from '../src/repos/github.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #373 slice 1: the job page is where a maintainer decides. It showed the
// checks and the structured evidence, but not the three sentences the agent
// already wrote into the pull request body — what changed, what could go wrong,
// what it ran — nor how large the diff is. The block below is a read model over
// data GitHub already holds: no model call, no summary of a summary.

const storyOf = (
  body: string | null,
  files: Array<{ additions: number; deletions: number }> = [],
  complete = true,
) => readChangeStory({
  body,
  totals: complete ? summarizePullRequestFiles(files) : null,
  diffState: complete ? 'ok' : 'capped',
})

const COMPLETE = [
  '## What changed',
  'The job page renders a read model over the pull request.',
  '',
  '## Risks',
  'One extra GitHub read per page view; it is cached for 60 seconds.',
  '',
  '## Ran',
  '- `npm run check` — pass',
].join('\n')

test('a complete body yields the three sections with their own text', () => {
  const story = storyOf(COMPLETE)
  assert.equal(story.bodyState, 'ok')
  assert.deepEqual(story.sections.map((section) => section.key), ['whatChanged', 'risks', 'ran'])
  const byKey = new Map(story.sections.map((section) => [section.key, section]))
  assert.equal(byKey.get('whatChanged')?.text, 'The job page renders a read model over the pull request.')
  assert.match(byKey.get('risks')?.text ?? '', /cached for 60 seconds/)
  assert.match(byKey.get('ran')?.text ?? '', /npm run check/)
  assert.equal(byKey.get('risks')?.duplicated, false)
})

test('a repeated heading keeps the last occurrence and reports the duplicate', () => {
  const body = ['## Risks', 'first answer', '## Risks', 'second answer'].join('\n')
  const story = storyOf(body)
  const risks = story.sections.find((section) => section.key === 'risks')
  assert.equal(risks?.text, 'second answer')
  assert.equal(risks?.duplicated, true)
  const fact = changeStoryFacts(story).find((entry) => entry.key === 'risks')
  assert.match(fact?.note ?? '', /repeated/i, 'the block says the heading was repeated')
})

test('an empty body renders not stated three times and still lists every fact', () => {
  const story = storyOf('')
  const facts = changeStoryFacts(story)
  assert.deepEqual(facts.map((fact) => fact.key), ['whatChanged', 'risks', 'ran', 'diff'])
  assert.deepEqual(facts.slice(0, 3).map((fact) => fact.value), ['not stated', 'not stated', 'not stated'])
})

test('a heading the body does not carry is not stated, and is never filled from another section', () => {
  const body = ['## What changed', 'only this one', '## Ran', '- tests'].join('\n')
  const facts = changeStoryFacts(storyOf(body))
  const risks = facts.find((fact) => fact.key === 'risks')
  assert.equal(risks?.value, 'not stated')
  assert.doesNotMatch(risks?.value ?? '', /only this one/)
})

test('the diff line sums the file list', () => {
  const files = [
    { additions: 10, deletions: 2 },
    { additions: 4, deletions: 0 },
    { additions: 1, deletions: 1 },
  ]
  const totals = summarizePullRequestFiles(files)
  assert.deepEqual(totals, { files: 3, additions: 15, deletions: 3 })
  const facts = changeStoryFacts(storyOf(COMPLETE, files))
  assert.equal(facts.find((fact) => fact.key === 'diff')?.value, '3 files +15 −3')
})

test('a capped file list makes the diff unavailable instead of wrong', () => {
  const files = [{ additions: 10, deletions: 2 }]
  const story = storyOf(COMPLETE, files, false)
  assert.equal(story.totals, null)
  assert.equal(story.diffState, 'capped')
  const fact = changeStoryFacts(story).find((entry) => entry.key === 'diff')
  assert.match(fact?.value ?? '', /cap/i)
  // The three sections are still readable: one unavailable fact does not hide the others.
  assert.deepEqual(
    changeStoryFacts(story).slice(0, 3).map((entry) => entry.value.includes('not stated')),
    [false, false, false],
  )
})

test('a pull request that could not be read says which fact is unavailable', () => {
  const story = readChangeStory({ body: null, totals: null, diffState: 'unreadable' })
  assert.equal(story.bodyState, 'unreadable')
  assert.equal(story.diffState, 'unreadable')
  const facts = changeStoryFacts(story)
  assert.equal(facts.length, 4)
  assert.deepEqual(facts.map((fact) => fact.value), ['not available', 'not available', 'not available', 'not available'])
})

test('the bare Ran: line the house PR template uses is read like the heading', () => {
  const body = ['## What changed', 'something', 'Ran:', '- `npm run check` — pass', 'Not run:', '- Docker'].join('\n')
  const story = storyOf(body)
  const ran = story.sections.find((section) => section.key === 'ran')
  assert.match(ran?.text ?? '', /npm run check/)
  assert.doesNotMatch(ran?.text ?? '', /Docker/, 'Not run: belongs to no section and must not be swallowed')
})

test('a value from the body is escaped by the page, never rendered as markup', async () => {
  const github = await startFakeServer((request, response) => {
    if ((request.url ?? '').startsWith('/repos/acme/demo/pulls/9/files')) {
      json(response, 200, [{ filename: 'src/a.ts', additions: 1, deletions: 0 }])
      return
    }
    if ((request.url ?? '').startsWith('/repos/acme/demo/pulls/9')) {
      json(response, 200, {
        number: 9,
        html_url: 'https://github.com/acme/demo/pull/9',
        title: 't',
        state: 'open',
        head: { ref: 'dev1/x', sha: 'a'.repeat(40) },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'blocked',
        draft: false,
        merged: false,
        changed_files: 1,
        body: ['## What changed', '<b>bold</b>', '## Risks', 'none', '## Ran', '- tests'].join('\n'),
      })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const { repo, user } = fixture(store, config, { upstreamHtmlUrl: 'https://github.com' })
    const job = store.createJob({ id: 'job_story', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-story', platformTokenHash: '' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'dev1/x', pr_url: 'https://github.com/acme/demo/pull/9' })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Why this change/)
    assert.match(page.body, /What changed/)
    assert.match(page.body, /&lt;b&gt;bold&lt;\/b&gt;/, 'the body text is shown escaped')
    assert.doesNotMatch(page.body, /<b>bold<\/b>/)
    assert.match(page.body, /1 files \+1 −0/)
  } finally {
    await built.app.close()
    await github.close()
    store.close()
  }
})

test('a pull request read that 404s keeps the page at 200 and says the fact is unavailable', async () => {
  let calls = 0
  const github = await startFakeServer((_request: IncomingMessage, response: ServerResponse) => {
    calls += 1
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const { repo, user } = fixture(store, config, { upstreamHtmlUrl: 'https://github.com' })
    const job = store.createJob({ id: 'job_story_404', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-404', platformTokenHash: '' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'dev1/x', pr_url: 'https://github.com/acme/demo/pull/9' })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200, 'a GitHub hiccup must not take the page down')
    assert.match(page.body, /Why this change/)
    assert.match(page.body, /not available/)
    assert.ok(calls > 0, 'the read happened and its failure is what the block reports')
  } finally {
    await built.app.close()
    await github.close()
    store.close()
  }
})

test('a job without a pull request makes no GitHub read at all', async () => {
  let calls = 0
  const github = await startFakeServer((_request: IncomingMessage, response: ServerResponse) => {
    calls += 1
    json(response, 404, { message: 'not found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const { repo, user } = fixture(store, config, { upstreamHtmlUrl: 'https://github.com' })
    const job = store.createJob({ id: 'job_no_pr', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-nopr', platformTokenHash: '' })
    store.updateJob(job.id, { status: 'succeeded' })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.equal(calls, 0, 'no pull request means no read and no budget spent')
    assert.doesNotMatch(page.body, /Why this change/)
  } finally {
    await built.app.close()
    await github.close()
    store.close()
  }
})

function fixture(
  store: Store,
  config: ReturnType<typeof testConfig>,
  extra: { upstreamHtmlUrl?: string } = {},
): { repo: ReturnType<Store['createRepo']>; user: ReturnType<typeof makeUser> } {
  const user = makeUser(store, { login: `story-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_story_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    upstreamHtmlUrl: extra.upstreamHtmlUrl ?? '',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { repo, user }
}
