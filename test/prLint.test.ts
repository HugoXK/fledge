import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { json, startFakeServer } from './helpers.js'

const execFileAsync = promisify(execFile)
const lintScript = fileURLToPath(new URL('../scripts/pr-lint.mjs', import.meta.url))
const gateScript = fileURLToPath(new URL('../scripts/review-gate.mjs', import.meta.url))

const SHA = '0123456789abcdef0123456789abcdef01234567'

const POLICY = {
  requiredPass: 'HugoXK-bot',
  selfReview: ['HugoXK-bot'],
  writers: ['HugoXK', 'HugoXK-bot'],
  authors: ['HugoXK', 'HugoXK-bot', 'Fledge Platform Dev-1', 'Fledge Platform Dev-2'],
}

// A base branch that predates the split: `authors` does not exist yet.
const POLICY_BEFORE_SPLIT = {
  requiredPass: 'HugoXK-bot',
  selfReview: ['HugoXK-bot'],
  writers: ['HugoXK', 'HugoXK-bot'],
}

const BOT_SIGNED = `Written-by: Fledge Platform Dev-1
Bot: Fledge Platform Dev-1

Fixes #96

Ran:
- \`npm run check\` — pass

Not run: Docker image, real SMTP
`

const OWNER_SIGNED_WITH_BOT = `Written-by: HugoXK
Bot: Fledge Platform Dev-1

Fixes #96

Ran:
- \`npm run check\` — pass

Not run: Docker image, real SMTP
`

const HEADING_RAN = `Written-by: HugoXK
Bot: Fledge Platform Dev-1

Fixes #96

## Ran:
- \`npm run check\` — pass

Not run: Docker image, real SMTP
`

const HEADING_NOT_RUN = `Written-by: HugoXK
Bot: Fledge Platform Dev-1

Fixes #96

Ran:
- \`npm run check\` — pass

## Not run:
Docker image, real SMTP
`

async function bodyRules() {
  return import('../scripts/lib/pr-body.mjs')
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

async function runScript(script: string, args: string[], env: Record<string, string>): Promise<RunResult> {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

interface FakeState {
  body: string
  files: string[]
  policy: unknown
  comments: Array<Record<string, unknown>>
  reviews: Array<Record<string, unknown>>
  // What the pull request API reports for size. The rule reads these and not
  // `git diff --stat`, so a rebase cannot change the number behind its back.
  size: { changed_files: number; additions: number; deletions: number }
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    body: BOT_SIGNED,
    files: [],
    policy: POLICY,
    comments: [],
    reviews: [],
    size: { changed_files: 1, additions: 1, deletions: 1 },
    ...overrides,
  }
}

async function withFakeGitHub(current: FakeState, run: (env: Record<string, string>) => Promise<void>): Promise<void> {
  const server = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/repos/o/r/pulls/7') {
      json(response, 200, { number: 7, head: { sha: SHA }, user: { login: 'HugoXK' }, labels: [], body: current.body, ...current.size })
      return
    }
    if (path === '/repos/o/r/pulls/7/files') {
      json(response, 200, current.files.map((filename) => ({ filename, status: 'modified' })))
      return
    }
    if (path === '/repos/o/r/pulls/7/reviews') {
      json(response, 200, current.reviews)
      return
    }
    if (path === '/repos/o/r/pulls/7/commits') {
      // #144: the gate reads the tip's commits before it accepts a PASS; every tip
      // in this suite is Dev-authored, so the reviewer-identity list is empty.
      json(response, 200, [])
      return
    }
    if (path === '/repos/o/r/issues/7/comments') {
      json(response, 200, current.comments)
      return
    }
    if (path === '/repos/o/r/contents/.github/agent/review-policy.json') {
      const text = JSON.stringify(current.policy)
      json(response, 200, { encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') })
      return
    }
    // #308: the gate reads the tip's review threads before it judges the verdict,
    // because the branch refuses a merge over an unresolved thread.
    if (path === '/graphql') {
      json(response, 200, { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } })
      return
    }
    json(response, 404, { message: `unexpected ${request.method} ${path}` })
  })
  const dir = mkdtempSync(join(tmpdir(), 'fledge-pr-lint-'))
  const eventPath = join(dir, 'event.json')
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7, base: { ref: 'main' } }, issue: { number: 7 } }))
  try {
    await run({ GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: server.url, GITHUB_EVENT_PATH: eventPath })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await server.close()
  }
}

// --- the body rules, without the GitHub API --------------------------------

test('a body that names the bot that wrote it passes once the name is in the attribution list', async () => {
  const { checkBody } = await bodyRules()
  assert.deepEqual(checkBody(BOT_SIGNED, POLICY), [])
})

test('the owner line plus a Bot: line stays valid', async () => {
  const { checkBody } = await bodyRules()
  assert.deepEqual(checkBody(OWNER_SIGNED_WITH_BOT, POLICY), [])
})

test('a name in neither list fails, and the error names the authors list it checked', async () => {
  const { checkBody } = await bodyRules()
  const errors = checkBody(`Written-by: A Stranger\n\nFixes #96\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker\n`, POLICY)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /Written-by "A Stranger" is not in the authors list/)
})

test('a base branch without authors falls back to writers, and the error names that list', async () => {
  const { checkBody } = await bodyRules()
  const errors = checkBody(BOT_SIGNED, POLICY_BEFORE_SPLIT)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /Written-by "Fledge Platform Dev-1" is not in the writers list/)
})

test('plain Ran: and Not run: lines are accepted', async () => {
  const { checkBody, hasRanSection, hasNotRunSection } = await bodyRules()
  assert.equal(hasRanSection(OWNER_SIGNED_WITH_BOT), true)
  assert.equal(hasNotRunSection(OWNER_SIGNED_WITH_BOT), true)
  assert.deepEqual(checkBody(OWNER_SIGNED_WITH_BOT, POLICY), [])
})

test('an empty authors list rejects every name instead of falling back to writers', async () => {
  const { checkBody } = await bodyRules()
  const errors = checkBody(OWNER_SIGNED_WITH_BOT, { ...POLICY, authors: [] })
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /is not in the authors list/)
})

test('a ## Ran: heading is reported as a heading, not as a missing section', async () => {
  const { checkBody } = await bodyRules()
  const errors = checkBody(HEADING_RAN, POLICY)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /has a "## Ran:" heading/)
  assert.doesNotMatch(errors[0]!, /needs a "Ran:" section/)
})

test('a ## Not run: heading is reported as a heading', async () => {
  const { checkBody } = await bodyRules()
  const errors = checkBody(HEADING_NOT_RUN, POLICY)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /has a "## Not run:" heading/)
  assert.doesNotMatch(errors[0]!, /needs a "Not run:" section/)
})

test('the shipped policy keeps attribution and verdict authorship apart', async () => {
  const { checkBody } = await bodyRules()
  const policy = JSON.parse(readFileSync(new URL('../.github/agent/review-policy.json', import.meta.url), 'utf8')) as {
    writers: string[]
    authors: string[]
  }
  assert.deepEqual(policy.writers, ['HugoXK', 'HugoXK-bot'])
  assert.ok(policy.authors.includes('Fledge Platform Dev-1'))
  assert.ok(!policy.writers.includes('Fledge Platform Dev-1'))
  assert.deepEqual(checkBody(BOT_SIGNED, policy), [])
})

// --- the same rules, through the workflow entry points ----------------------

test('pr-lint accepts a PR body that names the bot that wrote it', async () => {
  await withFakeGitHub(state(), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /pr-lint: ok/)
  })
})

test('pr-lint names the Ran: heading instead of claiming the section is missing', async () => {
  await withFakeGitHub(state({ body: HEADING_RAN }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /has a "## Ran:" heading/)
    assert.doesNotMatch(result.stderr, /needs a "Ran:" section/)
  })
})

test('the gate still refuses a verdict written by a bot name in the attribution list', async () => {
  const verdict = `Verdict: PASS at ${SHA}\nWritten-by: Fledge Platform Dev-1\nPosted-by: HugoXK-bot\n\nBot: Fledge Platform Dev-1\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker image\n`
  const comments = [{ body: verdict, user: { login: 'HugoXK-bot' }, author_association: 'MEMBER', created_at: '2026-11-09T00:00:00Z' }]
  await withFakeGitHub(state({ files: ['src/app.ts'], comments }), async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /writer "Fledge Platform Dev-1" is not in the review policy/)
  })
})

test('the same tip passes when the verdict is written by a writer', async () => {
  const verdict = `Verdict: PASS at ${SHA}\nWritten-by: HugoXK-bot\nPosted-by: HugoXK-bot\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker image\n`
  const comments = [{ body: verdict, user: { login: 'HugoXK-bot' }, author_association: 'MEMBER', created_at: '2026-11-09T00:00:00Z' }]
  await withFakeGitHub(state({ files: ['src/app.ts'], comments }), async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /review-gate: PASS/)
  })
})

// --- the size rule: `>` 20 files or `>` 800 changed lines ------------------

const LARGE_BODY = `Written-by: HugoXK
Bot: Fledge Platform Dev-1

Fixes #79

Large-PR: one rule for the whole gate, reviewed as a unit.

Ran:
- \`npm run check\` — pass

Not run: Docker image
`

test('a PR over 20 files fails the lint until the body carries a Large-PR: line', async () => {
  const files = Array.from({ length: 21 }, (_, index) => `scripts/file-${String(index)}.mjs`)
  await withFakeGitHub(state({ files, size: { changed_files: 21, additions: 10, deletions: 5 } }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, '21 files with no Large-PR: line must fail')
    assert.match(result.stderr, /Large-PR:/)
    assert.match(result.stderr, /21 files/)
  })
})

test('exactly 20 files and exactly 800 changed lines still pass without the line', async () => {
  const files = Array.from({ length: 20 }, (_, index) => `scripts/file-${String(index)}.mjs`)
  await withFakeGitHub(state({ files, size: { changed_files: 20, additions: 500, deletions: 300 } }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, `the rule is > 20 and > 800, not >=: ${result.stderr}`)
  })
})

test('deletions count: a small file count with 801 changed lines fails', async () => {
  const files = ['scripts/one.mjs', 'scripts/two.mjs']
  await withFakeGitHub(state({ files, size: { changed_files: 2, additions: 1, deletions: 800 } }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, 'a deletion-only PR over 800 lines must fail without the line')
    assert.match(result.stderr, /801 changed lines|Large-PR:/)
  })
})

test('a Large-PR: line makes a 21-file PR pass, and it does not cap the size', async () => {
  const files = Array.from({ length: 21 }, (_, index) => `scripts/file-${String(index)}.mjs`)
  await withFakeGitHub(state({ body: LARGE_BODY, files, size: { changed_files: 21, additions: 900, deletions: 100 } }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /pr-lint: ok/)
  })
})
