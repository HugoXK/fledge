import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { classifyAlias, ALIAS_CREATE, ALIAS_REFUSE, ALIAS_SAME } from '../scripts/lib/release-alias.mjs'

// #883: the release chain is closed on the publish side. There is no runner in
// this suite, so the workflow is read the way a reviewer reads it — every gate
// below is a step that must exist, in order, and be wired to the digest this run
// published. The alias rule underneath is executed directly: it is the one part
// that decides whether a published name may move, and prose cannot prove that.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const release = readFileSync(`${repoRoot}/.github/workflows/release.yml`, 'utf8')
const ci = readFileSync(`${repoRoot}/.github/workflows/ci.yml`, 'utf8')

interface Step {
  name: string
  body: string
}

function steps(workflow: string): Step[] {
  const start = workflow.indexOf('    steps:\n')
  assert.notEqual(start, -1, 'the workflow has a steps list')
  return workflow
    .slice(start + '    steps:\n'.length)
    .split(/\n      - /)
    .map((block, index) => (index === 0 ? block : `- ${block}`))
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const named = /^- name: (.+)$/m.exec(block)
      const uses = /uses: ([^\s#]+)/.exec(block)
      const run = /run: ([^\n]+)/.exec(block)
      return { name: (named?.[1] ?? uses?.[1] ?? run?.[1] ?? block.split('\n')[0] ?? '').trim(), body: block }
    })
}

const published = steps(release)

function step(name: string): Step {
  const found = published.find((candidate) => candidate.name === name)
  assert.ok(found !== undefined, `release.yml must declare the step "${name}"`)
  return found
}

function indexOfStep(name: string): number {
  const index = published.findIndex((candidate) => candidate.name === name)
  assert.notEqual(index, -1, `release.yml must declare the step "${name}"`)
  return index
}

const GATE = "${{ steps.guard.outputs.published != 'true' }}"

// Every step that writes or spends is gated on the guard, so a published tag
// that is dispatched a second time reaches none of them.
function assertGated(name: string): void {
  assert.match(step(name).body, new RegExp(`if: ${GATE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${name} must run only when this run publishes`)
}

test('the build publishes a commit-scoped tag, and the version tag is not pushed by the build', () => {
  const build = step('Build the image')
  assert.match(build.body, /IMMUTABLE="\$\{IMAGE\}:sha-\$\(git rev-parse --short=12 HEAD\)"/, 'the built image carries the commit it was cut from')
  assert.match(build.body, /-t "\$IMMUTABLE"/, 'the build tags the immutable name, not the version alias')
  assert.doesNotMatch(build.body, /-t "\$\{IMAGE\}:\$\{RELEASE_TAG\}"/, 'the mutable version tag is never what a build writes')
})

test('the published digest is scanned before anything names it', () => {
  const push = step('Publish the immutable image')
  assert.match(push.body, /id: push/)
  assert.match(push.body, /echo "digest=\$digest" >> "\$GITHUB_OUTPUT"/, 'the digest this run published must be the one later steps read')
  const scan = step('Scan the published digest')
  assert.match(scan.body, /image-ref: \$\{\{ env\.IMAGE \}\}@\$\{\{ steps\.push\.outputs\.digest \}\}/, 'the scan is of the pushed digest, not of a second image built beside it')
  assert.match(scan.body, /exit-code: '1'/, 'a finding must fail the job')
  assert.match(scan.body, /severity: 'HIGH,CRITICAL'/, 'the release scan uses the CI threshold, not a looser one')
  assert.ok(indexOfStep('Scan the published digest') < indexOfStep('Promote the digest to the version alias'), 'the alias is promoted only after the digest is scanned')

  // The CI scan is the same gate; a release that scanned a different image or a
  // different severity would pass where a pull request fails.
  const ciScan = /image-ref: fledge:ci\s*\n\s*format: table\s*\n\s*exit-code: '1'\s*\n\s*severity: 'HIGH,CRITICAL'/.test(ci)
  assert.ok(ciScan, 'ci.yml still pins the image scan this one mirrors')
})

test('the published digest is run and asserted on /healthz', () => {
  const smoke = step('Run the published image and assert /healthz')
  assert.match(smoke.body, /"\$\{IMAGE\}@\$\{DIGEST\}"/, 'the smoke test runs the digest, not a local tag')
  assert.match(smoke.body, /curl -fsS http:\/\/127\.0\.0\.1:18081\/healthz/, 'the check is the published image answering /healthz')
  assert.match(smoke.body, /exit 1/, 'a container that never answers fails the publish')
  assert.match(smoke.body, /ALLOW_TOKEN_LOGIN_ONLY=true/, 'the smoke container carries the documented no-OAuth configuration, not a real credential')
  assert.ok(indexOfStep('Run the published image and assert /healthz') < indexOfStep('Verify the release chain'), 'the smoke test runs before the chain is declared verified')
})

test('the SBOM describes the published digest and is attached to the release', () => {
  const sbom = step('Generate an SBOM for the published digest')
  assert.match(sbom.body, /image: \$\{\{ env\.IMAGE \}\}@\$\{\{ steps\.push\.outputs\.digest \}\}/, 'the SBOM reads the digest that was scanned and smoked')
  const upload = step('Attach the SBOM to the release')
  assert.match(upload.body, /gh release upload "\$RELEASE_TAG" sbom\.spdx\.json/, 'the SBOM is a release asset, not only an expiring Actions artifact')
  assert.ok(indexOfStep('Create the GitHub release') < indexOfStep('Attach the SBOM to the release'), 'the asset is attached to a release this run created')
  const notes = step('Record the published chain in the release notes')
  assert.match(notes.body, /releases\/download\/\$\{RELEASE_TAG\}\/sbom\.spdx\.json/, 'the body names the asset URL that the upload makes true')
})

test('the version tag is an alias that cannot be repointed', () => {
  const alias = step('Promote the digest to the version alias')
  assert.match(alias.body, /classifyAlias/, 'the decision is the tested rule in scripts/lib/release-alias.mjs, not an inline comparison')
  assert.match(alias.body, /docker tag "\$\{IMAGE\}@\$\{DIGEST\}" "\$alias_ref"/, 'the alias is created from the digest')
  assert.match(alias.body, /exit 1/, 'a different existing digest stops the publish')
  assert.doesNotMatch(step('Publish the immutable image').body, /docker push "\$\{IMAGE\}:\$\{RELEASE_TAG\}"/, 'nothing pushes the version tag directly')
})

test('the release chain is verified after the release exists and a failure fails the job', () => {
  const verify = step('Verify the release chain')
  assert.match(verify.body, /node scripts\/verify-release\.mjs --version "\$\{RELEASE_TAG#v\}"/, 'the verifier runs on the tag this job published')
  assert.match(verify.body, /set -euo pipefail/, 'a non-zero exit from the verifier must fail the step')
  assert.match(verify.body, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/, 'the verifier reads the API with the job token, not an unauthenticated call')
  assert.ok(indexOfStep('Create the GitHub release') < indexOfStep('Verify the release chain'), 'verification runs after the release is created')
})

test('every publish step that writes is gated on the guard', () => {
  for (const name of [
    'Build the image',
    'Publish the immutable image',
    'Scan the published digest',
    'Run the published image and assert /healthz',
    'Generate an SBOM for the published digest',
    'Attest the image provenance',
    'Promote the digest to the version alias',
    'Record the published chain in the release notes',
    'Create the GitHub release',
    'Attach the SBOM to the release',
    'Verify the release chain',
  ]) {
    assertGated(name)
  }
})

// The rule itself. `existing` carries the inspect message on a non-zero exit, so
// a registry outage and a missing tag are told apart by the message, never by
// the exit status alone.
const DIGEST = `sha256:${'a'.repeat(64)}`

test('an absent version alias may be created', () => {
  assert.equal(classifyAlias({ status: 1, existing: 'ERROR: ghcr.io/o/r:v1.0.0: not found', digest: DIGEST }).action, ALIAS_CREATE)
  assert.equal(classifyAlias({ status: 1, existing: 'manifest unknown', digest: DIGEST }).action, ALIAS_CREATE)
})

test('an alias that already names the digest is not written again', () => {
  assert.equal(classifyAlias({ status: 0, existing: DIGEST, digest: DIGEST }).action, ALIAS_SAME)
})

test('an alias that names another digest is refused', () => {
  const result = classifyAlias({ status: 0, existing: `sha256:${'b'.repeat(64)}`, digest: DIGEST })
  assert.equal(result.action, ALIAS_REFUSE)
  assert.match(result.reason, /repoint/)
})

test('an unreadable alias read is refused, never treated as absent', () => {
  const outage = classifyAlias({ status: 1, existing: 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: i/o timeout', digest: DIGEST })
  assert.equal(outage.action, ALIAS_REFUSE)
  assert.match(outage.reason, /unreadable/)
  const noDigest = classifyAlias({ status: 0, existing: DIGEST, digest: '' })
  assert.equal(noDigest.action, ALIAS_REFUSE)
})
