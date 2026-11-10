import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const daily = readFileSync('.github/workflows/daily-release.yml', 'utf8')
const release = readFileSync('.github/workflows/release.yml', 'utf8')

function stepNames(text: string): string[] {
  return [...text.matchAll(/^\s+- name: (.+)$/gm)].map((match) => String(match[1]))
}

test('the schedule is 22:30 Asia/Shanghai (14:30 UTC) and a manual dispatch defaults to a dry run', () => {
  assert.match(daily, /schedule:\s*\n\s*- cron: '30 14 \* \* \*'/)
  assert.match(daily, /workflow_dispatch:/)
  assert.match(daily, /dry_run:/)
  assert.match(daily, /default: true/)
})

test('the workflow has the permissions the drive needs and nothing more', () => {
  const permissions = daily.slice(daily.indexOf('permissions:'), daily.indexOf('concurrency:'))
  for (const scope of ['contents: write', 'pull-requests: write', 'actions: write', 'issues: read']) {
    assert.ok(permissions.includes(scope), scope)
  }
  assert.equal(permissions.includes('packages: write'), false)
  assert.equal(permissions.includes('deployments'), false)
})

test('it fails closed before anything when RELEASE_TOKEN is missing', () => {
  assert.match(daily, /Fail closed without RELEASE_TOKEN/)
  assert.match(daily, /missing-release-token/)
  const tokenStep = daily.indexOf('Fail closed without RELEASE_TOKEN')
  const checkout = daily.indexOf('actions/checkout@')
  assert.ok(tokenStep < checkout, 'the token check runs before the checkout')
})

test('the push and the PR use RELEASE_TOKEN, never GITHUB_TOKEN', () => {
  assert.match(daily, /token: \$\{\{ secrets\.RELEASE_TOKEN \}\}/)
  assert.match(daily, /GH_TOKEN: \$\{\{ secrets\.RELEASE_TOKEN \}\}/)
  assert.equal(/token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/.test(daily), false)
  assert.equal(/GITHUB_TOKEN \}\}/.test(daily), false)
})

test('an open release PR is enqueued with --match-head-commit and never with --admin', () => {
  assert.match(daily, /gh pr merge "\$RELEASE_PR" --auto --squash --match-head-commit "\$RELEASE_HEAD_SHA"/)
  assert.equal(/--admin/.test(daily), false)
  assert.equal(/--admin/.test(release), false)
})

test('the workflow never deploys and never touches a live database', () => {
  for (const forbidden of ['ssh ', 'systemctl', 'watchtower', 'docker compose up', 'deploy.sh', 'fly deploy']) {
    assert.equal(daily.includes(forbidden), false, forbidden)
  }
})

test('the merged PR labels are mapped to names, so the enhancement half can match', () => {
  // The mapping moved out of YAML into the tested projection, so it is executed
  // by a suite instead of being grepped: `plannerInput` reads `label.name`, which
  // is what `planRelease` matches `enhancement` against.
  assert.match(daily, /import \{ plannerInput \} from "\.\/scripts\/lib\/release-state\.mjs"/)
  assert.match(readFileSync('scripts/lib/release-state.mjs', 'utf8'), /labels: \(Array\.isArray\(pr\?\.labels\) \? pr\.labels : \[\]\)\.map\(\(label\) => String\(label\?\.name/)
})

test('the mechanical release PR is keyed on its branch and title in the gate that reads them', () => {
  assert.match(daily, /release\/v\$\{VERSION\}/)
  assert.match(daily, /gh pr create --base main --head "\$BRANCH" --title "release: v\$\{VERSION\}"/)
})

test('every action in the new workflow is pinned to a full commit sha', () => {
  const uses = [...daily.matchAll(/uses: ([^\s#]+)/g)].map((match) => String(match[1]))
  assert.ok(uses.length >= 2)
  for (const use of uses) assert.match(use, /@[0-9a-f]{40}$/, use)
})

test('the counts and the cross-check line go to the job summary', () => {
  assert.match(daily, /GITHUB_STEP_SUMMARY/)
  assert.match(daily, /merged PRs since/)
  assert.match(daily, /features:/)
  assert.match(daily, /fragments:/)
  assert.match(daily, /reason: \$\{\{ plan|decision\.reason/)
})

test('the blocked reason travels through env, never spliced into a run body', () => {
  const step = daily.slice(daily.indexOf('Report a blocked release PR'), daily.indexOf('- name: Open the mechanical release PR'))
  assert.match(step, /RELEASE_REASON: \$\{\{ steps\.decide\.outputs\.reason \}\}/)
  assert.match(step, /printf 'reason: %s\\n' "\$RELEASE_REASON"/)
  const runBody = step.slice(step.indexOf('run: |'))
  assert.equal(runBody.includes('${{'), false, 'no expression is interpolated into the shell body')
})

test('no expression reaches a shell body anywhere in the workflow', () => {
  // #146 review `5829820145` (non-blocking): six values were still interpolated
  // into `run:` bodies. They were numeric or regex-constrained, but `env:` is the
  // boundary the finding asked for, so every step now passes them that way.
  const steps = daily.split(/^\s+- name: /m).slice(1)
  assert.ok(steps.length >= 9)
  for (const step of steps) {
    const runIndex = step.indexOf('        run: |')
    if (runIndex === -1) continue
    const name = step.split('\n')[0]
    // A step body ends at the next list item, which may be a `- uses:` step with
    // no `name:` of its own.
    const body = step.slice(runIndex).split(/\n      - /)[0] ?? ''
    assert.equal(body.includes('${{'), false, `step "${name}" splices an expression into its run body`)
  }
})

test('the drive is told whether the open release PR comes from this repository', () => {
  assert.match(daily, /sameRepo: \(\$state\.openPr\.head\.repo\.full_name == \$state\.openPr\.base\.repo\.full_name\)/)
})

test('each action runs only under its own condition, so a no-release night opens nothing', () => {
  for (const action of ['open-pr', 'enqueue', 'report-blocked', 'tag']) {
    assert.match(daily, new RegExp(`if: \\$\\{\\{ steps\\.decide\\.outputs\\.action == '${action}' \\}\\}`), action)
  }
  const creates = [...daily.matchAll(/^ {10}gh pr create /gm)]
  assert.equal(creates.length, 1)
  const openStep = daily.slice(daily.indexOf("action == 'open-pr'"), daily.indexOf("action == 'tag'"))
  assert.ok(openStep.includes('gh pr create'), 'the only PR creation is inside the open-pr step')
})

test('release.yml keeps its own concurrency and refuses a tag that is not on main', () => {
  assert.match(release, /concurrency:\s*\n\s*group: release-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/)
  assert.match(release, /Verify the tag is an ancestor of main/)
  assert.match(release, /git merge-base --is-ancestor "refs\/tags\/\$\{RELEASE_TAG\}" origin\/main/)
})

test('release.yml still publishes on a tag or a dispatch and creates or edits the release', () => {
  assert.match(release, /tags: \['v\*'\]/)
  assert.match(release, /tag:\s*\n\s*description:/)
  assert.match(release, /gh release create "\$RELEASE_TAG"/)
  assert.match(release, /gh release edit "\$RELEASE_TAG"/)
  assert.ok(stepNames(release).includes('Verify the tag is an ancestor of main'))
})
