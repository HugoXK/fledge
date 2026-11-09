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
const PLAIN_MERGE = { number: 7, title: 'feat: something', headRef: 'dev2/something', mergeCommitSha: 'f'.repeat(40) }
const MECH_FILES = ['CHANGELOG.md', 'changelog.d/1.added.md', 'package.json', 'package-lock.json', 'docker-compose.yml']
const OPEN_RELEASE = {
  number: 141,
  headSha: 'a'.repeat(40),
  branch: 'release/v0.3.0',
  title: 'release: v0.3.0',
  files: MECH_FILES,
  blocked: false,
  checks: [{ name: 'ci-ok', status: 'completed', conclusion: 'success' }],
}

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
  const decision = decideDrive({ plan: PLAN_OK, openReleasePr: null, tags: ['v0.2.4'], ciOk: 'success' })
  assert.equal(decision.action, 'open-pr')
  assert.equal(decision.version, '0.3.0')
})

test('the rule not met reports and opens nothing', () => {
  const decision = decideDrive({ plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'not-enough-prs' }, tags: [], ciOk: 'success' })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /not-enough-prs/)
})

test('a rule met but a red ci-ok on main never opens a release PR', () => {
  const decision = decideDrive({ plan: PLAN_OK, tags: [], ciOk: 'failure' })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /ci-ok on main is failure/)
})

test('a dry run prints the decision and opens nothing', () => {
  const decision = decideDrive({ plan: PLAN_OK, tags: [], ciOk: 'success', dryRun: true })
  assert.equal(decision.action, 'none')
  assert.equal(decision.dryRun, true)
})

test('a dry run never enqueues the open release PR', () => {
  // workflow_dispatch defaults dry_run to true, so this is the default manual
  // dispatch: returning `enqueue` here would set auto-merge on the first click.
  const decision = decideDrive({ plan: PLAN_OK, openReleasePr: OPEN_RELEASE, tags: [], ciOk: 'success', dryRun: true })
  assert.equal(decision.action, 'none')
  assert.equal(decision.wouldHave, 'enqueue')
  assert.equal(decision.dryRun, true)
})

test('a dry run never tags the merged release PR', () => {
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'open-release-pr' },
    mergedPrs: [{ number: 141, title: 'release: v0.3.0', headRef: 'release/v0.3.0', mergeCommitSha: 'c'.repeat(40) }],
    tags: ['v0.2.4'],
    ciOk: 'success',
    dryRun: true,
  })
  assert.equal(decision.action, 'none')
  assert.equal(decision.wouldHave, 'tag')
  assert.equal(decision.tag, 'v0.3.0')
})

test('an open release PR is enqueued, never duplicated', () => {
  const decision = decideDrive({ plan: PLAN_OK, openReleasePr: OPEN_RELEASE, tags: [], ciOk: 'success' })
  assert.equal(decision.action, 'enqueue')
  assert.equal(decision.pr, 141)
  assert.equal(decision.headSha, 'a'.repeat(40))
})

test('an open release PR with a red check is reported and not merged', () => {
  const decision = decideDrive({
    plan: PLAN_OK,
    openReleasePr: {
      ...OPEN_RELEASE,
      headSha: 'b'.repeat(40),
      checks: [
        { name: 'ci-ok', status: 'completed', conclusion: 'success' },
        { name: 'review-gate', status: 'completed', conclusion: 'failure' },
      ],
    },
    tags: [],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'report-blocked')
  assert.deepEqual(decision.failing, ['review-gate'])
  assert.match(decision.reason, /review-gate/)
})

test('an open release PR whose checks were never collected is not enqueued blind', () => {
  // #146 finding 3: the checks step used to run only when shouldRelease was true,
  // which is false exactly when a release PR is open.
  const decision = decideDrive({ plan: PLAN_OK, openReleasePr: { ...OPEN_RELEASE, checks: [] }, tags: [], ciOk: 'success' })
  assert.equal(decision.action, 'report-blocked')
  assert.match(decision.reason, /no collected checks/)
})

test('a title-only release PR is not enqueued as the mechanical release', () => {
  // #146 finding 5: a docs-only `release: v9.9.9` must never be auto-merged.
  const decision = decideDrive({
    plan: PLAN_OK,
    openReleasePr: { ...OPEN_RELEASE, branch: 'dev2/docs-only', title: 'release: v9.9.9', files: ['docs/ui.md'] },
    tags: [],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'report-blocked')
  assert.match(decision.reason, /not the mechanical release/)
})

test('a mechanical-shaped open PR with a dependency change is not enqueued', () => {
  const decision = decideDrive({
    plan: PLAN_OK,
    openReleasePr: { ...OPEN_RELEASE, files: [...MECH_FILES, 'src/app.ts'] },
    tags: [],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'report-blocked')
  assert.match(decision.reason, /outside the mechanical set/)
})

test('a merged release PR whose tag is missing is tagged on its squash commit', () => {
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'open-release-pr' },
    openReleasePr: null,
    mergedPrs: [{ number: 141, title: 'release: v0.3.0', headRef: 'release/v0.3.0', mergeCommitSha: 'c'.repeat(40) }],
    tags: ['v0.2.4'],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'tag')
  assert.equal(decision.tag, 'v0.3.0')
  assert.equal(decision.sha, 'c'.repeat(40), 'the tag must name the merge commit, never HEAD')
})

test('an untagged release PR is found even when a later merge is the last PR', () => {
  // #146 finding 4: scanning only the last merged PR meant one unrelated merge in
  // between silently lost the tag.
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'open-release-pr' },
    openReleasePr: null,
    mergedPrs: [
      { number: 141, title: 'release: v0.3.0', headRef: 'release/v0.3.0', mergeCommitSha: 'c'.repeat(40) },
      PLAIN_MERGE,
    ],
    tags: ['v0.2.4'],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'tag')
  assert.equal(decision.tag, 'v0.3.0')
  assert.equal(decision.sha, 'c'.repeat(40))
})

test('a merged release PR that is already tagged does nothing', () => {
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'tag-exists' },
    openReleasePr: null,
    mergedPrs: [{ number: 141, title: 'release: v0.3.0', headRef: 'release/v0.3.0', mergeCommitSha: 'c'.repeat(40) }],
    tags: ['v0.2.4', 'v0.3.0'],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'none')
})

test('a release-looking merge without its release branch is never tagged on a guess', () => {
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'tag-exists' },
    openReleasePr: null,
    mergedPrs: [{ number: 141, title: 'release: v0.3.0', headRef: 'dev2/somewhere-else', mergeCommitSha: 'c'.repeat(40) }],
    tags: ['v0.2.4'],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /no readable release branch/)
})

test('a merged release PR without a merge commit sha is not tagged on HEAD', () => {
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.0', reason: 'tag-exists' },
    openReleasePr: null,
    mergedPrs: [{ number: 141, title: 'release: v0.3.0', headRef: 'release/v0.3.0' }],
    tags: ['v0.2.4'],
    ciOk: 'success',
  })
  assert.equal(decision.action, 'none')
  assert.match(decision.reason, /no merge commit sha/)
})
