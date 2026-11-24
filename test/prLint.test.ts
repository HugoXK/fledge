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

// A generated dependency-bump body, trimmed to the shape that matters: it starts
// with `Bumps ` and carries none of the four body rules, because dependabot
// writes it upstream and nobody here may rewrite it.
const DEPENDABOT_LOGIN = 'dependabot[bot]'

const DEPENDABOT_BODY = `Bumps the all group with 4 updates: [@fastify/rate-limit](https://github.com/fastify/fastify-rate-limit), [nodemailer](https://github.com/nodemailer/nodemailer).

Updates \`@fastify/rate-limit\` from 10.3.0 to 11.2.2

---
updated-dependencies:
- dependency-name: "@fastify/rate-limit"
  dependency-type: direct:production
`

// Same author, first line that is not the generator's: the exemption is the
// pair, so this one keeps every rule.
const DEPENDABOT_UPDATE_BODY = `Update \`@fastify/rate-limit\` from 10.3.0 to 11.2.2

---
updated-dependencies:
- dependency-name: "@fastify/rate-limit"
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
  // The pull request's author login. Defaults to the owner, so every fixture
  // that is not a dependency bump is written by a human and unexempt.
  author: string
  files: string[]
  policy: unknown
  comments: Array<Record<string, unknown>>
  reviews: Array<Record<string, unknown>>
  // What the pull request API reports for size. The rule reads these and not
  // `git diff --stat`, so a rebase cannot change the number behind its back.
  size: { changed_files?: number; additions: number; deletions: number }
}

function state(overrides: Partial<FakeState> = {}): FakeState {
  return {
    body: BOT_SIGNED,
    author: 'HugoXK',
    files: [],
    policy: POLICY,
    comments: [],
    reviews: [],
    // `changed_files` defaults to the file list's own length, like the API: a
    // fixture whose two counts disagree is the truncated shape #862 refuses.
    size: { additions: 1, deletions: 1 },
    ...overrides,
  }
}

async function withFakeGitHub(current: FakeState, run: (env: Record<string, string>) => Promise<void>): Promise<void> {
  const server = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (path === '/repos/o/r/pulls/7') {
      json(response, 200, { number: 7, head: { sha: SHA }, user: { login: current.author }, labels: [], body: current.body, ...current.size, changed_files: current.size.changed_files ?? current.files.length, commits: 0 })
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

// --- the dependency-bump exemption (#982) ----------------------------------
// The pair decides: the author login and the generated first line. Neither half
// alone may relax a rule, and nothing outside the four body rules moves.

test('a dependabot bump body is exempt from the four body rules', async () => {
  const { checkBody } = await bodyRules()
  assert.deepEqual(checkBody(DEPENDABOT_BODY, POLICY, DEPENDABOT_LOGIN), [])
})

test('the same bump body posted by a human account keeps all four rules', async () => {
  const { checkBody } = await bodyRules()
  const errors = checkBody(DEPENDABOT_BODY, POLICY, 'HugoXK')
  // Three here: the `Fixes #N` rule lives in pr-lint, which the workflow tests cover.
  assert.equal(errors.length, 3)
  assert.match(errors[0]!, /must start with "Written-by: <name>"/)
})

test('a dependabot body that does not start with Bumps keeps all four rules', async () => {
  const { checkBody } = await bodyRules()
  const errors = checkBody(DEPENDABOT_UPDATE_BODY, POLICY, DEPENDABOT_LOGIN)
  assert.equal(errors.length, 3)
  assert.match(errors[0]!, /must start with "Written-by: <name>"/)
})

test('a bump body that does carry Written-by: is still checked against the authors list', async () => {
  const { checkBody } = await bodyRules()
  const errors = checkBody(`Bumps x from 1.0.0 to 2.0.0\n\nWritten-by: A Stranger\n`, POLICY, DEPENDABOT_LOGIN)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /Written-by "A Stranger" is not in the authors list/)
})

test('a body checked with no author at all behaves exactly as before', async () => {
  const { checkBody } = await bodyRules()
  assert.equal(checkBody(DEPENDABOT_BODY, POLICY).length, 3)
})

test('the exemption is the exact author login, not a name that contains it', async () => {
  const { isDependabotBump } = await bodyRules()
  for (const author of ['dependabot', 'dependabot[bot] ', 'app/dependabot[bot]', 'Dependabot[bot]', '']) {
    assert.equal(isDependabotBump(DEPENDABOT_BODY, author), false, `${JSON.stringify(author)} must not be exempt`)
  }
  assert.equal(isDependabotBump(DEPENDABOT_BODY, DEPENDABOT_LOGIN), true)
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

// --- evidence lines inside a code fence (#1294) -----------------------------
// A fenced block quotes a shape; it is never a record of what was executed, so
// the `Ran:` and `Not run:` rules read only the lines outside a fence.

const FENCED_RAN = `Written-by: HugoXK
Bot: Fledge Platform Dev-1

Fixes #96

Nothing was run for this change.

\`\`\`
Ran: nothing
\`\`\`

Not run: Docker image, real SMTP
`

const FENCED_NOT_RUN = `Written-by: HugoXK
Bot: Fledge Platform Dev-1

Fixes #96

Ran:
- \`npm run check\` — pass

\`\`\`
Not run: Docker image
\`\`\`
`

test('a Ran: line that exists only inside a code fence is reported as missing', async () => {
  const { checkBody, hasRanSection } = await bodyRules()
  assert.equal(hasRanSection(FENCED_RAN), false)
  assert.deepEqual(checkBody(FENCED_RAN, POLICY), ['the PR body needs a "Ran:" section'])
})

test('a Not run: line that exists only inside a code fence is reported as missing', async () => {
  const { checkBody, hasNotRunSection } = await bodyRules()
  assert.equal(hasNotRunSection(FENCED_NOT_RUN), false)
  assert.deepEqual(checkBody(FENCED_NOT_RUN, POLICY), ['the PR body needs a "Not run:" section'])
})

test('a real Ran: line outside every fence still satisfies the rule', async () => {
  const { checkBody } = await bodyRules()
  assert.deepEqual(checkBody(OWNER_SIGNED_WITH_BOT, POLICY), [])
})

test('a ### Ran: heading is still rejected as a heading, not accepted as the section', async () => {
  const { checkBody } = await bodyRules()
  const body = OWNER_SIGNED_WITH_BOT.replace('Ran:\n', '### Ran:\n')
  const errors = checkBody(body, POLICY)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /has a "### Ran:" heading/)
})

test('a line after a closing fence is real text again', async () => {
  const { checkBody, hasRanSection } = await bodyRules()
  const body = `Written-by: HugoXK

Fixes #96

\`\`\`
Ran: nothing
\`\`\`

Ran:
- \`npm run check\` — pass

Not run: Docker image
`
  assert.equal(hasRanSection(body), true)
  assert.deepEqual(checkBody(body, POLICY), [])
})

test('a ~~~ fence hides an evidence line exactly like a backtick fence', async () => {
  const { hasRanSection } = await bodyRules()
  assert.equal(hasRanSection(`Written-by: HugoXK\n\n~~~\nRan: nothing\n~~~\n\nNot run: Docker\n`), false)
})

test('an unterminated fence at the end of the body is treated as a fence', async () => {
  const { checkBody, hasRanSection, hasNotRunSection } = await bodyRules()
  const body = `Written-by: HugoXK

Fixes #96

Nothing was run for this change.

\`\`\`
Ran: nothing
Not run: nothing
`
  assert.equal(hasRanSection(body), false)
  assert.equal(hasNotRunSection(body), false)
  assert.deepEqual(checkBody(body, POLICY), [
    'the PR body needs a "Ran:" section',
    'the PR body needs a "Not run:" section',
  ])
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

// --- the issue tie: closing, tracking, and neither (#602) ------------------

const bodyWith = (tie: string): string =>
  `Written-by: Fledge Platform Dev-1\nBot: Fledge Platform Dev-1\n\n${tie}\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker image\n`

const PR_PATHS = ['scripts/pr-lint.mjs', 'test/prLint.test.ts']

test('a body that only tracks its epic passes and the success line says it closes nothing', async () => {
  await withFakeGitHub(state({ body: bodyWith('Part of #544'), files: PR_PATHS }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /pr-lint: ok \(#7, T3, 2 files; tracks #544, closes nothing\)/)
  })
})

test('Refs #N is the other accepted non-closing shape, and it names its own issue', async () => {
  await withFakeGitHub(state({ body: bodyWith('Refs #540'), files: PR_PATHS }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /tracks #540, closes nothing/)
  })
})

test('Fixes #N still passes and must not be reported as tracking only', async () => {
  await withFakeGitHub(state({ body: bodyWith('Fixes #544'), files: PR_PATHS }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /pr-lint: ok \(#7, T3, 2 files\)/)
    assert.doesNotMatch(result.stdout, /tracks #|closes nothing/)
  })
})

test('No-issue: is still accepted for a pull request with no issue at all', async () => {
  await withFakeGitHub(state({ body: bodyWith('No-issue: mechanical cleanup with no issue behind it'), files: PR_PATHS }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /pr-lint: ok \(#7, T3, 2 files\)/)
  })
})

test('a body with no reference at all still fails, and the message names the new shapes', async () => {
  await withFakeGitHub(state({ body: bodyWith('Written for the release card'), files: PR_PATHS }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 1)
    assert.match(result.stderr, /"Fixes #N"/)
    assert.match(result.stderr, /"Part of #N"/)
    assert.match(result.stderr, /"Refs #N"/)
  })
})

test('the non-closing anchor does not match inside another word', async () => {
  for (const tie of ['Partner #544', 'Part of #544x', 'Refs #540x']) {
    await withFakeGitHub(state({ body: bodyWith(tie), files: PR_PATHS }), async (env) => {
      const result = await runScript(lintScript, ['--pr', '7'], env)
      assert.equal(result.code, 1, `${tie} must not pass as a reference`)
      assert.match(result.stderr, /the PR body needs/)
    })
  }
})

// --- the dependency-bump exemption through the workflow entry point --------

test('pr-lint passes a dependabot bump and does not ask it for the four body rules', async () => {
  await withFakeGitHub(
    state({ author: DEPENDABOT_LOGIN, body: DEPENDABOT_BODY, files: ['package.json', 'package-lock.json'] }),
    async (env) => {
      const result = await runScript(lintScript, ['--pr', '7'], env)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /pr-lint: ok/)
    },
  )
})

test('the same bump body from a human account still fails pr-lint, naming Written-by first', async () => {
  await withFakeGitHub(state({ body: DEPENDABOT_BODY, files: ['package.json'] }), async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, 'a human account must not inherit the machine exemption')
    assert.match(result.stderr, /must start with "Written-by: <name>"/)
  })
})

test('a dependabot bump still owes its changelog fragment and its Large-PR: line', async () => {
  const files = Array.from({ length: 21 }, (_, index) => `src/dependency-${String(index)}.ts`)
  await withFakeGitHub(
    state({ author: DEPENDABOT_LOGIN, body: DEPENDABOT_BODY, files, size: { changed_files: 21, additions: 900, deletions: 10 } }),
    async (env) => {
      const result = await runScript(lintScript, ['--pr', '7'], env)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /changelog\.d fragment/)
      assert.match(result.stderr, /Large-PR:/)
    },
  )
})

test('a dependabot bump is still labelled against the tier its paths compute', async () => {
  await withFakeGitHub(
    state({ author: DEPENDABOT_LOGIN, body: DEPENDABOT_BODY, files: ['scripts/pr-lint.mjs'] }),
    async (env) => {
      const result = await runScript(lintScript, ['--pr', '7'], env)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /pr-lint: ok \(#7, T3, 1 files?\)/)
    },
  )
})
