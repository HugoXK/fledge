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
