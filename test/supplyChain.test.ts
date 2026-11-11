import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanWorkflowText, parseAllowlist } from '../scripts/lib/workflow-injection.mjs'

// Supply-chain hardening, batch 2 (issue #169). Every gate below is wired into a
// workflow, so the test reads the workflow the way a reviewer does: a gate that
// is described in prose but absent from the YAML is the drift this file exists
// to catch. The two behavioural halves — the expression scanner and the
// allowlist parser — are exercised directly, with fixtures in memory.

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function read(relative: string): string {
  return readFileSync(join(repoRoot, relative), 'utf8')
}

function jobBlock(workflow: string, job: string): string {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${job}:`)
  assert.ok(start !== -1, `job ${job} must exist in the workflow`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^  [a-z][a-z0-9-]*:$/.test(line) || /^\S/.test(line)) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

const ci = read('.github/workflows/ci.yml')
const release = read('.github/workflows/release.yml')
const codeql = read('.github/workflows/codeql.yml')

// D8 — least privilege. A job that inherits the workflow set gets whatever the
// workflow grants, including a scope another job needed; a job-level block
// replaces the workflow set instead of merging with it, so this list is also
// what keeps a newly added job from silently gaining `id-token: write`.
test('every ci job declares its own permissions block', () => {
  // Everything after `jobs:` — a two-space key inside `on:` is a trigger, not a job.
  const jobsSection = ci.slice(ci.indexOf('\njobs:\n'))
  assert.ok(jobsSection.length > 0, 'ci.yml must have a jobs section')
  const jobs = [...jobsSection.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]!)
  assert.ok(jobs.length >= 14, `expected every ci job to be listed, found ${String(jobs.length)}`)
  for (const job of jobs) {
    assert.match(jobBlock(ci, job), /^    permissions:$/m, `${job} must declare its own permissions`)
  }
})

// D1 — the secret scan reads the commit range, not the checkout. A secret added
// and then deleted on a branch is invisible to a diff scan and gone from the
// head tree; only the commit range still holds it.
//
// The scanner is a checksum-pinned binary rather than `gitleaks/gitleaks-action`:
// that action is licence-gated and picks its own scan range, so a run could be
// green without having read the range this test insists on.
test('the secret scan runs gitleaks over the full history', () => {
  const block = jobBlock(ci, 'secret-scan')
  assert.match(block, /fetch-depth: 0/, 'a shallow checkout cannot see a secret that was committed and then deleted')
  assert.match(block, /GITLEAKS_VERSION: \d+\.\d+\.\d+/, 'the scanner version must be a pin in the workflow, not floating latest')
  assert.match(block, /sha256sum -c -/, 'a downloaded binary without a checksum check is an unpinned action with extra steps')
  assert.match(block, /--log-opts="\$range"/, 'the scan must be the commit range; a tree scan cannot see a deleted commit')
  assert.match(block, /--config \.gitleaks\.toml/, 'the allowlist must be the file in the repository, not the tool default')
  assert.doesNotMatch(block, /gitleaks\/gitleaks-action@/, 'that action is licence-gated and chooses its own range')
})

test('the gitleaks config carries no file-wide allowlist', () => {
  const config = read('.gitleaks.toml')
  assert.match(config, /^\[extend\]$/m)
  assert.match(config, /useDefault = true/)
  assert.doesNotMatch(config, /^\s*paths\s*=/m, 'a `paths` entry suppresses every finding in that file, including a real token pasted later')
  assert.doesNotMatch(config, /\[\[allowlists\]\]/, 'the repository currently has no literal that needs an exception')
})

// The whole-history scan (issue #250) reports one result that is not a secret: a
// synthetic fixture at `test/crypto.test.ts:32` in the initial commit, which #185
// removed from the tree while the commit that carries it stays in history. The
// exception is a gitleaks ignore fingerprint: one commit, one path, one rule, one
// line. That is narrower than a `paths` allowance in `.gitleaks.toml`, which would
// also hide a real token pasted into the same file tomorrow.
function ignoreEntries(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

function fingerprintProblems(text: string): string[] {
  const entries = ignoreEntries(text)
  const problems: string[] = []
  if (entries.length !== 1) problems.push(`expected exactly one fingerprint, found ${entries.length}`)
  for (const entry of entries) {
    const fields = entry.split(':')
    if (fields.length !== 4) {
      problems.push(`${entry}: a fingerprint is <commit>:<path>:<rule-id>:<line>, found ${fields.length} field(s)`)
      continue
    }
    const [commit, path, rule, line] = fields
    if (!/^[0-9a-f]{40}$/.test(commit ?? '')) problems.push(`${entry}: field 1 must be a 40-hex commit`)
    if (!path) problems.push(`${entry}: field 2 must name a path`)
    if (!rule) problems.push(`${entry}: field 3 must name a rule`)
    if (!/^\d+$/.test(line ?? '')) problems.push(`${entry}: field 4 must be a line number`)
  }
  return problems
}

test('the gitleaks ignore file names exactly one reviewed fingerprint', () => {
  const ignore = read('.gitleaksignore')
  assert.deepEqual(fingerprintProblems(ignore), [])
  assert.deepEqual(ignoreEntries(ignore), [
    '4d1e27decedc68d01b019d0434291b5f58e4b049:test/crypto.test.ts:generic-api-key:32',
  ], 'the one exception is the fixture in the initial commit, at the line gitleaks reports')
  // gitleaks reads `.gitleaksignore` from the source directory on its own. A
  // `--baseline-path` would replace a file every reviewer can diff with a report
  // generated outside the repository.
  const block = jobBlock(ci, 'secret-scan')
  assert.doesNotMatch(block, /--baseline-path/, 'the reviewed fingerprint file is the exception mechanism, not a generated baseline')
})

test('an ignore line that is wider than one reviewed result is refused', () => {
  const fingerprint = '4d1e27decedc68d01b019d0434291b5f58e4b049:test/crypto.test.ts:generic-api-key:32'
  const cases: Array<[string, string[]]> = [
    ['two entries', [`${fingerprint}`, `4d1e27decedc68d01b019d0434291b5f58e4b049:test/crypto.test.ts:generic-api-key:33`]],
    ['a path instead of a commit', ['test/crypto.test.ts']],
    ['a rule and a path with no commit', ['test/crypto.test.ts:generic-api-key:32']],
    ['a short commit', ['4d1e27de:test/crypto.test.ts:generic-api-key:32']],
    ['a missing line', ['4d1e27decedc68d01b019d0434291b5f58e4b049:test/crypto.test.ts:generic-api-key']],
    ['an empty file', []],
  ]
  for (const [name, lines] of cases) {
    const problems = fingerprintProblems(lines.join('\n'))
    assert.ok(problems.length > 0, `${name}: must be refused`)
  }
  // Comment lines are documentation, not exceptions, and do not count as entries.
  assert.deepEqual(fingerprintProblems(`# reviewed in #250\n${fingerprint}\n`), [])
})

// D2 — actionlint reads the workflow; the expression scanner reads the shell.
test('the workflow lint job runs actionlint and the injection checker', () => {
  const block = jobBlock(ci, 'workflow-lint')
  assert.match(block, /uses: raven-actions\/actionlint@[0-9a-f]{40} # v\d/)
  assert.match(block, /version: '1\.\d+\.\d+'/, "the action's default is `latest`, which is an unpinned download behind a pinned action")
  assert.match(block, /node scripts\/workflow-injection\.mjs/)
})

test('an expression inside a run block is a finding', () => {
  const text = [
    'jobs:',
    '  build:',
    '    steps:',
    '      - run: echo "${{ github.event.pull_request.title }}"',
  ].join('\n')
  assert.deepEqual(scanWorkflowText(text, 'fixture.yml'), [
    { file: 'fixture.yml', line: 4, expression: 'github.event.pull_request.title' },
  ])
})

test('a block scalar is scanned line by line, an env value is not a shell script', () => {
  const text = [
    'jobs:',
    '  build:',
    '    env:',
    '      TITLE: ${{ github.event.pull_request.title }}',
    '    steps:',
    '      - name: publish',
    '        run: |',
    '          set -eu',
    '          echo "${{ inputs.tag }}"',
  ].join('\n')
  assert.deepEqual(scanWorkflowText(text, 'fixture.yml'), [
    { file: 'fixture.yml', line: 9, expression: 'inputs.tag' },
  ])
})

test('a static run block has no findings', () => {
  const text = ['    steps:', '      - run: npm run check'].join('\n')
  assert.deepEqual(scanWorkflowText(text, 'fixture.yml'), [])
})

test('an allowlisted expression passes and a second, unlisted one still fails', () => {
  const allowlist = parseAllowlist(read('.github/agent/workflow-injection-allowlist.json'))
  const text = [
    '      - run: node script.mjs --pr "${{ github.event.pull_request.number }}"',
    '      - run: node script.mjs --title "${{ github.event.pull_request.title }}"',
  ].join('\n')
  assert.deepEqual(scanWorkflowText(text, 'fixture.yml', allowlist), [
    { file: 'fixture.yml', line: 2, expression: 'github.event.pull_request.title' },
  ])
})

test('the allowlist parser refuses an entry with no reason and a malformed file', () => {
  assert.throws(() => parseAllowlist('[{"expression":"inputs.tag"}]'), /reason/)
  assert.throws(() => parseAllowlist('{"expression":"inputs.tag"}'), /array/)
  assert.throws(() => parseAllowlist('not json'), /JSON/)
})

test('the real workflow tree has no un-allowlisted shell interpolation', () => {
  const allowlist = parseAllowlist(read('.github/agent/workflow-injection-allowlist.json'))
  const directory = join(repoRoot, '.github/workflows')
  for (const name of ['ci.yml', 'release.yml', 'codeql.yml', 'review-gate.yml', 'daily-release.yml']) {
    const findings = scanWorkflowText(readFileSync(join(directory, name), 'utf8'), name, allowlist)
    assert.deepEqual(findings, [], `${name} interpolates an expression into a shell script`)
  }
})

// D3 — the image scan is fail-closed and names its threshold.
test('the docker job scans the built image and fails on a high or critical result', () => {
  const block = jobBlock(ci, 'docker')
  assert.match(block, /uses: aquasecurity\/trivy-action@[0-9a-f]{40} # v\d/)
  assert.match(block, /exit-code: '1'/, 'a scan with exit-code 0 reports and does not gate')
  assert.match(block, /severity: 'HIGH,CRITICAL'/, 'the threshold must be stated, not implied by the tool default')
  assert.match(block, /ignore-unfixed: true/, 'an unfixable base-image finding must not be the only reason to pin the base image forever')
  assert.match(block, /trivyignores: \.trivyignore\.yaml/, 'an exception must be per entry with an expiry, so it is reviewable and it dies')
  assert.match(
    block,
    /skip-dirs: usr\/local\/lib\/node_modules\/npm/,
    "the npm CLI's vendored tree inside the base image cannot be patched from this repository; the exclusion is one directory and must stay stated",
  )
})

// D4 — the image is run, not only built.
test('the docker job runs the image and checks /healthz for the version', () => {
  const block = jobBlock(ci, 'docker')
  assert.match(block, /docker run -d --name fledge-smoke/, 'a built image that cannot start is not a green build')
  assert.match(block, /SESSION_SECRET=/, 'the smoke run needs a generated secret, never a committed one')
  assert.match(block, /DATA_DIR=/, 'the smoke run writes its SQLite file to a throwaway path')
  assert.match(
    block,
    /TOKEN_ENCRYPTION_KEY=/,
    'the image runs with NODE_ENV=production, so src/config.ts refuses to start without the key material',
  )
  assert.match(block, /METRICS_TOKEN=/, 'the production startup check refuses an unauthenticated /metrics since #127')
  assert.match(block, /ALLOW_TOKEN_LOGIN_ONLY=true/, 'a smoke run must not need a real OAuth app or token')
  assert.match(block, /\/healthz/, 'the readiness route is the assertion')
  assert.match(block, /version/, 'a /healthz answer without the version field is not the release surface')
  assert.match(block, /docker rm -f fledge-smoke/, 'the container must be removed even when the assertion fails')
})

// D5 — the whole graph, not only the runtime dependencies.
test('the audit job audits the full dependency graph as well as the runtime one', () => {
  const block = jobBlock(ci, 'audit')
  assert.match(block, /npm audit --omit=dev --audit-level=high/, 'the published runtime set keeps its own gate')
  assert.match(block, /^\s+- run: npm audit --audit-level=high$/m, 'the development and transitive set needs the same high-severity floor')
})

// D6 — a floor with a number, in the repository.
test('the coverage job enforces a recorded floor', () => {
  const script = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts['test:coverage']
  assert.ok(script !== undefined, 'package.json must carry the coverage command so the floor is a diff, not prose')
  const floor = /--test-coverage-lines=(\d+)/.exec(script)
  assert.ok(floor !== null, 'the coverage command must name a line threshold')
  assert.ok(Number(floor[1]) >= 84, `the floor may rise but not fall below the measured 84.59%, found ${String(floor[1])}`)
  assert.match(script, /--test-coverage-include=/, 'coverage of the tests themselves would inflate the number')
  assert.match(jobBlock(ci, 'coverage'), /run: npm run test:coverage/)
})

// D7 — provenance on the release image, and how to verify it.
test('the release job attests the image and generates an SBOM', () => {
  const block = jobBlock(release, 'release')
  assert.match(block, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d/)
  assert.match(block, /uses: anchore\/sbom-action@[0-9a-f]{40} # v\d/)
  assert.match(block, /subject-digest: \$\{\{ steps\.[a-z-]+\.outputs\.digest \}\}/, 'the attestation must name the digest that was pushed')
  assert.match(block, /id-token: write/, 'the OIDC token is what the attestation signs with')
  assert.match(block, /attestations: write/)
  assert.match(block, /^    env:\n      RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}$/m, 'the tag must be a job-level env; a step env is not visible to a step input')
  assert.match(block, /image: \$\{\{ env\.IMAGE \}\}:\$\{\{ env\.RELEASE_TAG \}\}/, 'the SBOM must name the pushed image, not an empty tag')
  assert.match(block, /artifact-name: fledge-sbom-\$\{\{ env\.RELEASE_TAG \}\}/, 'the SBOM artifact must name the release tag')
  assert.match(block, /contents: write/, 'a job-level block replaces the workflow set, so the release scopes must be repeated')
  assert.match(block, /packages: write/)
  assert.match(read('docs/deploy.md'), /gh attestation verify/, 'a provenance record nobody knows how to verify is a receipt, not evidence')
})

test('the codeql job keeps security-events: write at job level', () => {
  const block = jobBlock(codeql, 'analyze')
  assert.match(block, /security-events: write/)
  assert.doesNotMatch(
    codeql,
    /^  security-events: write$/m,
    'a workflow-level grant (two spaces) is inherited by every job added later',
  )
})

// D9 — the required set is recorded where a maintainer reads it, in the names
// the API reports, and the file says it is the record and not the gate.
test('the required-check record names every required context', () => {
  const record = read('.github/agent/required-checks.md')
  for (const name of ['ci-ok', 'review-gate', 'pr-lint', 'dependency-review', 'Analyze JavaScript/TypeScript', 'secret-scan', 'workflow-lint', 'coverage']) {
    assert.match(record, new RegExp(`\`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``), `${name} must be in the required-check record`)
  }
  assert.match(record, /not the gate/i, 'the record must say it is documentation, so nobody edits it expecting the check to change')
  assert.match(record, /strict/i, 'the up-to-date rule is conditional and the record has to say so')
})

test('the gates doc lists the new required jobs', () => {
  const doc = read('docs/autonomous-dev.md')
  for (const name of ['`secret-scan`', '`workflow-lint`', '`coverage`']) {
    assert.ok(doc.includes(name), `${name} must be in the ci-ok list in docs/autonomous-dev.md`)
  }
  assert.match(doc, /dependency-review/)
})
