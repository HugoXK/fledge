import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const deploy = readFileSync(new URL('deploy/fledge-deploy-tag.sh', root), 'utf8')
const verify = readFileSync(new URL('deploy/fledge-verify-release.sh', root), 'utf8')
const doc = readFileSync(new URL('docs/deploy.md', root), 'utf8')

for (const name of ['deploy/fledge-deploy-tag.sh', 'deploy/fledge-verify-release.sh']) {
  test(`${name} is valid POSIX shell`, () => {
    assert.doesNotThrow(() => execFileSync('sh', ['-n', fileURLToPath(new URL(name, root))], { stdio: 'pipe' }))
  })
}

test('the tag deployer only moves forward and never pushes or bypasses a gate', () => {
  assert.match(deploy, /sort -V/)
  assert.match(deploy, /at or ahead of/)
  assert.match(deploy, /flock -n/)
  assert.match(deploy, /healthz/)
  assert.match(deploy, /dist\.bak-/)
  assert.match(deploy, /fledge-verify-release\.sh/)
  assert.doesNotMatch(deploy, /git push/)
  assert.doesNotMatch(deploy, /--admin/)
  assert.doesNotMatch(deploy, /gh pr merge/)
})

test('the verifier writes a temporary status and never prints a token', () => {
  assert.match(verify, /--write "\$TMP"/)
  assert.match(verify, /mv "\$TMP" "\$STATUS"/)
  assert.match(verify, /FLEDGE_SECRETS_FILE/)
  assert.match(verify, /GITHUB_TOKEN/)
  assert.doesNotMatch(verify, /echo[^\n]*GITHUB_TOKEN/)
  assert.doesNotMatch(verify, /echo[^\n]*\$TOKEN/)
})

test('the deploy runbook names both tracked scripts and their cron cadence', () => {
  assert.match(doc, /fledge-deploy-tag\.sh/)
  assert.match(doc, /fledge-verify-release\.sh/)
  assert.match(doc, /\*\/10 \* \* \* \*/)
  assert.match(doc, /\*\/30 \* \* \* \*/)
})

// #658: a version string in /healthz is not proof of a rollout. Production
// answered 0.3.2 while the page and the asset directory were another tree, so
// the deploy has to be gated on the release artifact it built.
test('the deploy gates the rollout on the release it built, not on a version string', () => {
  assert.match(deploy, /scripts\/rollout-check\.mjs/)
  assert.match(deploy, /--release-dir "\$DEPLOY"/)
  assert.match(deploy, /--public-dir "\$APP\/public"/)
  assert.match(deploy, /rollout refused for \$TAG/)
  assert.match(deploy, /FLEDGE_ROLLOUT_URL/)
  // The old gate: read /healthz and shell out to grep for the version.
  assert.doesNotMatch(deploy, /grep -q "\\"version\\"/)
})

test('a red release-status snapshot is logged by name, not swallowed', () => {
  assert.match(deploy, /release-status: not released for \$TAG/)
  assert.doesNotMatch(deploy, /\[ -x "\$VERIFY" \] && "\$VERIFY"[^\n]*\|\| true/)
})

test('the runbook names the gate, its expected line and the skipped-restart drill', () => {
  assert.match(doc, /scripts\/rollout-check\.mjs/)
  assert.match(doc, /rollout-check: ok v0\.3\.5 commit/)
  assert.match(doc, /rollout-check: refused/)
  assert.match(doc, /--expect-css-sha256/)
  assert.match(doc, /59,354 bytes/)
})
