import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { json, startFakeServer } from './helpers.js'

// #862: `review-gate` and `pr-lint` read the pull request's file and commit lists
// with a fixed page cap. A pull request that is larger than the cap is classified
// from a prefix of its files, so a T3 path past the cap is invisible and the gate
// can pass a T3 tip without the PASS the tier requires; a reviewer-authored commit
// past the cap is invisible to the independence check for the same reason.
//
// Every case below is the truncation shape: the listing the API serves is longer
// than the old cap, and the deciding item sits past it. The fix reads until the
// API returns a short page, then proves the listing is complete against the counts
// the pull request object reports, and refuses instead of classifying a partial
// list. A hard cap alone would only move the hiding place, so the cap that is left
// is an absurdity guard that refuses.

const execFileAsync = promisify(execFile)
const gateScript = fileURLToPath(new URL('../scripts/review-gate.mjs', import.meta.url))
const lintScript = fileURLToPath(new URL('../scripts/pr-lint.mjs', import.meta.url))
const REVIEW_GATE_MODULE = '../scripts/lib/review-gate.mjs'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const REVIEWER = 'HugoXK-bot'

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function runScript(script: string, args: string[], env: Env): Promise<Run> {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const PASS_BODY = `Verdict: PASS at ${SHA}\nWritten-by: ${REVIEWER}\nPosted-by: ${REVIEWER}\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker image\n`
const POLICY = JSON.stringify({ writers: ['HugoXK', REVIEWER], requiredPass: REVIEWER })
const LARGE_BODY = `Written-by: HugoXK\nBot: Fledge Platform Dev-2\n\nFixes #862\n\nLarge-PR: a 450-file fixture, reviewed as a unit.\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker image\n`
// The same body without the size declaration: on a complete listing the only
// complaint is the missing `Large-PR:` line, which is what makes the ordering of
// the two rules visible.
const SMALL_BODY = `Written-by: HugoXK\nBot: Fledge Platform Dev-2\n\nFixes #862\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker image\n`

// The fake repository. `files` and `commits` are the *complete* listings, paged at
// 100 like the API; `reportedFiles`/`reportedCommits` are what the pull request
// object says the totals are, and they are allowed to disagree with the listings
// because that disagreement is exactly what a truncated read looks like.
interface Fixture {
  files: string[]
  reportedFiles?: number
  commits?: Array<{ sha: string; author: { login: string } }>
  reportedCommits?: number
  comments?: string[]
  reviews?: Array<Record<string, unknown>>
  title?: string
  body?: string
}

interface Env {
  GITHUB_TOKEN: string
  GITHUB_REPOSITORY: string
  GITHUB_API_URL: string
  GITHUB_EVENT_PATH: string
  GITHUB_RUN_ID: string
}

async function withFakeGitHub(fixture: Fixture, run: (env: Env) => Promise<void>): Promise<void> {
  const files = fixture.files
  const commits = fixture.commits ?? []
  const server = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const page = Number(url.searchParams.get('page') ?? '1')
    const perPage = Number(url.searchParams.get('per_page') ?? '100')
    if (path === '/repos/o/r/pulls/7') {
      json(response, 200, {
        number: 7,
        title: fixture.title ?? 'docs: a large but boring change',
        body: fixture.body ?? '',
        head: { sha: SHA, ref: 'dev2/big', repo: { full_name: 'o/r' } },
        base: { sha: 'base-sha', ref: 'main', repo: { full_name: 'o/r' } },
        user: { login: 'HugoXK' },
        labels: [],
        changed_files: fixture.reportedFiles ?? files.length,
        commits: fixture.reportedCommits ?? commits.length,
      })
      return
    }
    if (path === '/repos/o/r/pulls/7/files') {
      // Paged like the real endpoint: full pages of 100 while the listing lasts.
      json(response, 200, files.slice((page - 1) * perPage, page * perPage).map((filename) => ({ filename, status: 'modified' })))
      return
    }
    if (path === '/repos/o/r/pulls/7/commits') {
      json(response, 200, commits.slice((page - 1) * perPage, page * perPage))
      return
    }
    if (path === '/repos/o/r/pulls/7/reviews') {
      json(response, 200, fixture.reviews ?? [])
      return
    }
    if (path === '/repos/o/r/issues/7/comments') {
      json(response, 200, (fixture.comments ?? []).map((body) => ({ id: 1, user: { login: REVIEWER }, body, created_at: '2026-11-16T00:00:00Z', author_association: 'COLLABORATOR' })))
      return
    }
    if (path === '/repos/o/r/contents/.github/agent/review-policy.json') {
      json(response, 200, { encoding: 'base64', content: Buffer.from(POLICY, 'utf8').toString('base64') })
      return
    }
    if (path === '/repos/o/r/contents/package.json') {
      json(response, 200, { encoding: 'base64', content: Buffer.from(JSON.stringify({ name: 'fledge', version: '0.3.0' }), 'utf8').toString('base64') })
      return
    }
    if (path === '/repos/o/r/git/matching-refs/tags/v') {
      json(response, 200, [])
      return
    }
    if (path === `/repos/o/r/commits/${SHA}`) {
      json(response, 200, { sha: SHA, commit: { committer: { date: '2026-11-16T00:00:00Z' } } })
      return
    }
    if (path === '/graphql') {
      json(response, 200, { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } })
      return
    }
    json(response, 404, { message: `unexpected ${request.method} ${path}` })
  })
  const dir = mkdtempSync(join(tmpdir(), 'fledge-gate-truncation-'))
  const eventPath = join(dir, 'event.json')
  writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 7 } }))
  try {
    await run({ GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: server.url, GITHUB_EVENT_PATH: eventPath, GITHUB_RUN_ID: '900' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await server.close()
  }
}

function docsFiles(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `docs/bulk-${String(index)}.md`)
}

function commitsBy(login: string, count: number, overrides: Record<number, string> = {}): Array<{ sha: string; author: { login: string } }> {
  return Array.from({ length: count }, (_, index) => ({ sha: `${String(index)}`.padStart(40, '0'), author: { login: overrides[index] ?? login } }))
}

// --- review-gate: a file past the old 4-page cap ---------------------------

test('review-gate cannot classify a T3 path that sits past the old 400-file cap', async () => {
  // 450 files, all docs except the 421st, which is the workflow file that decides
  // the tier. The old cap read 400 docs-only files and returned T1 PASS; the whole
  // listing turns the same pull request into a T3 with no verdict.
  const files = docsFiles(450)
  files[420] = '.github/workflows/evil.yml'
  await withFakeGitHub({ files, reportedFiles: 450 }, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, `a hidden T3 path must not pass without a PASS: ${result.stdout}`)
    assert.match(result.stderr, /no conclusion at /)
  })
})

test('review-gate refuses a file listing shorter than the reported file count', async () => {
  // The listing ends after 420 files while the pull request reports 450: the
  // prefix is docs-only, so classification alone would call it T0 and pass.
  const files = docsFiles(420)
  await withFakeGitHub({ files, reportedFiles: 450 }, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, `a partial file list must not be classified: ${result.stdout}`)
    assert.match(result.stderr, /incomplete/i)
    assert.match(result.stderr, /420 of 450/)
  })
})

// --- review-gate: a reviewer commit past the old 4-page cap ----------------

test('review-gate cannot ignore a reviewer-authored commit that sits past the old 400-commit cap', async () => {
  // A complete file listing (one scripts/ file, so the tier needs a PASS) and a
  // real PASS at the tip; the independence check is the only thing that can catch
  // the reviewer's own commit at position 411.
  const commits = commitsBy('HugoXK', 420, { 410: REVIEWER })
  await withFakeGitHub({ files: ['scripts/pr-lint.mjs'], commits, reportedCommits: 420, comments: [PASS_BODY] }, async (env) => {
    const result = await runScript(gateScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, `a hidden reviewer commit must fail the gate: ${result.stdout}`)
    assert.match(result.stderr, /authored by reviewer identity/)
  })
})

// --- pr-lint: completeness before the body rule ----------------------------

test('pr-lint fails on an incomplete file list and says so instead of the Large-PR body rule', async () => {
  const files = docsFiles(420)
  await withFakeGitHub({ files, reportedFiles: 450, body: SMALL_BODY }, async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 1, 'a partial file list must fail the lint')
    assert.match(result.stderr, /incomplete/i)
    assert.match(result.stderr, /420 of 450/)
    assert.doesNotMatch(result.stderr, /Large-PR:/, 'completeness must be judged before the body rule a truncated list cannot check')
  })
})

test('pr-lint still passes a complete 450-file pull request that carries a Large-PR line', async () => {
  const files = docsFiles(450)
  await withFakeGitHub({ files, reportedFiles: 450, body: LARGE_BODY }, async (env) => {
    const result = await runScript(lintScript, ['--pr', '7'], env)
    assert.equal(result.code, 0, `a complete large pull request must still lint: ${result.stderr}`)
  })
})

// --- the reader itself -----------------------------------------------------

interface PaginateModule {
  paginate: (api: (path: string) => Promise<unknown[]>, path: string, maxPages?: number) => Promise<unknown[]>
  incompleteList: (label: string, read: number, reported: unknown) => string
}
const { paginate, incompleteList } = (await import(REVIEW_GATE_MODULE)) as PaginateModule

function pagedApi(total: number): { api: (path: string) => Promise<unknown[]>; pages: string[] } {
  const pages: string[] = []
  const api = async (path: string): Promise<unknown[]> => {
    pages.push(path)
    const url = new URL(path, 'http://127.0.0.1')
    const page = Number(url.searchParams.get('page') ?? '1')
    const perPage = Number(url.searchParams.get('per_page') ?? '100')
    return Array.from({ length: Math.max(0, Math.min(perPage, total - (page - 1) * perPage)) }, (_, index) => ({ index: (page - 1) * perPage + index }))
  }
  return { api, pages }
}

test('paginate reads past the old four-page cap instead of stopping at 400 items', async () => {
  const { api, pages } = pagedApi(450)
  const items = await paginate(api, '/repos/o/r/pulls/7/files')
  assert.equal(items.length, 450)
  assert.equal(pages.length, 5)
})

test('paginate refuses a listing that never ends instead of returning a prefix', async () => {
  const { api } = pagedApi(1000)
  await assert.rejects(() => paginate(api, '/repos/o/r/pulls/7/files', 2), /partial list/i)
})

test('a count that is not a number is not a count', () => {
  // `Number(null)` is 0, so a coerced count would call an empty read complete;
  // the count has to be a number before anything is compared against it.
  assert.match(incompleteList('changed-file', 0, null), /does not report a changed-file count/)
  assert.match(incompleteList('commit', 0, '12'), /does not report a commit count/)
  assert.equal(incompleteList('changed-file', 3, 3), '')
})
