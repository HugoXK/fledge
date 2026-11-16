import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// The contract of issue #80, as a structural test: the file may carry no stored
// secret, no file-level permissions block, no pull-request creation or release
// command and no local tag command. Auto-merge is the one deliberate exception:
// it is enabled only on the mechanical release PR with a pinned head commit.
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
  assert.match(job('tag'), /if: github\.event_name == 'push'/)
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

test('the file never creates or releases a pull request with gh, and auto-merge is pinned to the mechanical PR', () => {
  for (const forbidden of ['gh pr create', 'gh release', 'git tag', 'git push origin "$TAG"', 'git push --tags', '--admin']) {
    assert.equal(daily.includes(forbidden), false, `"${forbidden}" must not appear`)
  }
  const pushes = [...daily.matchAll(/git push /g)]
  assert.equal(pushes.length, 1, 'exactly one git push, of the release branch')
  assert.ok(daily.includes('git push origin "$BRANCH"'), 'that push is the release branch')
  assert.match(daily, /gh pr merge "\$PR" --auto --squash --match-head-commit "\$PUSHED"/, 'auto-merge names the PR and pins its head commit')
  const step = between('      - name: Enable auto-merge on the release pull request', '      - name: Comment on #80')
  assert.match(step, /steps\.open\.outputs\.state == 'opened' \|\| steps\.open\.outputs\.state == 'reused'/)
  assert.doesNotMatch(step, /--admin/)
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
