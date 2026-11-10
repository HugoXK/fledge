import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// The contract of issue #80, as a structural test: the file may carry no stored
// secret, no file-level permissions block, no pull-request or release command and
// no local tag command, and the tag write exists only as the two API calls. Every
// assertion here fails on the pre-#80 file, where `RELEASE_TOKEN` gated the run,
// the permissions block was file-level, and the tag came from
// `git tag`/`git push origin "$TAG"`.

const daily = readFileSync('.github/workflows/daily-release.yml', 'utf8')
const release = readFileSync('.github/workflows/release.yml', 'utf8')

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

test('the schedule is 22:30 Asia/Shanghai (14:30 UTC), a manual dispatch defaults to a dry run, and a merge to main is eligible', () => {
  assert.match(daily, /schedule:\s*\n\s*- cron: '30 14 \* \* \*'/)
  assert.match(daily, /workflow_dispatch:/)
  assert.match(daily, /dry_run:/)
  assert.match(daily, /default: true/)
  assert.match(daily, /push:\s*\n\s*branches: \[main\]/)
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

test('the automatic token is the only secret in the file', () => {
  const names = [...daily.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => String(match[1]))
  assert.ok(names.length > 0, 'the file uses the automatic token')
  for (const name of names) assert.equal(name, 'GITHUB_TOKEN', `secrets.${name} is not the automatic token`)
  assert.equal(daily.includes('RELEASE_TOKEN'), false, 'the stored token is gone, not merely unused')
  assert.equal(/token: \$\{\{/.test(daily), false, 'the checkout uses the default token')
})

test('each job states its own trigger, so an ordinary merge cannot plan, push or comment', () => {
  assert.match(job('release'), /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/)
  assert.match(job('tag'), /if: github\.event_name == 'push'/)
})

test('the file never opens, merges or releases a pull request, and never creates a tag with a git command', () => {
  for (const forbidden of ['gh pr create', 'gh pr merge', 'gh release', 'git tag', 'git push origin "$TAG"', 'git push --tags', '--admin']) {
    assert.equal(daily.includes(forbidden), false, `"${forbidden}" must not appear`)
  }
  const pushes = [...daily.matchAll(/git push /g)]
  assert.equal(pushes.length, 1, 'exactly one git push, of the release branch')
  assert.ok(daily.includes('git push origin "$BRANCH"'), 'that push is the release branch')
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
  const pushStep = between('      - name: Push the release branch', '      - name: Comment on #80')
  assert.match(pushStep, /if: \$\{\{ inputs\.dry_run != true \}\}/)
  const commentStep = between('      - name: Comment on #80', '      - name: Write the plan artifact')
  assert.match(commentStep, /if: \$\{\{ inputs\.dry_run != true \}\}/)
  const artifactStep = between('      - name: Write the plan artifact', '      - name: Keep the plan artifact')
  assert.equal(artifactStep.includes('dry_run'), false, 'the artifact is written on every run')
  assert.match(daily, /name: release-plan/)
})

test('the comment is posted only when the pushed sha or the plan changed', () => {
  const commentStep = between('      - name: Comment on #80', '      - name: Write the plan artifact')
  assert.match(commentStep, /issues\/80\/comments/)
  assert.match(commentStep, /daily-release:v/)
  assert.match(commentStep, /already commented/)
})

test('the mechanical release branch push is idempotent and never forced', () => {
  const pushStep = between('      - name: Push the release branch', '      - name: Comment on #80')
  assert.match(pushStep, /already pushed/)
  assert.equal(/--force/.test(pushStep), false)
  assert.ok(pushStep.includes('git push origin "$BRANCH"'))
})

test('the planner and the state projection are still the tested modules', () => {
  assert.match(daily, /import \{ plannerInput \} from "\.\/scripts\/lib\/release-state\.mjs"/)
  assert.match(daily, /import \{ planRelease \} from "\.\/scripts\/release-plan\.mjs"/)
  assert.match(daily, /import \{ decideDrive \} from "\.\/scripts\/lib\/release-drive\.mjs"/)
  assert.match(readFileSync('scripts/lib/release-state.mjs', 'utf8'), /labels: \(Array\.isArray\(pr\?\.labels\) \? pr\.labels : \[\]\)\.map\(\(label\) => String\(label\?\.name/)
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
  for (const path of [...allowedScripts, ...allowedTests]) {
    assert.ok(existsSync(path), `${path} exists on this branch`)
  }
  // The workflow may run the tested release machinery and nothing else. A driver
  // growing back into the release path shows up here as an import.
  const machinery = new Set([
    'scripts/lib/release-drive.mjs',
    'scripts/lib/release-state.mjs',
    'scripts/lib/release-tag.mjs',
    'scripts/release-plan.mjs',
  ])
  const imports = [...daily.matchAll(/from "\.\/(scripts\/[^"]+)"/g)].map((match) => String(match[1]))
  assert.ok(imports.length >= 3, 'the workflow imports the tested modules')
  for (const path of imports) assert.ok(machinery.has(path), `${path} is not the tested release machinery`)

  // Locally the branch's own diff is readable, so the two lists are held to it.
  // The CI checkout is one commit deep, where `origin/main` has no merge base to
  // diff against; the import check above is the half that always runs, and a
  // false red on a T3 costs a review cycle it does not buy anything for.
  let added: string[] | null = null
  try {
    added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'origin/main...HEAD'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  } catch {
    added = null
  }
  if (added !== null) {
    for (const path of added) {
      if (path.startsWith('scripts/')) assert.ok(allowedScripts.has(path), `${path} is a new release script; add it to allowedScripts`)
      if (path.startsWith('test/') && path.endsWith('.test.ts')) assert.ok(allowedTests.has(path), `${path} is a new release test; add it to allowedTests`)
    }
  }
})

test('release.yml is not folded into this change and knows nothing about the tag write', () => {
  assert.equal(/git\/tags/.test(release), false)
  assert.equal(/git\/refs/.test(release), false)
  assert.match(release, /Verify the tag is an ancestor of main/)
})

test('release.yml keeps its own concurrency and verifies the tag before publishing', () => {
  assert.match(release, /concurrency:\s*\n\s*group: release-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: false/)
  assert.match(release, /git merge-base --is-ancestor "refs\/tags\/\$\{RELEASE_TAG\}" origin\/main/)
  assert.match(release, /tag:\s*\n\s*description:/)
  assert.match(release, /gh release create "\$RELEASE_TAG"/)
})
