import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideDrive } from '../scripts/lib/release-drive.mjs'
import { isMechanicalPath, mechanicalRelease, releaseIdentity } from '../scripts/lib/mechanical-release.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLAN_OK = { shouldRelease: true, nextVersion: '0.3.0', reason: 'ok' }
const PLAIN_MERGE = { number: 7, title: 'feat: something', headRef: 'dev2/something' }

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-risk-'))
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  run(['init', '-q'])
  run(['config', 'user.email', 'test@example.com'])
  run(['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), 'base\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'base'])
  mkdirSync(join(dir, 'changelog.d'), { recursive: true })
  writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n')
  writeFileSync(join(dir, 'changelog.d', 'x.added.md'), 'a fragment\n')
  writeFileSync(join(dir, 'package.json'), '{"version":"0.3.0"}\n')
  writeFileSync(join(dir, 'package-lock.json'), '{}\n')
  writeFileSync(join(dir, 'docker-compose.yml'), 'services: {}\n')
  run(['add', '.'])
  run(['commit', '-q', '-m', 'release: v0.3.0'])
  // risk-gate reads the rules from the working directory, so the fixture carries
  // the repository's real rules rather than a copy that could drift.
  mkdirSync(join(dir, '.github', 'agent'), { recursive: true })
  copyFileSync(join(ROOT, '.github', 'agent', 'risk-rules.json'), join(dir, '.github', 'agent', 'risk-rules.json'))
  return dir
}

// --- the identity key ---------------------------------------------------------

test('a release branch and title with the same version are one identity', () => {
  assert.deepEqual(releaseIdentity({ branch: 'release/v0.3.0', title: 'release: v0.3.0' }), { version: '0.3.0' })
  assert.deepEqual(releaseIdentity({ branch: 'refs/heads/release/v0.3.0', title: 'release: v0.3.0' }), { version: '0.3.0' })
})

test('a mismatch between the branch version and the title version is not an identity', () => {
  assert.equal(releaseIdentity({ branch: 'release/v0.3.0', title: 'release: v0.4.0' }), null)
  assert.equal(releaseIdentity({ branch: 'dev2/0.3.0', title: 'release: v0.3.0' }), null)
  assert.equal(releaseIdentity({ branch: 'release/v0.3.0', title: 'release: 0.3.0' }), null)
  assert.equal(releaseIdentity({ branch: 'release/v0.3.0', title: 'feat: release: v0.3.0' }), null)
})

test('the mechanical file set is the five allowed paths and nothing else', () => {
  for (const path of ['CHANGELOG.md', 'package.json', 'package-lock.json', 'docker-compose.yml', 'changelog.d/58-x.fixed.md', 'changelog.d/README.md']) {
    assert.equal(isMechanicalPath(path), true, path)
  }
  for (const path of ['src/app.ts', 'scripts/risk-gate.mjs', '.github/workflows/ci.yml', 'docs/deploy.md', 'changelog.d/README.md.bak']) {
    assert.equal(isMechanicalPath(path), false, path)
  }
})

test('the mechanical class needs branch, title and file set together', () => {
  const files = ['CHANGELOG.md', 'changelog.d/58-x.fixed.md', 'package.json', 'package-lock.json', 'docker-compose.yml']
  assert.equal(mechanicalRelease({ branch: 'release/v0.3.0', title: 'release: v0.3.0', files }).mechanical, true)

  const noBranch = mechanicalRelease({ branch: 'dev2/80-release-driver', title: 'release: v0.3.0', files })
  assert.equal(noBranch.mechanical, false)
  assert.match(noBranch.reason, /not a release/)

  const noTitle = mechanicalRelease({ branch: 'release/v0.3.0', title: 'feat: x', files })
  assert.equal(noTitle.mechanical, false)

  const outside = mechanicalRelease({ branch: 'release/v0.3.0', title: 'release: v0.3.0', files: [...files, 'src/app.ts'] })
  assert.equal(outside.mechanical, false)
  assert.match(outside.reason, /outside the mechanical set/)
})

// --- the same five files are T3 without the key ------------------------------

test('risk-gate reports the same five-file diff as T3 without the branch and title', () => {
  const dir = gitRepo()
  const script = join(ROOT, 'scripts', 'risk-gate.mjs')
  const run = (extra: string[]): string =>
    execFileSync('node', [script, '--base', 'HEAD~1', '--head', 'HEAD', ...extra], { cwd: dir, encoding: 'utf8' })

  const plain = run([])
  assert.match(plain, /changed files: 5/)
  assert.match(plain, /risk-tier: T3/)

  const keyed = run(['--branch', 'release/v0.3.0', '--title', 'release: v0.3.0'])
  assert.match(keyed, /risk-tier: T0; basis: mechanical release v0\.3\.0/)

  const wrongTitle = run(['--branch', 'release/v0.3.0', '--title', 'release: v0.4.0'])
  assert.match(wrongTitle, /risk-tier: T3/)
})

// --- the drive decision table ------------------------------------------------

test('the rule met with nothing in flight opens exactly one release PR', () => {
  const decision = decideDrive({ plan: PLAN_OK, openReleasePr: null, lastMergedPr: PLAIN_MERGE, tags: ['v0.2.4'], ciOk: 'success' })
  assert.equal(decision.action, 'open-pr')
  assert.equal(decision.version, '0.3.0')
})

test('the rule not met reports and opens nothing', () => {
  const decision = decideDrive({ plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'not-enough-prs' }, lastMergedPr: PLAIN_MERGE, tags: [], ciOk: 'success' })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /not-enough-prs/)
})

test('a rule met but a red ci-ok on main never opens a release PR', () => {
  const decision = decideDrive({ plan: PLAN_OK, lastMergedPr: PLAIN_MERGE, tags: [], ciOk: 'failure' })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /ci-ok on main is failure/)
})

test('a dry run prints the decision and opens nothing', () => {
  const decision = decideDrive({ plan: PLAN_OK, lastMergedPr: PLAIN_MERGE, tags: [], ciOk: 'success', dryRun: true })
  assert.equal(decision.action, 'none')
  assert.equal(decision.dryRun, true)
})

test('an open release PR is enqueued, never duplicated', () => {
  const decision = decideDrive({
    plan: PLAN_OK,
    openReleasePr: { number: 141, headSha: 'a'.repeat(40), blocked: false, checks: [{ name: 'ci-ok', status: 'completed', conclusion: 'success' }] },
    lastMergedPr: PLAIN_MERGE,
    tags: [],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'enqueue')
  assert.equal(decision.pr, 141)
  assert.equal(decision.headSha, 'a'.repeat(40))
})

test('an open release PR with a red check is reported and not merged', () => {
  const decision = decideDrive({
    plan: PLAN_OK,
    openReleasePr: {
      number: 141,
      headSha: 'b'.repeat(40),
      blocked: false,
      checks: [
        { name: 'ci-ok', status: 'completed', conclusion: 'success' },
        { name: 'review-gate', status: 'completed', conclusion: 'failure' },
      ],
    },
    lastMergedPr: PLAIN_MERGE,
    tags: [],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'report-blocked')
  assert.deepEqual(decision.failing, ['review-gate'])
  assert.match(decision.reason, /review-gate/)
})

test('a merged release PR whose tag is missing is tagged once', () => {
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'open-release-pr' },
    openReleasePr: null,
    lastMergedPr: { number: 141, title: 'release: v0.3.0', headRef: 'release/v0.3.0' },
    tags: ['v0.2.4'],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'tag')
  assert.equal(decision.tag, 'v0.3.0')
})

test('a merged release PR that is already tagged does nothing', () => {
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'tag-exists' },
    openReleasePr: null,
    lastMergedPr: { number: 141, title: 'release: v0.3.0', headRef: 'release/v0.3.0' },
    tags: ['v0.2.4', 'v0.3.0'],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'none')
})

test('a release-looking merge without its release branch is never tagged on a guess', () => {
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'tag-exists' },
    openReleasePr: null,
    lastMergedPr: { number: 141, title: 'release: v0.3.0', headRef: 'dev2/somewhere-else' },
    tags: ['v0.2.4'],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /no readable release branch/)
})
