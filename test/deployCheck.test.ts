import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSystemdUnit } from '../scripts/lib/systemdUnit.mjs'

// #882: `deploy-check` treated the systemd half as advice and wrote a gap when
// `systemd-analyze` was absent, which is the normal case on a GitHub runner. A
// broken unit sample could therefore merge with the gate green. The check is now
// a static parse (`scripts/lib/systemdUnit.mjs`) that runs anywhere: it reads the
// sections, the directive syntax, duplicate keys and the absolute paths, and it
// fails the job. These tests pin the parser on the real sample and on the broken
// shapes it must refuse; the workflow-shape test pins that the job runs it as a
// gate instead of the advisory `systemd-analyze` call it used to make.
const root = fileURLToPath(new URL('..', import.meta.url))
const cli = join(root, 'scripts/check-systemd-unit.mjs')
const unit = join(root, 'deploy/fledge.service')
const real = readFileSync(unit, 'utf8')

function runCli(file: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, file], { cwd: root, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('the static parser accepts deploy/fledge.service and says it was static', () => {
  const run = runCli('deploy/fledge.service')
  assert.equal(run.status, 0, `the shipped sample must parse; stderr: ${run.stderr}`)
  assert.match(run.stdout, /systemd: deploy\/fledge\.service parsed by the static unit parser/)
  // The summary has to say which of the two checks this is: the issue asks for
  // "real or gap", and a static parse is neither a gap nor a live systemd.
  assert.match(run.stdout, /static/, 'the line must not read like a live systemd-analyze run')
})

test('a unit without ExecStart fails the static parser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'systemd-unit-'))
  try {
    const broken = join(dir, 'fledge.service')
    writeFileSync(broken, real.replace('ExecStart=/usr/bin/node dist/index.js\n', ''))
    const run = runCli(broken)
    assert.equal(run.status, 1, 'a service with no ExecStart must fail the job, not pass as advice')
    assert.match(run.stderr, /ExecStart/, 'the failure must name the directive that is missing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the parser names a duplicate directive, a relative ExecStart and an unknown section', () => {
  assert.ok(
    parseSystemdUnit(real.replace('Restart=always\n', 'Restart=always\nRestart=always\n')).errors.some((error) =>
      error.includes('duplicate Restart'),
    ),
    'a repeated key is a typo systemd would silently resolve to the last value',
  )
  assert.ok(
    parseSystemdUnit(real.replace('ExecStart=/usr/bin/node dist/index.js', 'ExecStart=node dist/index.js')).errors.some(
      (error) => error.includes('ExecStart') && error.includes('absolute'),
    ),
    'a relative ExecStart cannot work under systemd',
  )
  assert.ok(
    parseSystemdUnit(real.replace('[Service]', '[Services]')).errors.some((error) => error.includes('unknown section')),
    'a misspelled section must fail rather than be ignored',
  )
  assert.ok(
    parseSystemdUnit(real.replace('WantedBy=multi-user.target', 'WantedBy=')).errors.some((error) =>
      error.includes('WantedBy'),
    ),
    'a unit with no install target is not installable',
  )
})

test('a directive before any section is refused', () => {
  const detached = parseSystemdUnit(`Description=no section\n${real}`)
  assert.ok(
    detached.errors.some((error) => error.includes('before any')),
    'systemd ignores a directive outside a section; the parser must not',
  )
})

test('deploy-check runs the contract that gates the systemd unit, not systemd-analyze', () => {
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
  const start = workflow.indexOf('\n  deploy-check:')
  assert.ok(start !== -1, 'ci.yml must declare deploy-check')
  const rest = workflow.slice(start + 1)
  const next = rest.search(/\n  [a-z][a-z0-9-]*:\n/)
  const block = next === -1 ? rest : rest.slice(0, next)
  assert.doesNotMatch(block, /systemd-analyze/, 'the advisory call is replaced by a gate that runs everywhere')
  const contract = readFileSync(join(root, 'scripts/check-deploy-samples.sh'), 'utf8')
  assert.match(contract, /scripts\/check-systemd-unit\.mjs/, 'the contract must run the static parser as a gate')
})
