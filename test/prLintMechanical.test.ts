import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startFakeServer, json } from './helpers.js'

const run = promisify(execFile)
// The checkout path is whatever the runner cloned this file into; resolving it
// from this module keeps the suite runnable outside the author's worktree.
const CWD = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(CWD, 'scripts', 'pr-lint.mjs')

const BODY = [
  'Written-by: HugoXK',
  'No-issue: mechanical daily minor release',
  '',
  'Automated minor release v0.3.0.',
  '',
  'Ran:',
  '- `node scripts/changelog.mjs release 0.3.0` — assembled the fragments',
  '',
  'Not run: `npm run check` here; the PR runs it itself.',
].join('\n')

const MECHANICAL_FILES = [
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'docker-compose.yml',
  ...Array.from({ length: 29 }, (_, index) => `changelog.d/${String(index + 1)}-change.fixed.md`),
]

interface Stub {
  title: string
  head: string
  changedFiles: number
  files: string[]
}

async function lintPullRequest(stub: Stub): Promise<{ code: number; stdout: string; stderr: string }> {
  const server = await startFakeServer((request, response) => {
    const path = String(request.url ?? '').split('?')[0]
    if (path === '/repos/o/r/pulls/141') {
      json(response, 200, {
        number: 141,
        title: stub.title,
        body: BODY,
        head: { ref: stub.head },
        changed_files: stub.changedFiles,
        additions: 120,
        deletions: 40,
        labels: [],
      })
      return
    }
    if (path === '/repos/o/r/pulls/141/files') {
      json(response, 200, stub.files.map((filename) => ({ filename, status: filename.startsWith('changelog.d/') ? 'removed' : 'modified' })))
      return
    }
    response.writeHead(404)
    response.end()
  })
  try {
    const result = await run('node', [SCRIPT, '--pr', '141'], {
      cwd: CWD,
      env: {
        ...process.env,
        GITHUB_API_URL: server.url,
        GITHUB_TOKEN: 'fake-token',
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_EVENT_PATH: '',
        GITHUB_STEP_SUMMARY: '',
      },
    })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  } finally {
    await server.close()
  }
}

test('pr-lint accepts the mechanical release PR: 33 files, no Large-PR line, no docs/deploy.md update', async () => {
  const result = await lintPullRequest({ title: 'release: v0.3.0', head: 'release/v0.3.0', changedFiles: 33, files: MECHANICAL_FILES })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /pr-lint: ok \(#141, mechanical release v0\.3\.0, 33 files\)/)
})

test('the same 33 files without the release identity still fail pr-lint', async () => {
  const result = await lintPullRequest({ title: 'feat: rename a thing', head: 'dev2/rename', changedFiles: 33, files: MECHANICAL_FILES })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /a PR over 20 files or 800 changed lines needs a "Large-PR:" line/)
  assert.match(result.stderr, /the changed module owns docs\/deploy\.md/)
})

test('the release title on a non-release branch is not mechanical either', async () => {
  const result = await lintPullRequest({ title: 'release: v0.3.0', head: 'dev2/80-release-driver', changedFiles: 33, files: MECHANICAL_FILES })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /Large-PR/)
})
