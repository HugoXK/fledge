import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildState, latestConclusion, plannerInput } from '../scripts/lib/release-state.mjs'
import { planRelease } from '../scripts/release-plan.mjs'
import { decideDrive } from '../scripts/lib/release-drive.mjs'

// The daily release used to assemble its state in one `jq` expression inside the
// workflow, and `gh api --paginate ... --slurp | jq -s 'add'` produced an array of
// page arrays: selecting `.title` aborted the step before the planner ran, and no
// test could see it because the suite grepped YAML. These cases execute the code
// that now does the assembly, with the payload shape the workflow actually writes.

const execFileAsync = promisify(execFile)
const scriptPath = fileURLToPath(new URL('../scripts/release-state.mjs', import.meta.url))
const workflow = await import('node:fs').then(({ readFileSync }) =>
  readFileSync(new URL('../.github/workflows/daily-release.yml', import.meta.url), 'utf8'),
)

const PAGE_ONE = [
  { number: 11, title: 'feat: one', merged_at: '2026-11-01T10:00:00Z' },
  { number: 12, title: 'feat: two', merged_at: '2026-11-02T10:00:00Z' },
]
const PAGE_TWO = [{ number: 13, title: 'release: v0.3.0', merged_at: '2026-11-03T10:00:00Z' }]

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value))
  return path
}

async function runState(args: string[]): Promise<string> {
  const result = await execFileAsync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' })
  return result.stdout
}

test('the slurped page shape is flattened, so the open release PR is found', async () => {
  // `jq -s .` over two gh pages gives [[...],[...]]; `--slurp` gives the same.
  const dir = mkdtempSync(join(tmpdir(), 'fledge-state-'))
  try {
    const prs = writeJson(dir, 'prs.json', [PAGE_ONE, PAGE_TWO])
    const open = writeJson(dir, 'open.json', [[{ number: 20, title: 'feat: not a release' }], [{ number: 21, title: 'release: v0.3.0', head: { ref: 'release/v0.3.0', repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } }]])
    const checks = writeJson(dir, 'checks.json', { total_count: 1, check_runs: [{ id: 1, name: 'ci-ok', conclusion: 'success' }] })
    const out = await runState(['--prs', prs, '--open', open, '--checks', checks, '--tags-json', '["v0.2.4"]'])
    const state = JSON.parse(out) as { openPr: { number: number } | null; lastMerged: { number: number } | null; mergedPrs: unknown[] }
    assert.equal(state.openPr?.number, 21, 'the open release PR must be found across pages')
    assert.equal(state.mergedPrs.length, 3, 'every merged PR from every page counts')
    assert.equal(state.lastMerged?.number, 13, 'the last merged PR is the newest by merged_at')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a title that starts with "release: v" is not the release PR without the release branch', () => {
  // #146 finding 5: a docs-only `release: v9.9.9` on a feature branch must never
  // be picked up as the release PR, because the drive would enqueue it.
  const state = buildState({
    lastTag: 'v0.2.4',
    packageVersion: '0.2.4',
    fragments: 1,
    tags: ['v0.2.4'],
    closedPages: [[]],
    openPages: [[{ number: 41, title: 'release: v9.9.9', head: { ref: 'dev2/docs-only' } }]],
    checks: [],
  })
  assert.equal(state.openPr, null, 'a self-declared release title is not the release PR')
  assert.equal(state.openPrRejected?.number, 41, 'the rejected candidate is recorded rather than silently dropped')
  assert.match(String(state.openPrRejected?.branch ?? ''), /dev2\/docs-only/)
})

test('a single flat page is accepted as well', () => {
  const state = buildState({
    lastTag: 'v0.2.4',
    packageVersion: '0.2.4',
    fragments: '2',
    tags: ['v0.2.4'],
    dryRun: 'true',
    closedPages: PAGE_ONE,
    openPages: [],
    checks: [{ id: 5, name: 'ci-ok', conclusion: 'success' }],
  })
  assert.equal(state.mergedPrs.length, 2)
  assert.equal(state.openPr, null)
  assert.equal(state.ciOk, 'success')
  assert.equal(state.dryRun, true)
  assert.equal(state.fragments, 2)
})

test('the newest ci-ok run wins, not the first in the list', () => {
  // The API lists the oldest run first; after a re-run `first` would read a stale
  // conclusion and could refuse a night that should have released.
  const checks = {
    total_count: 2,
    check_runs: [
      { id: 100, name: 'ci-ok', conclusion: 'failure' },
      { id: 200, name: 'ci-ok', conclusion: 'success' },
    ],
  }
  assert.equal(latestConclusion(checks, 'ci-ok'), 'success')
  assert.equal(latestConclusion({ check_runs: [] }, 'ci-ok'), 'missing')
})

test('a merged pull request without merged_at is not counted', () => {
  const state = buildState({
    closedPages: [[{ number: 1, title: 'feat: closed unmerged', merged_at: null }, ...PAGE_ONE]],
    openPages: [],
    checks: [],
  })
  assert.deepEqual(state.mergedPrs.map((pr) => pr.number), [11, 12])
  assert.equal(state.ciOk, 'missing')
})

test('the workflow runs the tested module instead of an inline jq pipeline', () => {
  assert.match(workflow, /node scripts\/release-state\.mjs/)
  assert.doesNotMatch(workflow, /gh api[^\n]*--slurp/)
  assert.doesNotMatch(workflow, /jq -s 'add/)
})

// #146 review `5829820145`: a foreign PR titled `release: v…` must be a notice,
// never a reason the night does nothing. Two shapes were measured at `64709976`:
// the plan turned `openPrRejected` into `openReleasePr: true`, and the title-only
// `.find()` let a newer foreign PR take the slot of this repository's own PR.
const MERGED_TWELVE = Array.from({ length: 12 }, (_, index) => ({
  number: 300 + index,
  title: index < 6 ? `feat: change ${index}` : `fix: change ${index}`,
  merged_at: `2026-11-01T${String(10 + index).padStart(2, '0')}:00:00Z`,
}))

const FOREIGN_RELEASE_PR = {
  number: 201,
  title: 'release: v0.4.0',
  head: { ref: 'release/v0.4.0', sha: 'f0e1', repo: { full_name: 'evil/fledge' } },
  base: { repo: { full_name: 'HugoXK/fledge' } },
}

const OWN_RELEASE_PR = {
  number: 199,
  title: 'release: v0.4.0',
  head: { ref: 'release/v0.4.0', sha: 'a0a0', repo: { full_name: 'HugoXK/fledge' } },
  base: { repo: { full_name: 'HugoXK/fledge' } },
}

function stateWith({ openPages, closedPages = [MERGED_TWELVE], checks = [{ id: 9, name: 'ci-ok', conclusion: 'success' }] }: {
  openPages: unknown[]
  closedPages?: unknown[]
  checks?: unknown[]
}) {
  return buildState({
    lastTag: 'v0.3.0',
    lastTagCommittedAt: '2026-10-31T00:00:00Z',
    packageVersion: '0.3.0',
    fragments: 3,
    tags: ['v0.3.0'],
    closedPages,
    openPages,
    checks,
  })
}

test('a foreign release-shaped PR alone leaves the night releasable', () => {
  const state = stateWith({ openPages: [[FOREIGN_RELEASE_PR]] })
  assert.equal(state.openPr, null, 'a fork PR is never the release PR')
  assert.equal(state.openPrRejected?.number, 201, 'it is recorded for the notice')
  assert.match(String(state.openPrRejected?.repo ?? ''), /evil\/fledge/)

  const input = plannerInput(state)
  assert.equal(input.openReleasePr, false, 'a rejected candidate is not an open release PR')
  const plan = planRelease(input)
  assert.equal(plan.shouldRelease, true, 'the rule is met, so the night is not halted')
  assert.equal(plan.nextVersion, '0.4.0')

  const decision = decideDrive({
    plan: { shouldRelease: plan.shouldRelease, nextVersion: plan.nextVersion, reason: plan.reason },
    openReleasePr: null,
    mergedPrs: [],
    tags: state.tags,
    ciOk: state.ciOk,
    dryRun: false,
  })
  assert.equal(decision.action, 'open-pr')
  assert.equal(decision.version, '0.4.0')
})

test('a newer foreign PR cannot shadow this repository\'s own release PR', () => {
  // The open list is newest-created first, so the title-only `.find()` picked the
  // fork PR and demoted the routine's own PR to `openPrRejected`: nothing was
  // enqueued and nothing was replaced.
  const state = stateWith({ openPages: [[FOREIGN_RELEASE_PR, OWN_RELEASE_PR]] })
  assert.equal(state.openPr?.number, 199, 'the same-repo release PR keeps the slot')
  assert.equal(state.openPrRejected?.number, 201, 'the foreign PR is the notice, not the candidate')
  assert.equal(plannerInput(state).openReleasePr, true, 'the accepted candidate is the open release PR')

  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.4.0', reason: 'open-release-pr' },
    openReleasePr: {
      number: 199,
      headSha: 'a0a0',
      branch: 'release/v0.4.0',
      title: 'release: v0.4.0',
      files: ['CHANGELOG.md', 'changelog.d/80.added.md', 'package.json', 'package-lock.json', 'docker-compose.yml'],
      blocked: false,
      checks: [{ name: 'ci-ok', conclusion: 'success' }],
      sameRepo: true,
    },
    mergedPrs: [],
    tags: state.tags,
    ciOk: 'success',
    dryRun: false,
  })
  assert.equal(decision.action, 'enqueue', 'the routine enqueues its own PR')
  assert.equal(decision.pr, 199)
})

// --- the orphan branch (#333) -------------------------------------------------
//
// `release/v0.3.2` exists at a pushable sha with no pull request in any state and
// no `v0.3.2` tag: a run pushed it, then refused to open the pull request. Every
// later run died inside the push step with a message about "different content",
// which is true but says nothing about the state. The classification lives where
// the state is assembled, and the drive names it as the blocked state it is.

const ORPHAN_SHA = '224096bdadb3c2e683c4774dd8713f2dbc103fa6'
const ORPHAN_BRANCH = { name: 'release/v0.3.2', commit: { sha: ORPHAN_SHA } }

// The `branches` input is typed now that `| unknown` is gone from the
// declaration: `GET /branches` answers `{ name, commit: { sha } }`, and typing
// the fixture here is what keeps that shape honest instead of `unknown[]`.
function orphanState({ branches = [ORPHAN_BRANCH], openPages = [], closedPages = [], tags = ['v0.3.1'] }: {
  branches?: Array<{ name: string; commit: { sha: string } }>
  openPages?: unknown[]
  closedPages?: unknown[]
  tags?: string[]
} = {}) {
  return buildState({
    lastTag: 'v0.3.1',
    lastTagCommittedAt: '2026-11-10T20:57:10Z',
    packageVersion: '0.3.1',
    fragments: 3,
    tags,
    branches,
    closedPages,
    openPages,
    checks: [{ id: 9, name: 'ci-ok', conclusion: 'success' }],
  })
}

const PLAN_0302 = { shouldRelease: true, nextVersion: '0.3.2', reason: 'the rule is met' }

function driveOrphan(state: ReturnType<typeof orphanState>) {
  return decideDrive({
    plan: PLAN_0302,
    openReleasePr: null,
    mergedPrs: [],
    tags: state.tags,
    orphanBranches: state.orphanBranches,
    ciOk: state.ciOk,
    dryRun: false,
  })
}

test('a release branch with no pull request and no tag is an orphan, and the drive blocks by name', () => {
  const state = orphanState()
  assert.deepEqual(state.orphanBranches, [{ branch: 'release/v0.3.2', version: '0.3.2', tag: 'v0.3.2', sha: ORPHAN_SHA }])

  const decision = driveOrphan(state)
  assert.equal(decision.action, 'report-blocked')
  assert.match(decision.reason, /orphan-branch/)
  assert.match(decision.reason, /release\/v0\.3\.2/)
  assert.match(decision.reason, new RegExp(ORPHAN_SHA))
  assert.match(decision.reason, /owner/, 'the reason says the repair is not the run\'s')
})

test('a pull request from another repository does not clear the orphan', () => {
  // #333 review: the head-ref set was built from every pull request, so a fork
  // PR whose branch happened to be `release/v0.3.2` suppressed the orphan and
  // sent the night back to the generic "different content" red. A branch is only
  // accounted for by a pull request that comes from this repository itself, the
  // same predicate the release candidate takes above.
  const fork = {
    number: 301,
    title: 'fix: an unrelated change',
    head: { ref: 'release/v0.3.2', sha: ORPHAN_SHA, repo: { full_name: 'someone-else/fledge' } },
    base: { repo: { full_name: 'HugoXK/fledge' } },
    merged_at: null,
  }
  const state = orphanState({ openPages: [[fork]] })
  assert.deepEqual(
    state.orphanBranches,
    [{ branch: 'release/v0.3.2', version: '0.3.2', tag: 'v0.3.2', sha: ORPHAN_SHA }],
    'a fork branch with the same name is not this repository\'s branch',
  )
  assert.equal(driveOrphan(state).action, 'report-blocked')
})

test('an orphan blocks the night even when the release rule is not met', () => {
  // The orphan check sits ahead of the rule gate: a wedged slot is red on every
  // night until the owner clears it, including a night whose plan would not have
  // released — that is the run which would otherwise reach the push step later
  // and die there with a message about different content.
  const state = orphanState()
  const decision = decideDrive({
    plan: { shouldRelease: false, nextVersion: '0.3.2', reason: 'only 9 merged PRs, need 10' },
    openReleasePr: null,
    mergedPrs: [],
    tags: state.tags,
    orphanBranches: state.orphanBranches,
    ciOk: state.ciOk,
    dryRun: false,
  })
  assert.equal(decision.action, 'report-blocked', 'the orphan is reported ahead of the rule gate')
  assert.match(decision.reason, /^orphan-branch:/)
})

test('an orphan branch is not reported once a pull request or the tag exists', () => {
  const withOpenPr = orphanState({
    openPages: [[{ ...OWN_RELEASE_PR, head: { ...OWN_RELEASE_PR.head, ref: 'release/v0.3.2' } }]],
  })
  assert.deepEqual(withOpenPr.orphanBranches, [], 'an open pull request means the branch is not orphaned')

  const withMergedPr = orphanState({
    openPages: [],
    closedPages: [[{
      number: 208,
      title: 'release: v0.3.2',
      head: { ref: 'release/v0.3.2', sha: ORPHAN_SHA, repo: { full_name: 'HugoXK/fledge' } },
      base: { repo: { full_name: 'HugoXK/fledge' } },
      merged_at: '2026-11-11T16:00:00Z',
      merge_commit_sha: 'b'.repeat(40),
    }]],
  })
  assert.deepEqual(withMergedPr.orphanBranches, [], 'a merged pull request means the branch shipped, so the tag path owns it')

  const withTag = orphanState({ tags: ['v0.3.1', 'v0.3.2'] })
  assert.deepEqual(withTag.orphanBranches, [], 'the tag means the slot shipped')
})

test('the existing reasons are unchanged when the branch is not an orphan', () => {
  const withTag = orphanState({ tags: ['v0.3.1', 'v0.3.2'] })
  assert.equal(withTag.orphanBranches.length, 0)
  const decision = driveOrphan(withTag)
  assert.equal(decision.action, 'open-pr', 'with the tag present the next release is free to plan')
  assert.doesNotMatch(decision.reason, /orphan-branch/)

  const merged = orphanState({
    openPages: [],
    closedPages: [[{
      number: 208,
      title: 'release: v0.3.2',
      head: { ref: 'release/v0.3.2', sha: ORPHAN_SHA, repo: { full_name: 'HugoXK/fledge' } },
      base: { repo: { full_name: 'HugoXK/fledge' } },
      merged_at: '2026-11-11T16:00:00Z',
      merge_commit_sha: 'b'.repeat(40),
    }]],
  })
  const tagDecision = decideDrive({
    plan: PLAN_0302,
    openReleasePr: null,
    mergedPrs: [{ number: 208, title: 'release: v0.3.2', headRef: 'release/v0.3.2', mergeCommitSha: 'b'.repeat(40) }],
    tags: merged.tags,
    orphanBranches: merged.orphanBranches,
    ciOk: merged.ciOk,
    dryRun: false,
  })
  assert.equal(tagDecision.action, 'tag', 'a merged release PR without its tag is still tagged')
  assert.doesNotMatch(tagDecision.reason, /orphan-branch/)
})

test('nothing is reported about branches when there is no release branch at all', () => {
  const state = orphanState({ branches: [{ name: 'main', commit: { sha: 'c'.repeat(40) } }] })
  assert.deepEqual(state.orphanBranches, [])
  assert.doesNotMatch(driveOrphan(state).reason, /orphan-branch/)
})

test('the workflow plans from the tested projection, not an inline jq expression', () => {
  assert.match(workflow, /import \{ plannerInput \} from "\.\/scripts\/lib\/release-state\.mjs"/)
  assert.equal(workflow.includes('openReleasePr: (.openPr != null or .openPrRejected != null)'), false)
  assert.match(workflow, /state\.openPrRejected/)
  assert.match(workflow, /Notice: ignored pull request/)
})
