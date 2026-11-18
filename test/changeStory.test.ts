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
  assert.deepEqual(story.sections.map((section) => section.key), ['whatChanged', 'risks', 'ran', 'alternatives', 'uncertainty', 'notVerified'])
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

test('an empty body renders not stated for every body fact and still lists every fact', () => {
  const story = storyOf('')
  const facts = changeStoryFacts(story)
  assert.deepEqual(facts.map((fact) => fact.key), ['whatChanged', 'risks', 'ran', 'alternatives', 'uncertainty', 'notVerified', 'diff', 'attribution'])
  assert.deepEqual(facts.slice(0, 6).map((fact) => fact.value), ['not stated', 'not stated', 'not stated', 'not stated', 'not stated', 'not stated'])
  assert.equal(facts.find((fact) => fact.key === 'attribution')?.value, 'not stated')
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
  // The body sections are still readable: one unavailable fact does not hide the others.
  const values = changeStoryFacts(story).map((entry) => entry.value)
  assert.deepEqual(values.slice(0, 3).map((value) => /not stated|not available/.test(value)), [false, false, false])
  assert.deepEqual(values.slice(3, 6), ['not stated', 'not stated', 'not stated'], 'a section the body lacks is not stated, not unavailable — the body was read')
})

test('a pull request that could not be read says which fact is unavailable', () => {
  const story = readChangeStory({ body: null, totals: null, diffState: 'unreadable' })
  assert.equal(story.bodyState, 'unreadable')
  assert.equal(story.diffState, 'unreadable')
  const facts = changeStoryFacts(story)
  assert.equal(facts.length, 8)
  assert.deepEqual(facts.map((fact) => fact.value), ['not available', 'not available', 'not available', 'not available', 'not available', 'not available', 'not available', 'not stated'])
})

test('the bare Ran: line the house PR template uses is read like the heading', () => {
  const body = ['## What changed', 'something', 'Ran:', '- `npm run check` — pass', 'Not run:', '- Docker'].join('\n')
  const story = storyOf(body)
  const ran = story.sections.find((section) => section.key === 'ran')
  assert.match(ran?.text ?? '', /npm run check/)
  assert.doesNotMatch(ran?.text ?? '', /Docker/, 'Not run: belongs to no section and must not be swallowed')
})

// #993: AGENTS.md:183 prescribes `Not run: Docker image, real SMTP` — one line,
// text after the colon — and that is also what this pull request's own body
// carries. Matching only a bare `Not run:` appended the whole line to `Ran` and
// left the Not-verified row saying `not stated` while the body stated it.
test('the inline Not run: line AGENTS.md prescribes is read like the heading', () => {
  const body = [
    '## What changed',
    'something',
    'Ran:',
    '- `npm run check` — pass',
    'Not run: Docker image, real SMTP',
  ].join('\n')
  const story = storyOf(body)
  const ran = story.sections.find((section) => section.key === 'ran')
  const notVerified = story.sections.find((section) => section.key === 'notVerified')
  assert.match(ran?.text ?? '', /npm run check/)
  assert.doesNotMatch(ran?.text ?? '', /Docker/, 'the inline Not run: text belongs to the Not-run row, not to Ran')
  assert.equal(notVerified?.text, 'Docker image, real SMTP')
})

test('a headed Not run: list keeps working beside the inline form', () => {
  const body = [
    '## What changed',
    'something',
    'Ran:',
    '- `npm run check` — pass',
    'Not run:',
    '- Docker image',
    '- real SMTP',
  ].join('\n')
  const story = storyOf(body)
  const ran = story.sections.find((section) => section.key === 'ran')
  const notVerified = story.sections.find((section) => section.key === 'notVerified')
  assert.doesNotMatch(ran?.text ?? '', /Docker/, 'the headed list must not be swallowed by Ran')
  assert.match(notVerified?.text ?? '', /Docker image/)
  assert.match(notVerified?.text ?? '', /real SMTP/)
})

// #993: `scripts/lib/pr-body.mjs` accepts a qualified line — `Ran (author, at
// tree <sha>):` — and this pull request's own body uses it. Matching only the
// bare form dropped the commands under it, and when the line followed a fact
// heading they were appended to that fact instead.
test('a qualified Ran: line keeps its bullets in Ran, not in the fact above it', () => {
  const body = [
    '## Risks',
    'small, the parser only',
    'Ran (author, at tree `b231bcb6` — the tip\'s tree):',
    '- `npm run check` — pass',
    '- `npx tsx --test test/changeStory.test.ts` — 21/21 pass',
  ].join('\n')
  const story = storyOf(body)
  const ran = story.sections.find((section) => section.key === 'ran')
  const risks = story.sections.find((section) => section.key === 'risks')
  assert.match(ran?.text ?? '', /npm run check/)
  assert.match(ran?.text ?? '', /21\/21/)
  assert.doesNotMatch(risks?.text ?? '', /npm run check/, 'the commands below the qualified line belong to Ran, not to the fact above')
})

// #997: the widened matcher kept the optional qualifier but dropped the word
// boundary, so any word that merely starts with `ran` and ends in a colon opened
// a run section. A bare `Range:` line inside `Risks` cut the fact at that line
// and moved the bullets under it into `ran`, which the job page then shows as
// verified work. Only the word `Ran` may start the section.
test('Range:, Randomized: and Rants: do not start a run section', () => {
  const stories = ['Range:', 'Randomized:', 'Rants:'].map((keyword) => {
    const body = ['## Risks', 'None.', keyword, '- `npm run check` — pass'].join('\n')
    const story = storyOf(body)
    return {
      keyword,
      ran: story.sections.find((section) => section.key === 'ran'),
      risks: story.sections.find((section) => section.key === 'risks'),
    }
  })
  assert.deepEqual(
    stories.filter((story) => (story.ran?.text ?? null) !== null).map((story) => story.keyword),
    [],
    'only the word Ran starts a run section',
  )
  for (const story of stories) {
    assert.match(story.risks?.text ?? '', /npm run check/, `the bullet under ${story.keyword} belongs to Risks`)
  }
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

// #793: the body already carries alternatives considered, uncertainty and an
// explicit "Not run:" list, and the job row already carries which model and role
// did the work. Slice 1 read three sections and four facts; the maintainer needs
// the other half of the story before deciding, so the block carries eight rows.
test('alternatives considered, uncertainty and the Not run: list are facts of their own', () => {
  const body = [
    '## What changed',
    'The windows come from config.',
    '',
    '## Alternatives considered',
    'We could have left the literals in place; that needs a release per change.',
    '',
    '## Uncertainty',
    'The count may drift under write load; the residual risk is a slower page.',
    '',
    '## Ran',
    '- `npm run check` — pass',
    '',
    'Not run:',
    '- a production database',
    '- a real SMTP path',
  ].join('\n')
  const story = storyOf(body)
  const byKey = new Map(story.sections.map((section) => [section.key, section]))
  assert.match(byKey.get('alternatives')?.text ?? '', /left the literals in place/)
  assert.match(byKey.get('uncertainty')?.text ?? '', /residual risk/)
  assert.match(byKey.get('notVerified')?.text ?? '', /production database[\s\S]*real SMTP/)
  const facts = changeStoryFacts(story)
  assert.deepEqual(facts.map((fact) => fact.key), ['whatChanged', 'risks', 'ran', 'alternatives', 'uncertainty', 'notVerified', 'diff', 'attribution'])
  assert.match(facts.find((fact) => fact.key === 'notVerified')?.value ?? '', /a real SMTP path/)
})

test('a body with none of the three new sections still shows them as not stated', () => {
  const facts = changeStoryFacts(storyOf(COMPLETE))
  for (const key of ['alternatives', 'uncertainty', 'notVerified'] as const) {
    assert.equal(facts.find((fact) => fact.key === key)?.value, 'not stated', `${key} is a row that says not stated instead of disappearing`)
  }
})

test('a duplicated Alternatives considered heading keeps the last and is reported', () => {
  const body = ['## Alternatives considered', 'first answer', '## Alternatives considered', 'second answer'].join('\n')
  const section = storyOf(body).sections.find((entry) => entry.key === 'alternatives')
  assert.equal(section?.text, 'second answer')
  assert.equal(section?.duplicated, true)
  const fact = changeStoryFacts(storyOf(body)).find((entry) => entry.key === 'alternatives')
  assert.match(fact?.note ?? '', /repeated/i)
})

test('an empty Not run: list is stated, never hidden', () => {
  const body = ['## Ran', '- `npm run check` — pass', 'Not run:'].join('\n')
  const facts = changeStoryFacts(storyOf(body))
  const notVerified = facts.find((fact) => fact.key === 'notVerified')
  assert.equal(notVerified?.value, 'not stated')
  assert.doesNotMatch(notVerified?.value ?? '', /npm run check/, 'the Ran text is not copied into the not-verified list')
})

test('the attribution fact comes from the job row, never from the body', () => {
  const body = ['## What changed', 'Written by nobody; model: invented', '## Ran', '- tests'].join('\n')
  const story = readChangeStory({
    body,
    totals: null,
    diffState: 'unreadable',
    attribution: { model: 'DeepSeek-V4.1-Flash-1017', role: 'Dev-1' },
  })
  const fact = changeStoryFacts(story).find((entry) => entry.key === 'attribution')
  assert.equal(fact?.value, 'DeepSeek-V4.1-Flash-1017 · Dev-1')
  assert.doesNotMatch(fact?.value ?? '', /invented/)
})

test('a recorded role without a model still names the role, and neither recorded says not stated', () => {
  const withRole = changeStoryFacts(readChangeStory({ body: '', totals: null, diffState: 'unreadable', attribution: { model: null, role: 'Dev-1' } }))
  assert.equal(withRole.find((fact) => fact.key === 'attribution')?.value, 'Dev-1')
  const withModelOnly = changeStoryFacts(readChangeStory({ body: '', totals: null, diffState: 'unreadable', attribution: { model: 'M', role: null } }))
  assert.equal(withModelOnly.find((fact) => fact.key === 'attribution')?.value, 'M')
  const empty = changeStoryFacts(readChangeStory({ body: '', totals: null, diffState: 'unreadable' }))
  assert.equal(empty.find((fact) => fact.key === 'attribution')?.value, 'not stated')
})

test('the job page renders all eight rows and names the model and role from the job row', async () => {
  const github = await startFakeServer((request, response) => {
    if ((request.url ?? '').startsWith('/repos/acme/demo/pulls/11/files')) {
      json(response, 200, [{ filename: 'src/a.ts', additions: 3, deletions: 1 }])
      return
    }
    if ((request.url ?? '').startsWith('/repos/acme/demo/pulls/11')) {
      json(response, 200, {
        number: 11,
        html_url: 'https://github.com/acme/demo/pull/11',
        title: 't',
        state: 'open',
        head: { ref: 'dev1/y', sha: 'b'.repeat(40) },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'blocked',
        draft: false,
        merged: false,
        changed_files: 1,
        body: [
          '## What changed',
          'windows from config',
          '## Alternatives considered',
          'keep the literals',
          '## Uncertainty',
          'counts may drift',
          '## Ran',
          '- `npm run check` — pass',
          'Not run:',
          '- production database',
        ].join('\n'),
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
    const job = store.createJob({ id: 'job_story8', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-story8', platformTokenHash: '' })
    store.updateJob(job.id, {
      status: 'succeeded',
      branch: 'dev1/y',
      pr_url: 'https://github.com/acme/demo/pull/11',
      attribution_json: JSON.stringify({ writtenBy: 'Dev-1', implementedBy: 'Dev-1' }),
      model_json: JSON.stringify({ model: { id: 'deepseek-v4.1-flash', label: 'DeepSeek-V4.1-Flash-1017' } }),
    })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    for (const label of ['What changed', 'Risks', 'Ran', 'Alternatives considered', 'Uncertainty and residual risk', 'Not verified', 'Diff', 'Model and role']) {
      assert.match(page.body, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the block renders the ${label} row`)
    }
    assert.match(page.body, /DeepSeek-V4\.1-Flash-1017 · Dev-1/, 'the attribution row names the model and role the job row recorded')
    assert.match(page.body, /keep the literals/)
    assert.match(page.body, /production database/)
  } finally {
    await built.app.close()
    await github.close()
    store.close()
  }
})

test('a job row with no attribution still answers 200 and says not stated', async () => {
  const github = await startFakeServer((request, response) => {
    if ((request.url ?? '').startsWith('/repos/acme/demo/pulls/12/files')) {
      json(response, 200, [])
      return
    }
    if ((request.url ?? '').startsWith('/repos/acme/demo/pulls/12')) {
      json(response, 200, {
        number: 12,
        html_url: 'https://github.com/acme/demo/pull/12',
        title: 't',
        state: 'open',
        head: { ref: 'dev1/z', sha: 'c'.repeat(40) },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'blocked',
        draft: false,
        merged: false,
        changed_files: 0,
        body: ['## What changed', 'x', '## Ran', '- tests'].join('\n'),
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
    const job = store.createJob({ id: 'job_story_noattr', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb-story-noattr', platformTokenHash: '' })
    store.updateJob(job.id, { status: 'succeeded', branch: 'dev1/z', pr_url: 'https://github.com/acme/demo/pull/12' })
    const { cookie } = sessionFor(built, user)
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/jobs/${job.id}`, headers: { cookie: `${cookie}; fledge_lang=en` } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /Model and role/)
    assert.match(page.body, /not stated/)
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
