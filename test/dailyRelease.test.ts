import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The contract of issue #80, as a structural test: the file may carry no stored
// secret, no file-level permissions block, no pull-request creation or release
// command and no local tag command. Since #1127 it also carries no auto-merge:
// the workflow opens the mechanical release pull request and reports where it
// stands, and a person merges it once the required checks and the review gate
// pass. Before #1127 auto-merge was the one deliberate exception, enabled on
// that PR with a pinned head commit, and a release could merge with no PASS.
// Every assertion here fails on the pre-#80 file, where `RELEASE_TOKEN` gated the
// run, the permissions block was file-level, and the tag came from
// `git tag`/`git push origin "$TAG"`.

const daily = readFileSync('.github/workflows/daily-release.yml', 'utf8')
const release = readFileSync('.github/workflows/release.yml', 'utf8')

// Two lists, this branch's own additions, kept apart so a test file can never
// ride in on the script rule. They are deliberately not "every release file
// that may exist": `#187` adds `scripts/release-open.mjs` on another branch,
// and an absolute listing of `scripts/` would go red on that merge and blame
// this change for it.
const allowedScripts = new Set([
  'scripts/lib/release-tag.d.mts',
  'scripts/lib/release-tag.mjs',
])
const allowedTests = new Set(['test/releaseTag.test.ts'])

// The only branch whose own additions are held to those two lists is the one the
// daily-release job creates (`release/v<version>`, `.github/workflows/daily-release.yml`
// `git checkout -b "$BRANCH"`). A working branch may add a test or a script for
// the change it makes; before this seam existed the guard read
// `origin/main...HEAD` and failed that branch, so `npm run check` was red for
// work unrelated to the release (#225). Returning the violations instead of
// asserting here is what lets the test drive both branches from one checkout.
function addedReleaseEntries(added: string[], branch: string): { tests: string[]; scripts: string[] } {
  if (!branch.startsWith('release/v')) return { tests: [], scripts: [] }
  return {
    tests: added.filter((path) => path.startsWith('test/') && path.endsWith('.test.ts') && !allowedTests.has(path)),
    scripts: added.filter((path) => path.startsWith('scripts/') && !allowedScripts.has(path)),
  }
}

// #1127's rule, and the reason it is not a repo-wide ban: the change that
// decides how a release pull request merges may not also edit the gate that
// judges it. Two shapes reach that rule — the branch the nightly opens
// (`release/v<version>`) and any change that edits the release workflow — and
// everything else may change `review-gate.mjs` under normal review, which is
// what the exemption card this thread defers will do. Returning the violations
// instead of asserting here is what lets one checkout drive every shape; the
// first version of this guard read `origin/main...HEAD` unconditionally, so it
// failed every later pull request that touched the gate.
const gatePaths = [
  'scripts/lib/review-gate.mjs',
  'scripts/lib/mechanical-release.mjs',
  '.github/agent/review-policy.json',
]

function gateEdits(changed: string[], branch: string): string[] {
  const releaseBranch = branch.startsWith('release/v')
  const touchesReleaseWorkflow = changed.includes('.github/workflows/daily-release.yml')
  if (!releaseBranch && !touchesReleaseWorkflow) return []
  return changed.filter((path) => gatePaths.includes(path))
}

// The branch this checkout is on, or `null` when git cannot answer. In CI the
// pull-request branch comes from `GITHUB_HEAD_REF`; the merge checkout's own
// `HEAD` is detached, so reading it alone would name no branch at all.
function currentBranch(): string | null {
  const fromEnv = process.env.GITHUB_HEAD_REF ?? ''
  if (fromEnv !== '') return fromEnv
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return branch === 'HEAD' || branch === '' ? null : branch
  } catch {
    return null
  }
}

// The paths this branch changes against `main`. `null` means "not answerable in
// this checkout" — a one-commit CI checkout with no merge base — and the caller
// records that as a skip. Any other git failure throws, so a broken checkout can
// never read as a pass.
function changedPaths(base: string): string[] | null {
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '')
    if (/no merge base|unknown revision|bad revision|ambiguous argument|not a valid object name|Needed a single revision/i.test(stderr)) {
      return null
    }
    throw error
  }
}

function between(from: string, to: string): string {
  const start = daily.indexOf(from)
  assert.notEqual(start, -1, `the workflow has "${from}"`)
  if (to === '') return daily.slice(start)
  const end = daily.indexOf(to, start + from.length)
  assert.notEqual(end, -1, `the workflow has "${to}" after "${from}"`)
  return daily.slice(start, end)
}

function job(name: string): string {
  const start = daily.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `the workflow has a "${name}" job`)
  const rest = daily.slice(start + 1)
  const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1))
  return next === null ? rest : rest.slice(0, next.index + 2)
}

function permissionBlock(job: string): Record<string, string> {
  const match = /\n {4}permissions:\n((?: {6}[a-z-]+: [a-z]+(?:\n|$))+)/.exec(job)
  assert.ok(match, 'the job declares its own permissions block')
  const block = match[1] ?? ''
  const entries: [string, string][] = []
  for (const line of block.trimEnd().split('\n')) {
    const at = line.indexOf(': ')
    assert.notEqual(at, -1, `a permission line is "key: value" — ${line}`)
    entries.push([line.slice(0, at).trim(), line.slice(at + 2).trim()])
  }
  return Object.fromEntries(entries)
}

test('the schedule is 10:00 Asia/Shanghai (02:00 UTC) with a 03:00Z catch-up, a manual dispatch defaults to a dry run, and a push is filtered to release-shaped paths', () => {
  assert.match(daily, /schedule:\s*\n(?:.*\n)*?\s*- cron: '0 2 \* \* \*'/)
  assert.match(daily, /schedule:\s*\n(?:.*\n)*?\s*- cron: '0 3 \* \* \*'/)
  assert.match(daily, /workflow_dispatch:/)
  assert.match(daily, /dry_run:/)
  assert.match(daily, /default: true/)
  assert.match(daily, /push:\s*\n\s*branches: \[main\]/)
  // #548: a plan job per merge was the steady-state cost. The paths filter keeps
  // the tag job on the release merge and drops ordinary feature pushes.
  const push = between('  push:', 'concurrency:')
  assert.match(push, /paths:\s*\n(?:\s*- [^\n]+\n)+/)
  const filtered = [...push.matchAll(/^\s*- ([^\n]+)$/gm)].map((match) => String(match[1]).trim())
  for (const path of ['package.json', 'package-lock.json', 'CHANGELOG.md', 'docker-compose.yml']) {
    assert.ok(filtered.includes(path), `the push filter includes ${path}`)
  }
  assert.equal(filtered.includes('changelog.d/**'), false, 'almost every feature PR adds a fragment; filtering on it would restore the per-PR noise')
})

test('permissions are declared per job, and there is no file-level block to widen both', () => {
  assert.equal(/^permissions:/m.test(daily), false, 'a file-level permissions: block widens every job')
  assert.deepEqual(permissionBlock(job('release')), {
    contents: 'write',
    'pull-requests': 'read',
    checks: 'read',
    issues: 'write',
  })
  assert.deepEqual(permissionBlock(job('tag')), {
    contents: 'write',
    'pull-requests': 'read',
    actions: 'write',
  })
})

test('the team token is the only stored secret, and it is not the reviewer token', () => {
  const names = [...daily.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => String(match[1]))
  assert.ok(names.length > 0, 'the file uses the automatic token')
  assert.deepEqual([...new Set(names)].sort(), ['GITHUB_TOKEN', 'RELEASE_OPEN_TOKEN'], 'exactly two credentials: the automatic token and the opener')
  assert.equal(daily.includes('RELEASE_TOKEN'), false, 'the old stored token is gone, not merely unused')
  assert.equal(daily.includes('HugoXK-bot'), false, 'the reviewer identity is never wired into the release run')
  assert.equal(/token: \$\{\{/.test(daily), false, 'the checkout uses the default token')
})

test('the opener token is readable only through the release environment (#527)', () => {
  // The repository scope meant every workflow on `main` could read the opener
  // token. The workflow half of the fix is this one key; the environment, its
  // secret and the deletion of the repository secret are owner actions, so this
  // test pins only what the file can promise — and it fails on the pre-#527 file,
  // where neither job declares an environment.
  assert.match(job('release'), /^ {4}environment: release$/m, 'the release job declares the environment that holds the opener token')
  assert.doesNotMatch(job('tag'), /^ {4}environment:/m, 'the tag job runs on GITHUB_TOKEN only and must not inherit the opener environment')
})

test('the release job runs on a push too, and the trigger predicate decides whether that push plans', () => {
  // #315: the event name is no longer the planning gate. A push is eligible
  // because the rule's input changes only on a push, and the summary says what
  // the trigger decided, so an ordinary merge that plans nothing is still
  // visible in the run history.
  assert.match(job('release'), /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch' \|\| github\.event_name == 'push'/)
  // #866: the scheduled slot also reaches the tag job, because a release can be
  // left half-made with no further push. The job decides from the API state
  // (tag present? release present?), not from the event that woke it.
  assert.match(job('tag'), /if: github\.event_name == 'push' \|\| github\.event_name == 'schedule'/)
  assert.doesNotMatch(job('tag'), /workflow_dispatch/, 'a manual dispatch never tags, so a dry run cannot publish')
  assert.match(job('tag'), /releaseLookupPath/, 'the tag job reads whether the GitHub Release exists, with the tag as one encoded path segment')
  assert.match(job('tag'), /release: JSON\.parse/, 'the release state is an input to the pure decision')
  const dispatchStep = between('      - name: Dispatch release.yml at the tag', '')
  assert.match(dispatchStep, /steps\.decide\.outputs\.action == 'create' \|\| steps\.decide\.outputs\.action == 'publish'/, 'a tag without its release dispatches the publish run')
  const createStep = between('      - name: Create the annotated tag on the merge commit', '      - name: Dispatch release.yml at the tag')
  assert.match(createStep, /if: \$\{\{ steps\.decide\.outputs\.action == 'create' \}\}/, 'a publish never writes a second tag')
  const step = between('      - name: Trigger', '      - name: Check the opener precondition')
  assert.match(step, /id: trigger/)
  // #548: this was `always()`. The step reads the state the collect step wrote,
  // and a collect step that failed must be the single report rather than an
  // ENOENT here, so the condition names that step's outcome instead.
  assert.match(step, /if: \$\{\{ steps\.state\.outcome == 'success' \}\}/)
  assert.match(step, /import \{ decideTrigger \} from "\.\/scripts\/lib\/release-trigger\.mjs"/)
  assert.match(step, /trigger=\$\{event\} plan=\$\{decision\.plan\}/)
  assert.equal(step.includes('gh api'), false, 'the trigger step reads the state the run already collected')
})

test('a failed collect step is the single report: plan and decide never dereference a state file it did not write', () => {
  // #548: only Trigger was guarded before this change; Plan and Decide still
  // read `$RUNNER_TEMP/state.json` under `set -euo pipefail`, so a collect
  // failure turned into a second ENOENT instead of the real error.
  const pairs: Array<[string, string]> = [
    ['      - name: Plan', '      - name: Decide'],
    ['      - name: Decide', '      - name: Trigger'],
  ]
  for (const [from, to] of pairs) {
    const step = between(from, to)
    assert.match(step, /if: \$\{\{ steps\.state\.outcome == 'success' \}\}/, `${from.trim()} runs only after a successful collect`)
  }
})

test('only the trigger can let a run push, and a manual dry run never does', () => {
  const openerStep = between('      - name: Check the opener precondition', '      - name: Push the release branch')
  assert.match(openerStep, /if: \$\{\{ inputs\.dry_run != true && steps\.trigger\.outputs\.plan == 'true' \}\}/)
  const pushStep = between('      - name: Push the release branch', '      - name: Write the plan artifact')
  assert.match(pushStep, /if: \$\{\{ inputs\.dry_run != true && steps\.trigger\.outputs\.plan == 'true' && steps\.opener\.outputs\.ready == 'true' \}\}/)
})

test('the file never creates, releases or auto-merges a pull request with gh, and the opener only reports where it stands', () => {
  for (const forbidden of ['gh pr create', 'gh release', 'git tag', 'git push origin "$TAG"', 'git push --tags', '--admin']) {
    assert.equal(daily.includes(forbidden), false, `"${forbidden}" must not appear`)
  }
  const pushes = [...daily.matchAll(/git push /g)]
  assert.equal(pushes.length, 1, 'exactly one git push, of the release branch')
  assert.ok(daily.includes('git push origin "$BRANCH"'), 'that push is the release branch')
  // #1127: opting the mechanical release PR into auto-merge merged a release with
  // no PASS on its tip. The workflow may open that PR and say where it stands;
  // merging it is a person's decision, so none of the auto-merge machinery may
  // appear anywhere in the file.
  for (const forbidden of ['gh pr merge', '--auto', '--match-head-commit', 'autoMergeRequest', 'Enable auto-merge']) {
    assert.equal(daily.includes(forbidden), false, `"${forbidden}" must not appear`)
  }
  const opener = between('      - name: Open the release pull request', '      - name: Comment on #80')
  assert.match(opener, /printf 'state=%s\\ndetail=%s\\npr=%s\\n'/, 'the opener still reports state, detail and pr')
  assert.match(opener, /steps\.push\.outputs\.pushed != ''/, 'and still runs only after a push')
})

test('the change that decides how a release PR merges may not also edit the gate that judges it', (t) => {
  // #1127 takes away the release workflow's ability to merge its own pull
  // request, and it must not do that by touching the verdict machinery: the
  // release workflow widening or narrowing its own exemption would be the exact
  // failure this card exists to stop. The rule is scoped to the shapes that can
  // reach it, so it does not become a standing ban on the gate for everyone else
  // (#1127 review, 2026-11-20).
  const gate = ['scripts/lib/review-gate.mjs', 'scripts/lib/mechanical-release.mjs', '.github/agent/review-policy.json']
  const workflow = '.github/workflows/daily-release.yml'

  // The decision, driven from this one checkout: every shape is exercised here.
  assert.deepEqual(gateEdits([...gate, workflow], 'dev2/1127-no-release-auto-merge'), gate, 'this change touches the release workflow, so it may not also edit the gate')
  assert.deepEqual(gateEdits([...gate, workflow], 'release/v0.4.4'), gate, 'the release branch may not edit the gate either')
  assert.deepEqual(gateEdits(['docs/deploy.md', workflow], 'dev2/anything'), [], 'the release workflow itself is not a gate file')
  assert.deepEqual(gateEdits(gate, 'dev2/1127-no-release-auto-merge'), [], 'a branch that leaves the release workflow alone may change the gate under review')
  assert.deepEqual(gateEdits([...gate, 'src/app.ts'], 'main'), [], 'main may change the gate under review, including the exemption card this thread defers')
  assert.deepEqual(gateEdits(gate, 'release/v0.4.4'), gate, 'on the release branch the rule holds without the workflow being touched')

  // The live half: this checkout's own diff, held to the same scoped rule.
  const branch = currentBranch()
  if (branch === null) {
    t.skip('this checkout is not on a branch, so there is no diff to judge')
    return
  }
  // `GITHUB_BASE_SHA` is the pull request's own base when a runner exports it;
  // `origin/main` is the same thing in a normal checkout. Neither is a standing
  // ban: `gateEdits` decides, and it only fires for the two shapes above.
  const touched = changedPaths(process.env.GITHUB_BASE_SHA ?? 'origin/main')
  if (touched === null) {
    t.skip('this checkout has no merge base against origin/main (one-commit CI checkout)')
    return
  }
  assert.deepEqual(gateEdits(touched, branch), [], 'the release workflow may not edit the gate that judges its pull request')
})

test('the tag write is the two API calls on the merge commit and nothing else', () => {
  const step = between('      - name: Create the annotated tag on the merge commit', '      - name: Dispatch release.yml at the tag')
  assert.match(step, /gh api --method POST "repos\/\$\{GITHUB_REPOSITORY\}\/git\/tags"/)
  assert.match(step, /gh api --method POST "repos\/\$\{GITHUB_REPOSITORY\}\/git\/refs"/)
  assert.equal([...step.matchAll(/gh api --method POST/g)].length, 2, 'two writes: the tag object and its ref')
  assert.equal(step.includes('git push'), false)
  assert.match(step, /-f object="\$SHA"/)
})

test('tags are listed through the API in both jobs, so no local tag listing exists', () => {
  assert.match(job('release'), /git\/matching-refs\/tags\/v/)
  assert.match(job('tag'), /git\/matching-refs\/tags\/v/)
  assert.equal(/git describe/.test(daily), false, 'the last tag comes from the API, not from the local tag store')
})

test('the publish run is dispatched at the tag, and the comment goes to issue 80 by number', () => {
  assert.equal([...daily.matchAll(/gh workflow run release\.yml /g)].length, 1)
  assert.match(job('tag'), /gh workflow run release\.yml --ref "\$TAG" -f "tag=\$TAG"/)
  assert.equal([...daily.matchAll(/gh issue comment 80 /g)].length, 1)
})

test('a dry run writes the summary and the artifact, and pushes and comments nothing', () => {
  const pushStep = between('      - name: Push the release branch', '      - name: Write the plan artifact')
  assert.match(pushStep, /if: \$\{\{ inputs\.dry_run != true && steps\.trigger\.outputs\.plan == 'true' && steps\.opener\.outputs\.ready == 'true' \}\}/)
  const openStep = between('      - name: Open the release pull request', '      - name: Comment on #80')
  assert.match(openStep, /if: \$\{\{ inputs\.dry_run != true && steps\.push\.outputs\.pushed != '' \}\}/)
  const commentStep = between('      - name: Comment on #80', '      - name: Keep the plan artifact')
  assert.match(commentStep, /if: \$\{\{ always\(\) && inputs\.dry_run != true \}\}/)
  const artifactStep = between('      - name: Write the plan artifact', '      - name: Open the release pull request')
  assert.equal(artifactStep.includes('dry_run'), false, 'the artifact is written on every run')
  assert.match(daily, /name: release-plan/)
})

test('the nightly run opens the release pull request with the team token', () => {
  const step = between('      - name: Open the release pull request', '      - name: Comment on #80')
  assert.match(step, /node scripts\/release-open\.mjs --artifact release-plan\.json --version "\$VERSION" --sha "\$PUSHED"/)
  assert.match(step, /GITHUB_TOKEN: \$\{\{ secrets\.RELEASE_OPEN_TOKEN \}\}/)
  assert.equal(/release-open\.mjs[^\n]*GITHUB_TOKEN/.test(step), false, 'the token is read from the environment, never passed in an argument')
})

// #333: a missing opener credential used to be `STATE=blocked` and exit 0, after
// the branch had already been pushed. That green night is what orphaned
// `release/v0.3.2`, so the credential is now a precondition that fails before
// anything is pushed and the author's runtime check can never be reached.
test('a missing opener token is a red precondition before the push, not a green blocked night', () => {
  const precondition = daily.indexOf('- name: Check the opener precondition')
  assert.notEqual(precondition, -1, 'a step checks the opener precondition')
  assert.ok(precondition < daily.indexOf('- name: Push the release branch'), 'the precondition is a step ordered before the push, so nothing is pushed when it fails')
  const step = between('      - name: Check the opener precondition', '      - name: Push the release branch')
  assert.match(step, /secrets\.RELEASE_OPEN_TOKEN/, 'it reads the same secret the opener uses')
  assert.match(step, /::error::/, 'a refused precondition is red')
  assert.match(step, /exit 1/)
  assert.ok(daily.indexOf('- name: Write the plan artifact') < daily.indexOf('- name: Open the release pull request'), 'the opener reads the artifact, so it is written first')
  assert.match(between('      - name: Write the plan artifact', '      - name: Open the release pull request'), /if: \$\{\{ always\(\) \}\}/)
  const openStep = between('      - name: Open the release pull request', '      - name: Comment on #80')
  assert.equal(openStep.includes('STATE=blocked'), false, 'the blocked-green state is gone, not merely unused')
})

test('the Decide snippet itself turns the orphan reason into a red run', () => {
  // The drive returns `report-blocked`; nothing asserted that the snippet in the
  // workflow reads it as a red state rather than leaving a green night with the
  // reason in a log line (#333 review). The reason carries branch and sha, so
  // writing it into the summary is what names them.
  const step = between('      - name: Decide', '      - name: Check the opener precondition')
  assert.match(step, /decision\.action === "report-blocked"/)
  assert.match(step, /startsWith\("orphan-branch"\)/)
  assert.match(step, /STATE=orphan-branch/, 'the summary names the state')
  assert.match(step, /\$\{decision\.reason\}/, 'the summary carries the reason, so branch and sha are named')
  assert.match(step, /::error::/, 'the annotation makes the failure visible in the run UI')
  assert.match(step, /process\.exitCode = 1/, 'the step exits red, not green')
})

test('the #80 comment carries the open state, and still posts after a refusal', () => {
  const step = between('      - name: Comment on #80', '      - name: Keep the plan artifact')
  assert.match(step, /OPEN_STATE: \$\{\{ steps\.open\.outputs\.state \}\}/)
  assert.match(step, /OPEN_DETAIL: \$\{\{ steps\.open\.outputs\.detail \}\}/)
  assert.match(step, /daily-release:v\$\{PLAN_NEXT\}:\$\{PUSHED\}:\$\{OPEN_STATE\}/, 'the marker carries the open state, so a blocked night that later opens says so once')
  assert.match(step, /release pull request: \*\*\$\{OPEN_STATE\}\*\*/)
})

test('the comment is posted only when the pushed sha or the plan changed', () => {
  const commentStep = between('      - name: Comment on #80', '      - name: Keep the plan artifact')
  assert.match(commentStep, /issues\/80\/comments/)
  assert.match(commentStep, /daily-release:v/)
  assert.match(commentStep, /already commented/)
})

test('the mechanical release branch push is idempotent and never forced', () => {
  const pushStep = between('      - name: Push the release branch', '      - name: Write the plan artifact')
  assert.match(pushStep, /already pushed/)
  assert.equal(/--force/.test(pushStep), false)
  assert.ok(pushStep.includes('git push origin "$BRANCH"'))
})

test('the planner and the state projection are still the tested modules', () => {
  assert.match(daily, /import \{ plannerInput \} from "\.\/scripts\/lib\/release-state\.mjs"/)
  assert.match(daily, /import \{ planRelease \} from "\.\/scripts\/release-plan\.mjs"/)
  // #864: the step calls the drive's bounded retry, whose decision table —
  // including `decideDrive` itself — is executed by `test/releaseCiOk.test.ts`
  // and `test/mechanicalRelease.test.ts` rather than grepped out of the YAML.
  assert.match(daily, /import \{ decideWithCiRetry \} from "\.\/scripts\/lib\/release-drive\.mjs"/)
  assert.match(readFileSync('scripts/lib/release-state.mjs', 'utf8'), /labels: \(Array\.isArray\(pr\?\.labels\) \? pr\.labels : \[\]\)\.map\(\(label\) => String\(label\?\.name/)
})

test('#881: the planner is given the slot boundary, not the runner clock', () => {
  // The week that decides minor-vs-patch, and the slot the tag is judged
  // against, must both be the scheduled 02:00Z slot. `new Date()` made them the
  // runner's instant, which on a host 28 minutes ahead (#758) is the previous
  // day's slot and can release the same slot twice.
  const planStep = between('      - name: Plan', '      - name: Decide')
  assert.match(planStep, /releaseAt: latestBoundary\(/, 'releaseAt is derived from the slot boundary')
  assert.match(planStep, /import \{ latestBoundary \} from "\.\/scripts\/lib\/release-trigger\.mjs"/, 'the boundary is the tested module, not a literal in the YAML')
  assert.doesNotMatch(planStep, /releaseAt: new Date\(\)\.toISOString\(\)/, 'the runner clock may not decide the slot or the week')
})

test('the state job names the ci-ok check in the request, so a busy tip cannot page it away', () => {
  // #567: `GET /commits/{sha}/check-runs?per_page=100` returns the newest 100
  // runs and `ci-ok` sits behind four comment-triggered runs per comment, so a
  // tip with more than ~25 comments reports `missing` for a green run. Asking
  // for the name is the fix; `checkRunsOf` already accepts the single-object
  // answer. The query literal keeps `per_page=100`, so the assertion is on the
  // parameter, not on `check-runs?check_name=`.
  const fetchLine = daily.split('\n').find((line) => line.includes('/commits/main/check-runs'))
  assert.ok(fetchLine, 'the workflow fetches check runs for the main tip')
  assert.match(fetchLine, /check_name=ci-ok/, 'the check-runs request names ci-ok instead of trusting the first page')
})

test('the decide step re-reads ci-ok at the tip the plan was made from', () => {
  // #864: the drive read `ci-ok` once, so a run that started while CI was still
  // in flight reported `missing` and never released. The step now calls the
  // tested bounded retry, and every re-read asks for the *same* tip the plan was
  // computed from — polling `commits/main` could judge a commit the release
  // branch was never cut from.
  const step = between('      - name: Decide', '      - name: Trigger')
  assert.match(step, /import \{ decideWithCiRetry \} from "\.\/scripts\/lib\/release-drive\.mjs"/)
  assert.match(step, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/, 'the re-read calls the checks API, so the step needs the token')
  assert.match(step, /MAIN_SHA: \$\{\{ steps\.state\.outputs\.main_sha \}\}/, 'the re-read is pinned to the tip the plan was made from')
  assert.match(step, /commits\/\$\{MAIN_SHA\}\/check-runs\?per_page=100&check_name=ci-ok/, 'the re-read asks for the same named check as the first read')
  assert.match(step, /latestConclusion\(/, 'the re-read parses the answer with the tested helper')
  assert.ok(step.includes('setTimeout'), 'the wait between reads is a real sleep, not a busy loop')
})

test('the decide step can wait out the ci-ok bound without the job killing it', () => {
  // #864: the retry is at most three reads five minutes apart, so ~10 minutes of
  // sleeping. The step and the job timeouts must both leave room for the waits,
  // or the fix would trade a missed release for a cancelled run.
  const jobText = job('release')
  const jobMinutes = /timeout-minutes: (\d+)/.exec(jobText)
  assert.notEqual(jobMinutes, null, 'the release job states its timeout')
  assert.ok(Number(jobMinutes?.[1] ?? '0') >= 30, 'the job budget covers the ci-ok re-read window plus the push, opener and comment steps')
  const step = between('      - name: Decide', '      - name: Trigger')
  const stepMinutes = /timeout-minutes: (\d+)/.exec(step)
  assert.notEqual(stepMinutes, null, 'the decide step states its own timeout')
  assert.ok(Number(stepMinutes?.[1] ?? '0') >= 15, 'the decide step budget covers three reads five minutes apart')
})

test('the run writes the counts and the decision to the job summary', () => {
  assert.match(daily, /GITHUB_STEP_SUMMARY/)
  assert.match(daily, /merged PRs since/)
  assert.match(daily, /features:/)
  assert.match(daily, /fragments:/)
})

test('the workflow never deploys and never touches a live database', () => {
  for (const forbidden of ['ssh ', 'systemctl', 'watchtower', 'docker compose up', 'deploy.sh', 'fly deploy']) {
    assert.equal(daily.includes(forbidden), false, forbidden)
  }
})

test('every action in the workflow is pinned to a full commit sha', () => {
  const uses = [...daily.matchAll(/uses: ([^\s#]+)/g)].map((match) => String(match[1]))
  assert.ok(uses.length >= 4)
  for (const use of uses) assert.match(use, /@[0-9a-f]{40}$/, use)
})

test('no expression reaches a shell body anywhere in the workflow', () => {
  const steps = daily.split(/^\s+- name: /m).slice(1)
  assert.ok(steps.length >= 9)
  for (const step of steps) {
    const runIndex = step.indexOf('        run: |')
    if (runIndex === -1) continue
    const name = step.split('\n')[0] ?? ''
    const body = step.slice(runIndex).split(/\n      - /)[0] ?? ''
    assert.equal(body.includes('${{'), false, `step "${name}" splices an expression into its run body`)
  }
})

test('the surface this branch adds is declared, and the workflow runs no other release module', () => {
  for (const path of [...allowedScripts, ...allowedTests]) {
    assert.ok(existsSync(path), `${path} exists on this branch`)
  }
  // The workflow may run the tested release machinery and nothing else. A driver
  // growing back into the release path shows up here as an import.
  const machinery = new Set([
    'scripts/lib/release-drive.mjs',
    // #909: the one rule that reads the GitHub Release state, shared with
    // release.yml; its table is test/releaseLookup.test.ts and both step bodies.
    'scripts/lib/release-lookup.mjs',
    'scripts/lib/release-state.mjs',
    'scripts/lib/release-tag.mjs',
    'scripts/lib/release-trigger.mjs',
    'scripts/release-plan.mjs',
  ])
  const imports = [...daily.matchAll(/from "\.\/(scripts\/[^"]+)"/g)].map((match) => String(match[1]))
  assert.ok(imports.length >= 3, 'the workflow imports the tested modules')
  for (const path of imports) assert.ok(machinery.has(path), `${path} is not the tested release machinery`)

  // Locally the branch's own diff is readable, so the release branch's additions
  // are held to the two lists. The CI checkout is one commit deep, where
  // `origin/main` has no merge base to diff against; the import check above is the
  // half that always runs, and a false red on a T3 costs a review cycle it does
  // not buy anything for. The decision itself is `addedReleaseEntries`, which the
  // test below drives for both branch shapes.
  let added: string[] | null = null
  let branch = 'HEAD'
  try {
    added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'origin/main...HEAD'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    added = null
  }
  if (added !== null) {
    const { scripts, tests } = addedReleaseEntries(added, branch)
    for (const path of scripts) assert.ok(false, `${path} is a new release script; add it to allowedScripts`)
    for (const path of tests) assert.ok(false, `${path} is a new release test; add it to allowedTests`)
  }
})

test('release.yml is not folded into this change and knows nothing about the tag write', () => {
  assert.equal(/git\/tags/.test(release), false)
  assert.equal(/git\/refs/.test(release), false)
  // #648 renamed this step and added the provenance read beside the ancestor
  // check; the write stays in the tag job, so the two prohibitions above hold.
  assert.match(release, /- name: Verify the tag's provenance/)
})

test('an added test or script is held to the release lists only on a release branch', () => {
  const added = ['test/anything.test.ts', 'scripts/anything.mjs']
  assert.deepEqual(addedReleaseEntries(added, 'main'), { tests: [], scripts: [] }, 'main may add a test or a script for its own change')
  assert.deepEqual(addedReleaseEntries(added, 'dev3/225-daily-release-guard'), { tests: [], scripts: [] }, 'a working branch may add a test or a script')
  assert.deepEqual(
    addedReleaseEntries(added, 'release/v0.3.0'),
    { tests: ['test/anything.test.ts'], scripts: ['scripts/anything.mjs'] },
    'the release branch still cannot grow a second test file or a second release script',
  )
  const declared = ['test/releaseTag.test.ts', 'scripts/lib/release-tag.mjs']
  assert.deepEqual(addedReleaseEntries(declared, 'release/v0.3.0'), { tests: [], scripts: [] }, 'the declared entries are allowed on the release branch')
  assert.deepEqual(addedReleaseEntries(['docs/readme.md', 'src/app.ts'], 'release/v0.3.0'), { tests: [], scripts: [] }, 'other paths are not release entries')
})

test('release.yml keeps its own concurrency and verifies the tag before publishing', () => {
  assert.match(release, /concurrency:\s*\n\s*group: release-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/)
  assert.match(release, /git merge-base --is-ancestor "refs\/tags\/\$\{RELEASE_TAG\}" origin\/main/)
  assert.match(release, /tag:\s*\n\s*description:/)
  assert.match(release, /gh release create "\$RELEASE_TAG"/)
})

test('the scheduled slot resolves the release merge instead of the tip', () => {
  // #866: on `schedule` $GITHUB_SHA is main's tip, and the identity check needs
  // the release pull request's squash commit. A later merge makes those differ,
  // so the scheduled repair never reached the half-made release. The collect step
  // resolves the target through the tested helper and publishes it as an output,
  // and the decision is made about that target — not about the tip.
  const collect = between('      - name: Collect the pushed commit', '      - name: Decide the tag')
  assert.match(collect, /id: collect/, 'the collected sha is an output the decide step reads')
  assert.match(collect, /import \{ resolveTarget \} from "\.\/scripts\/lib\/release-tag\.mjs"/, 'the scheduled target is a tested pure decision, not assembled in shell')
  assert.match(collect, /gh pr list[^\n]*--state merged/, 'the merged release pull request is what names the target')
  assert.match(collect, /sha=\$\{TARGET\}/, 'the resolved target is published as the step output')
  const decide = between('      - name: Decide the tag', '      - name: Create the annotated tag')
  assert.match(decide, /SHA: \$\{\{ steps\.collect\.outputs\.sha \}\}/, 'the decision is made about the resolved target')
  assert.equal(decide.includes('github.sha'), false, 'the decide step no longer judges the tip on a scheduled run')
})


// #909: the collect step and release.yml's guard read one fact — does this tag
// already have a GitHub Release? — and the exit status alone cannot tell a 404
// ("not made yet") from a 403 or a 5xx ("I could not read it"). The step used to
// grep `gh`'s message for `HTTP 404`; both steps now classify through one tested
// rule, and these tests drive the real collect body against the same table the
// guard is driven against, so the two cannot drift.

function collectBody(): string {
  const block = between('      - name: Collect the pushed commit', '      - name: Decide the tag')
  const marker = '        run: |\n'
  const start = block.indexOf(marker)
  assert.notEqual(start, -1, 'the collect step has a run body')
  const body: string[] = []
  for (const line of block.slice(start + marker.length).split('\n')) {
    if (line !== '' && !line.startsWith('          ')) break
    body.push(line.startsWith('          ') ? line.slice(10) : line)
  }
  return body.join('\n')
}

function guardBody(): string {
  const start = release.indexOf('      - name: Stop when the release already exists')
  assert.notEqual(start, -1, 'release.yml has the guard step')
  const block = release.slice(start)
  const marker = '        run: |\n'
  const at = block.indexOf(marker)
  assert.notEqual(at, -1, 'the guard step has a run body')
  const body: string[] = []
  for (const line of block.slice(at + marker.length).split('\n')) {
    if (line !== '' && !line.startsWith('          ')) break
    body.push(line.startsWith('          ') ? line.slice(10) : line)
  }
  return body.join('\n')
}

interface LookupAnswer {
  exit: number
  stderr: string
}

interface BodyRun {
  status: number | null
  stdout: string
  output: string
  releaseJson: string
  summary: string
}

// The stub answers every `gh` call the collect body makes: the release lookup is
// the answer under test, and the rest are the payloads of a run that gets as far
// as the lookup.
function runCollect(answer: LookupAnswer): BodyRun {
  const dir = mkdtempSync(join(tmpdir(), 'collect-release-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const stub = [
      '#!/usr/bin/env bash',
      'case "$*" in',
      '  *releases/tags/*)',
      '    if [ "$STUB_EXIT" = "0" ]; then printf \'{"tag_name":"v0.3.2"}\\n\'; exit 0; fi',
      '    printf "%s\\n" "$STUB_STDERR" >&2',
      '    exit "$STUB_EXIT"',
      '    ;;',
      '  *contents/package.json*) printf "%s\\n" "$STUB_PACKAGE" ;;',
      '  *) printf "[]\\n" ;;',
      'esac',
      '',
    ].join('\n')
    const ghPath = join(bin, 'gh')
    writeFileSync(ghPath, stub)
    chmodSync(ghPath, 0o755)
    const output = join(dir, 'output')
    const summary = join(dir, 'summary.md')
    writeFileSync(output, '')
    writeFileSync(summary, '')
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', collectBody()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_REPOSITORY: 'HugoXK/fledge',
        GITHUB_SHA: '8213cec5035f7abb9764c9449ecf074a7f1a9cdd',
        GITHUB_EVENT_NAME: 'push',
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        STUB_EXIT: String(answer.exit),
        STUB_STDERR: answer.stderr,
        STUB_PACKAGE: Buffer.from('{"version":"0.3.2"}').toString('base64'),
      },
    })
    const releasePath = join(dir, 'release.json')
    return {
      status: result.status,
      stdout: result.stdout,
      output: readFileSync(output, 'utf8'),
      releaseJson: existsSync(releasePath) ? readFileSync(releasePath, 'utf8') : '',
      summary: readFileSync(summary, 'utf8'),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function guardAnswer(answer: LookupAnswer): 'present' | 'absent' | 'refused' {
  const dir = mkdtempSync(join(tmpdir(), 'guard-release-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const stub = ['#!/usr/bin/env bash', 'printf "%s\\n" "$STUB_STDERR" >&2', `exit ${String(answer.exit)}`, ''].join('\n')
    const ghPath = join(bin, 'gh')
    writeFileSync(ghPath, stub)
    chmodSync(ghPath, 0o755)
    const output = join(dir, 'output')
    const summary = join(dir, 'summary.md')
    writeFileSync(output, '')
    writeFileSync(summary, '')
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', guardBody()], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_REPOSITORY: 'HugoXK/fledge',
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        STUB_STDERR: answer.stderr,
        RELEASE_TAG: 'v0.3.2',
      },
    })
    if (result.status !== 0) return 'refused'
    const published = readFileSync(output, 'utf8')
    if (/^published=true$/m.test(published)) return 'present'
    assert.match(published, /^published=false$/m, 'a successful guard answers exactly one of the two gates')
    return 'absent'
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the collect step records a 404 as absence and nothing else as absence', () => {
  const absent = runCollect({ exit: 1, stderr: 'gh: Not Found (HTTP 404)' })
  assert.equal(absent.status, 0, 'a 404 is the normal "not released yet" answer')
  assert.deepEqual(JSON.parse(absent.releaseJson), {}, 'the absent fact is recorded as an empty release')
  assert.match(absent.summary, /no GitHub Release/, 'the summary names the absence')
  assert.match(absent.output, /sha=/, 'the target is still published for the decide step')

  const present = runCollect({ exit: 0, stderr: '' })
  assert.equal(present.status, 0, 'a present release is a normal answer too')
  assert.equal(JSON.parse(present.releaseJson).tag_name, 'v0.3.2', 'the release payload is what the decision reads')

  for (const stderr of [
    'gh: Resource not accessible by integration (HTTP 403)',
    'gh: Server Error (HTTP 502)',
    'dial tcp: i/o timeout',
    'gh: release not found',
  ]) {
    const unreadable = runCollect({ exit: 1, stderr })
    assert.notEqual(unreadable.status, 0, `${stderr}: the step fails`)
    assert.match(unreadable.stdout, /::error::/, `${stderr}: the failure is the single report`)
    assert.notEqual(unreadable.releaseJson.trim(), '{}', `${stderr}: only a 404 is recorded as an absent release`)
  }
})

test('the guard and the collect step agree on every answer of the table', () => {
  // One table, both step bodies: present → published, 404 → not published,
  // anything else → refusal. If the two ever diverge, one of these rows goes red.
  const rows: Array<{ stderr: string; exit: number; expected: 'present' | 'absent' | 'refused' }> = [
    { stderr: '', exit: 0, expected: 'present' },
    { stderr: 'gh: Not Found (HTTP 404)', exit: 1, expected: 'absent' },
    { stderr: 'gh: Resource not accessible by integration (HTTP 403)', exit: 1, expected: 'refused' },
    { stderr: 'gh: Server Error (HTTP 502)', exit: 1, expected: 'refused' },
    { stderr: 'dial tcp: i/o timeout', exit: 1, expected: 'refused' },
  ]
  for (const row of rows) {
    assert.equal(guardAnswer(row), row.expected, `release.yml guard: ${row.stderr || `exit ${String(row.exit)}`}`)
    const collect = runCollect(row)
    const answer = collect.status === 0 ? (JSON.parse(collect.releaseJson).tag_name === undefined ? 'absent' : 'present') : 'refused'
    assert.equal(answer, row.expected, `daily-release.yml collect: ${row.stderr || `exit ${String(row.exit)}`}`)
  }
})
