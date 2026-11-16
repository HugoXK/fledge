import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #861: the release path is the one workflow that holds `packages: write`,
// `contents: write`, `id-token: write` and `attestations: write` at the same
// time. It used to install dependencies in that same job, so a compromised
// dependency's `postinstall` could read the checkout's persisted token out of
// `.git/config` and publish an image under the project's name.
//
// This test is a structural read of `.github/workflows/release.yml`, which is
// the file a maintainer edits. It fails the three halves separately — persisted
// credential, install scripts, and the write scopes sharing a job with an
// install — so a revert of one does not hide behind the other two.
const release = readFileSync('.github/workflows/release.yml', 'utf8')

function job(name: string): string {
  const start = release.indexOf(`\n  ${name}:\n`)
  assert.notEqual(start, -1, `release.yml has a "${name}" job`)
  const rest = release.slice(start + 1)
  const next = /\n {2}[a-z][a-z0-9-]*:\n/.exec(rest.slice(1))
  return next === null ? rest : rest.slice(0, next.index + 2)
}

test('every checkout in the release workflow keeps no credential', () => {
  const starts = [...release.matchAll(/^ {6}- uses: actions\/checkout@[0-9a-f]{40} # v[0-9.]+$/gm)]
  assert.ok(starts.length > 0, 'release.yml checks out the tag')
  for (const match of starts) {
    const from = match.index
    const rest = release.slice(from + match[0].length)
    const nextStep = rest.search(/\n {6}- /)
    const step = nextStep === -1 ? rest : rest.slice(0, nextStep)
    assert.match(step, /^ {10}persist-credentials: false$/m, 'the checkout sets persist-credentials: false')
  }
})

test('no dependency install script runs anywhere in the release workflow', () => {
  const installs = [...release.matchAll(/^ {6}- run: npm (ci|install)\b(.*)$/gm)]
  assert.equal(installs.length, 1, 'release.yml installs the lockfile exactly once')
  const install = installs[0]
  assert.ok(install !== undefined, 'release.yml installs the lockfile exactly once')
  assert.match(install[2] ?? '', /^ --ignore-scripts$/, 'the one install passes --ignore-scripts')
  assert.equal(/npm (ci|install)(?![^\n]*--ignore-scripts)/.test(release), false, 'no install omits --ignore-scripts')
})

test('the job that installs holds no write scope and no OIDC identity', () => {
  const build = job('build')
  const permissions = /^ {4}permissions:\n((?: {6}[a-z-]+: [a-z]+\n)+)/m.exec(build)
  assert.notEqual(permissions, null, 'the build job declares its permissions')
  assert.deepEqual(
    permissions![1]!.trim().split('\n').map((line) => line.trim()),
    ['contents: read', 'pull-requests: read'],
    'the build job reads contents and pull requests and nothing else',
  )
  assert.equal(/^ {6}[a-z-]+: write$/m.test(build), false, 'the build job grants no write scope')
  assert.equal(/^ {6}id-token:/m.test(build), false, 'no OIDC identity while an install runs')
  assert.match(build, /^ {6}- run: npm run check$/m, 'the suite still runs against the tag')
})

test('the release job installs nothing and runs no repository code', () => {
  const releaseJob = job('release')
  assert.match(releaseJob, /^ {4}needs: build$/m, 'the release job waits for the build job')
  assert.equal(/\bnpm\b/.test(releaseJob), false, 'the release job invokes no package manager')
  assert.equal(releaseJob.includes('actions/checkout@'), false, 'the release job checks nothing out')
  assert.equal(releaseJob.includes('setup-node'), false, 'the release job sets up no runtime')

  const permissions = /^ {4}permissions:\n((?: {6}[a-z-]+: [a-z]+\n)+)/m.exec(releaseJob)
  assert.notEqual(permissions, null, 'the release job declares its permissions')
  assert.deepEqual(
    permissions![1]!.trim().split('\n').map((line) => line.trim()).sort(),
    ['attestations: write', 'contents: write', 'id-token: write', 'packages: write'],
    'the release job declares exactly the four publish scopes',
  )
})

test('the published digest is the one the build job produced', () => {
  const build = job('build')
  const releaseJob = job('release')
  assert.match(build, /docker save "\$\{IMAGE\}:\$\{RELEASE_TAG\}" \| gzip -1 > image\.tar\.gz/, 'the build job saves the image it built')
  assert.match(build, /name: release-image/, 'the image leaves the build job as an artifact')
  assert.match(releaseJob, /name: release-image/, 'the release job downloads that artifact')
  assert.match(releaseJob, /gunzip -c image\.tar\.gz \| docker load/, 'the release job loads the same image')
  assert.match(releaseJob, /docker push "\$\{IMAGE\}:\$\{RELEASE_TAG\}"/, 'the release job pushes it under the release tag')
  assert.match(releaseJob, /subject-digest: \$\{\{ steps\.push\.outputs\.digest \}\}/, 'the attestation signs the pushed digest')
})
