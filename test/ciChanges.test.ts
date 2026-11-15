import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allGateChanges,
  classifyChanges,
  isDbPath,
  isDocPath,
  isFrontendPath,
  isSourcePath,
  isWorkflowPath,
} from '../scripts/lib/ciChanges.mjs'

// The classifier answer is still right for the gates that read only their own
// inputs. It is not right for the suite: `test/uiTokens.test.ts` asserts on
// `docs/ui.md`, `test/alertBuckets.test.ts` on `deploy/prometheus/` and
// `test/codeqlGate.test.ts` on `.github/workflows/` — 60 of the 184 files under
// `test/` read those trees. Skipping the suite on `source: false` therefore put a
// green `ci-ok` over a red suite on docs-only (T0) and `public/`-only (T1)
// pull requests, where no verdict reads the tip either.
test('a docs-only diff classifies as documentation and keeps the suite runnable', () => {
  const changes = classifyChanges(['docs/ui.md', 'README.md', 'CHANGELOG.md', 'changelog.d/1.added.md'])
  assert.deepEqual(changes, {
    docsOnly: true,
    source: false,
    frontend: false,
    deps: false,
    db: false,
    docker: false,
    workflows: false,
    codeql: false,
    deploy: false,
  })

  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
  for (const job of ['test', 'coverage']) {
    const block = jobBlock(workflow, job)
    assert.doesNotMatch(block, /if: needs\.changes\.outputs\./, `${job} must run on every diff, including this one`)
    assert.doesNotMatch(block, /needs: changes/, `${job} must not wait on the classifier that would skip it`)
  }
})

function jobBlock(workflow: string, job: string): string {
  const start = workflow.indexOf(`\n  ${job}:`)
  assert.ok(start !== -1, `ci.yml must declare ${job}`)
  const rest = workflow.slice(start + 1)
  const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/)
  return next === -1 ? rest : rest.slice(0, next)
}

test('a workflow-only diff runs the workflow checks but not the code gates', () => {
  const changes = classifyChanges(['.github/workflows/ci.yml'])
  assert.equal(changes.workflows, true)
  assert.equal(changes.source, false)
  assert.equal(changes.docker, false)
  assert.equal(changes.frontend, false)
  assert.equal(changes.codeql, true)
})

test('a backend source change runs code and Docker but not visual', () => {
  const changes = classifyChanges(['src/jobs/service.ts'])
  assert.equal(changes.source, true)
  assert.equal(changes.docker, true)
  assert.equal(changes.frontend, false)
  assert.equal(changes.db, false)
  assert.equal(changes.codeql, true)
})

test('a view or public change runs visual and Docker', () => {
  const views = classifyChanges(['src/views/pages.ts'])
  assert.equal(views.frontend, true)
  assert.equal(views.source, true)
  assert.equal(views.docker, true)
  assert.equal(views.codeql, true)

  const publicOnly = classifyChanges(['public/app.css'])
  assert.equal(publicOnly.frontend, true)
  assert.equal(publicOnly.source, false)
  assert.equal(publicOnly.docker, true)
  assert.equal(publicOnly.codeql, true)
})

test('a test-only change runs the test gates but not Docker', () => {
  const changes = classifyChanges(['test/ciChanges.test.ts'])
  assert.equal(changes.source, true)
  assert.equal(changes.docker, false)
  assert.equal(changes.frontend, false)
  assert.equal(changes.codeql, true)
})

test('dependency, database and Docker inputs are classified separately', () => {
  assert.equal(classifyChanges(['package.json']).deps, true)
  assert.equal(classifyChanges(['package-lock.json']).deps, true)
  assert.equal(classifyChanges(['src/db.ts']).db, true)
  assert.equal(classifyChanges(['scripts/lib/backup-crypto.mjs']).db, true)

  const dockerfile = classifyChanges(['Dockerfile'])
  assert.equal(dockerfile.docker, true)
  assert.equal(dockerfile.source, false)
  assert.equal(dockerfile.codeql, false)
})

test('an unknown path is code and a Docker input rather than a skip', () => {
  const changes = classifyChanges(['brand-new-area/thing.ts'])
  assert.equal(changes.source, true)
  assert.equal(changes.docker, true)
  assert.equal(changes.workflows, false)
  assert.equal(changes.codeql, true)
})

test('deploy-only changes run the deploy check instead of the app gates', () => {
  const changes = classifyChanges(['deploy/nginx.conf', 'deploy/prometheus/fledge-alerts.yml'])
  assert.equal(changes.deploy, true, 'the deploy flag is what starts deploy-check')
  assert.equal(changes.source, false, 'deploy/ is not code, so the app gates may skip')
  assert.equal(changes.docker, false)
  assert.equal(changes.workflows, false)
  assert.equal(changes.codeql, false)

  // The honest constraint: a deploy-only answer must never cover a source path.
  // A mixed diff sets both flags, so the code gates still run and the deploy
  // check still reads the deploy half; this is the refusal, not a warning.
  const mixed = classifyChanges(['deploy/nginx.conf.example', 'src/app.ts'])
  assert.equal(mixed.deploy, true, 'the deploy half must still be checked on a mixed diff')
  assert.equal(mixed.source, true, 'a src/ path in the same diff must keep the code gates on')
  assert.equal(mixed.codeql, true)
})

test('a code-only change does not start the deploy check', () => {
  const changes = classifyChanges(['src/app.ts', 'test/app.test.ts'])
  assert.equal(changes.deploy, false)
  assert.equal(changes.source, true)
})

test('the deploy job starts only on a deploy flag, runs the syntax checks, and ci-ok refuses a skip', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
  const deploy = jobBlock(workflow, 'deploy-check')
  assert.match(deploy, /if: needs\.changes\.outputs\.deploy == 'true'/, 'deploy-check must be conditional on the deploy flag')
  assert.match(deploy, /needs: changes/, 'deploy-check must read the classifier output')
  assert.match(deploy, /node --check deploy\/cloudflare-email-worker\.js/, 'the worker must be parsed, not trusted to review')
  assert.match(deploy, /promtool"\s+check rules deploy\/prometheus\/fledge-alerts\.yml/, 'the alert rules must be checked by promtool')
  assert.match(deploy, /PROMTOOL_SHA256: [0-9a-f]{64}/, 'the promtool archive must be checksum-pinned, not a floating download')
  assert.match(deploy, /systemd-analyze verify deploy\/fledge\.service/, 'the systemd sample must be offered to systemd-analyze')

  const changes = jobBlock(workflow, 'changes')
  assert.match(changes, /deploy: \$\{\{ steps\.classify\.outputs\.deploy \}\}/, 'the changes job must publish the deploy flag')
  const ciOk = jobBlock(workflow, 'ci-ok')
  assert.match(ciOk, /needs: \[[^\]]*\bdeploy-check\b/, 'ci-ok must accept a skipped deploy-check only through the flag')
})

test('an empty diff runs everything, because an unreadable diff must not shrink the gate', () => {
  assert.deepEqual(classifyChanges([]), allGateChanges())
  assert.deepEqual(allGateChanges(), {
    docsOnly: false,
    source: true,
    frontend: true,
    deps: true,
    db: true,
    docker: true,
    workflows: true,
    codeql: true,
    deploy: true,
  })
})

test('path predicates recognise the shapes the workflow relies on', async () => {
  assert.equal(isDocPath('docs/deploy.md'), true)
  assert.equal(isSourcePath('scripts/ci-ok.mjs'), true)
  assert.equal(isFrontendPath('src/app.ts'), true)
  assert.equal(isWorkflowPath('.github/agent/review-policy.json'), true)
  assert.equal(isDbPath('scripts/restore-drill-ci.mjs'), true)
  assert.equal(isSourcePath('docs/deploy.md'), false)
  // A dynamic import so the red at the base tree is a named failing assertion
  // rather than a crash on the whole file: the predicate is new in this change.
  const { isDeployPath } = (await import('../scripts/lib/ciChanges.mjs')) as { isDeployPath?: (path: string) => boolean }
  assert.equal(typeof isDeployPath, 'function', 'the classifier must export the predicate the workflow relies on')
  assert.equal(isDeployPath?.('deploy/nginx.conf.example'), true)
  assert.equal(isDeployPath?.('docs/deploy.md'), false)
})

// #752: a pull request whose branch was cut before the latest `main` carries a
// base commit that this checkout never fetched, so `git diff "$base...$head"`
// fails and the classify step fell straight to `--all`. Every gate then ran,
// and `codeql-required` sat on its ten-minute bound waiting for an analysis
// CodeQL does not start for an ignored path. The resolver below owns that
// decision so the suite can drive it; the workflow only calls it.
const BASE = 'b'.repeat(40)
const HEAD = 'h'.repeat(40)

interface ResolverGit {
  diff: (base: string, head: string) => string[] | null
  hasCommit: (sha: string) => boolean
  fetchSha: (sha: string) => boolean
  deepen: () => boolean
  fetchRef: (ref: string) => boolean
}

interface ResolverOptions {
  base: string
  head: string
  baseRef?: string
  git: ResolverGit
}

interface ResolverLib {
  changedPathsForPullRequest: (options: ResolverOptions) => string[] | null
}

// A dynamic import so this file still runs before the export exists, and the red
// is a named failing test rather than a crash on the whole suite.
async function resolver(): Promise<ResolverLib> {
  return (await import('../scripts/lib/ciChanges.mjs')) as unknown as ResolverLib
}

test('a base commit missing from the checkout is fetched before the diff is called unreadable', async () => {
  const { changedPathsForPullRequest } = await resolver()
  const calls: string[] = []
  let diffs = 0
  const paths = changedPathsForPullRequest({
    base: BASE,
    head: HEAD,
    baseRef: 'main',
    git: {
      diff: () => {
        diffs += 1
        calls.push(`diff#${String(diffs)}`)
        // The observed #752 failure: the first diff cannot resolve the base.
        return diffs === 1 ? null : ['AGENTS.md']
      },
      hasCommit: () => false,
      fetchSha: () => {
        calls.push('fetch-sha')
        return true
      },
      deepen: () => false,
      fetchRef: () => {
        calls.push('fetch-ref')
        return true
      },
    },
  })

  assert.deepEqual(paths, ['AGENTS.md'], 'a doc-only diff must classify as documentation, not as every gate')
  assert.ok(calls.includes('fetch-sha'), `the base has to be fetched by sha, calls: ${calls.join(', ')}`)
  assert.ok(
    calls.indexOf('fetch-sha') > calls.indexOf('diff#1') && calls.indexOf('diff#2') > calls.indexOf('fetch-sha'),
    `the retry has to come after the fetch and before the fallback, calls: ${calls.join(', ')}`,
  )
})

test('a base commit that is present is not fetched a second time', async () => {
  const { changedPathsForPullRequest } = await resolver()
  let fetched = 0
  const paths = changedPathsForPullRequest({
    base: BASE,
    head: HEAD,
    git: {
      diff: () => ['src/app.ts'],
      hasCommit: () => true,
      fetchSha: () => {
        fetched += 1
        return true
      },
      deepen: () => {
        fetched += 1
        return false
      },
      fetchRef: () => {
        fetched += 1
        return true
      },
    },
  })
  assert.deepEqual(paths, ['src/app.ts'])
  assert.equal(fetched, 0, 'a readable base needs no network round trip')
})

test('an unreadable base still runs every gate, by sha and then by ref', async () => {
  const { changedPathsForPullRequest } = await resolver()
  const tried: string[] = []
  const paths = changedPathsForPullRequest({
    base: BASE,
    head: HEAD,
    baseRef: 'main',
    git: {
      diff: () => null,
      hasCommit: () => false,
      fetchSha: () => {
        tried.push('sha')
        return false
      },
      deepen: () => false,
      fetchRef: () => {
        tried.push('ref')
        return true
      },
    },
  })
  assert.equal(paths, null, 'null means the caller runs every gate; an unreadable diff must never shrink it')
  assert.deepEqual(tried, ['sha', 'ref'], 'both ways of naming the base are tried before the conservative fallback')
})

// The shape the reviewer reproduced: the base commit is in the object store and
// the three-dot diff still cannot answer, because a depth-limited fetch grafted
// it as a shallow root. A second fetch of the same commit changes nothing, so
// deepening is the only attempt that can help, and it runs before the every-gate
// answer.
test('a base that is present but grafted is deepened before the diff is called unreadable', async () => {
  const { changedPathsForPullRequest } = await resolver()
  const calls: string[] = []
  let diffs = 0
  const paths = changedPathsForPullRequest({
    base: BASE,
    head: HEAD,
    baseRef: 'main',
    git: {
      diff: () => {
        diffs += 1
        calls.push(`diff#${String(diffs)}`)
        return diffs === 2 ? ['AGENTS.md'] : null
      },
      hasCommit: () => true,
      fetchSha: () => {
        calls.push('fetch-sha')
        return true
      },
      deepen: () => {
        calls.push('deepen')
        return true
      },
      fetchRef: () => {
        calls.push('fetch-ref')
        return true
      },
    },
  })
  assert.deepEqual(paths, ['AGENTS.md'], 'the deepened history must answer the diff, not the every-gate fallback')
  assert.deepEqual(calls, ['diff#1', 'deepen', 'diff#2'], 'a present base is deepened, not fetched again or skipped')
})

test('the classify step delegates the diff and keeps the every-gate fallback for other events', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8')
  const step = workflow.slice(workflow.indexOf('- name: Classify the changed paths'), workflow.indexOf('\n  lint:'))
  assert.match(step, /node scripts\/ci-changes\.mjs --git-base/, 'the classify step must delegate the diff so the fetch-before-fallback rule is testable')
  assert.match(step, /\*\) node scripts\/ci-changes\.mjs --all; exit 0 ;;/, 'a push or schedule still verifies the whole tree')
  assert.doesNotMatch(step, /git diff/, 'the untestable shell diff is what fell through to --all; it must not come back')
})

// The stubs above answer `diff` with a path list on their second call whatever
// the fetch did, so they cannot see the shape a runner actually hits: a fetch
// that places the base commit but not its history. `git fetch --depth=1`
// grafts the base as a shallow root, the three-dot diff then fails again — with
// `no merge base` instead of `Invalid symmetric difference expression` — and
// the classifier falls back to every gate, which is the #752 outcome under a
// new message. These two cases run the shipped script against a real
// repository so the fetch itself, not the answer, is what the test measures.
const CLI = fileURLToPath(new URL('../scripts/ci-changes.mjs', import.meta.url))

function gitIn(cwd: string, ...args: string[]) {
  return spawnSync(
    'git',
    ['-c', 'user.name=Fledge Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  )
}

function gitOk(cwd: string, ...args: string[]): string {
  const result = gitIn(cwd, ...args)
  assert.equal(result.status, 0, `git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
  return result.stdout.trim()
}

// `main` at B, a branch cut from the older A, and a docs-only commit on it:
// the diverged pull request from the #752 report.
function buildDivergedRepository(tmp: string): { source: string; olderMain: string; mainTip: string; head: string } {
  const source = join(tmp, 'source')
  mkdirSync(join(source, 'src'), { recursive: true })
  gitOk(source, 'init', '-q', '-b', 'main')
  writeFileSync(join(source, 'AGENTS.md'), 'agents v1\n')
  writeFileSync(join(source, 'src', 'app.ts'), 'export const app = 1\n')
  gitOk(source, 'add', '-A')
  gitOk(source, 'commit', '-qm', 'A: the merge base')
  const olderMain = gitOk(source, 'rev-parse', 'HEAD')
  writeFileSync(join(source, 'src', 'app.ts'), 'export const app = 2\n')
  gitOk(source, 'commit', '-qam', 'B: main moved on')
  const mainTip = gitOk(source, 'rev-parse', 'HEAD')
  gitOk(source, 'switch', '-qc', 'head', olderMain)
  mkdirSync(join(source, 'docs'), { recursive: true })
  writeFileSync(join(source, 'docs', 'a.md'), '# doc\n')
  gitOk(source, 'add', '-A')
  gitOk(source, 'commit', '-qm', 'H: docs-only branch cut before B')
  const head = gitOk(source, 'rev-parse', 'HEAD')
  return { source, olderMain, mainTip, head }
}

function runClassifier(cwd: string, base: string, head: string) {
  const env = { ...process.env }
  delete env.GITHUB_OUTPUT
  return spawnSync(process.execPath, [CLI, '--git-base', base, '--git-head', head, '--base-ref', 'main'], {
    cwd,
    encoding: 'utf8',
    env,
  })
}

// `file://` forces the transport: a path clone hardlinks every object, which
// would hand the checkout commit B and hide the defect.
function cloneHead(tmp: string, source: string, ...extra: string[]): string {
  const checkout = join(tmp, 'checkout')
  gitOk(tmp, 'clone', '-q', '--no-tags', '--single-branch', '--branch', 'head', ...extra, `file://${source}`, checkout)
  return checkout
}

test('a fetched base brings the history the three-dot diff needs (real repository)', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'fledge-ci-changes-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const { source, olderMain, mainTip, head } = buildDivergedRepository(tmp)
  const checkout = cloneHead(tmp, source)
  assert.notEqual(
    gitIn(checkout, 'cat-file', '-e', `${mainTip}^{commit}`).status,
    0,
    'the base commit must start absent, or this case proves nothing',
  )

  const run = runClassifier(checkout, mainTip, head)
  assert.equal(run.status, 0, run.stderr)
  const changes = JSON.parse(run.stdout.trim())
  assert.equal(changes.docsOnly, true, `the fetched base must be diffable; stderr: ${run.stderr}`)
  assert.equal(changes.codeql, false, 'a docs-only diff must not wake codeql-required')
  assert.equal(gitOk(checkout, 'merge-base', mainTip, head), olderMain, 'the merge base is what the three-dot diff needs')
})

test('a shallow checkout is deepened before the classifier gives up (real repository)', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'fledge-ci-changes-shallow-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))
  const { source, mainTip, head } = buildDivergedRepository(tmp)
  const checkout = cloneHead(tmp, source, '--depth=1')
  assert.equal(gitOk(checkout, 'rev-parse', '--is-shallow-repository'), 'true')

  // The base fetch alone cannot answer this one: a depth-one checkout has no
  // ancestors under the head either, so a complete base still shares no
  // history with it. Only deepening the checkout restores the merge base.
  const run = runClassifier(checkout, mainTip, head)
  assert.equal(run.status, 0, run.stderr)
  const changes = JSON.parse(run.stdout.trim())
  assert.equal(changes.docsOnly, true, `a deepened checkout must be diffable; stderr: ${run.stderr}`)
  assert.equal(changes.codeql, false, 'a docs-only diff must not wake codeql-required')
  assert.equal(gitOk(checkout, 'rev-parse', '--is-shallow-repository'), 'false', 'the checkout must be deepened to answer')
})
