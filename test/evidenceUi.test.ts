import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import {
  evidenceBranch,
  evidencePlan,
  evidenceSummary,
  parseEvidenceArgs,
  seedEvidenceFixture,
} from '../scripts/lib/evidenceUi.js'

test('the arguments name the issue, route, selector and defaults', () => {
  const parsed = parseEvidenceArgs(['--issue', '1230', '--path', '/admin/metrics', '--selector', '#sqlite-health'])
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.args.issue, 1230)
  assert.equal(parsed.args.base, 'origin/main')
  assert.equal(parsed.args.head, 'HEAD')
  assert.deepEqual(parsed.args.locales, ['en', 'zh'])
  assert.deepEqual(parsed.args.widths, [1280, 390])
  assert.deepEqual(parsed.args.open, [])
  assert.equal(parsed.args.push, false)
})

test('a missing or malformed argument is refused by name', () => {
  for (const argv of [
    [],
    ['--issue', '0', '--path', '/x', '--selector', '#x'],
    ['--issue', '1', '--path', 'x', '--selector', '#x'],
    ['--issue', '1', '--path', '/x', '--selector', ''],
    ['--issue', '1', '--path', '/x', '--selector', '#x', '--locales', 'en,fr'],
    ['--issue', '1', '--path', '/x', '--selector', '#x', '--widths', 'wide'],
    ['--issue', '1', '--path', '/x', '--selector', '#x', '--wat'],
  ]) {
    assert.equal(parseEvidenceArgs(argv).ok, false, argv.join(' '))
  }
})

test('the plan writes before and after for every locale and width', () => {
  const parsed = parseEvidenceArgs(['--issue', '1263', '--path', '/repos/x', '--selector', '#x', '--locales', 'zh', '--widths', '1280'])
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const plan = evidencePlan(parsed.args)
  assert.deepEqual(plan.map((item) => item.file), [
    'docs/images/1263/before-zh-1280.png',
    'docs/images/1263/after-zh-1280.png',
  ])
  assert.equal(evidenceBranch(1263), 'evidence/1263')
  assert.match(plan[0]?.rawUrl ?? '', /^https:\/\/raw\.githubusercontent\.com\/HugoXK\/fledge\/evidence\/1263\//)
})

test('the summary is a ready-to-paste evidence table', () => {
  const parsed = parseEvidenceArgs(['--issue', '7', '--path', '/x', '--selector', '#x'])
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const summary = evidenceSummary(parsed.args, evidencePlan(parsed.args))
  assert.match(summary, /## Evidence/)
  assert.match(summary, /#x/)
  assert.match(summary, /evidence\/7/)
})

test('the fixture seeds a repository, a live lease and a reaped attempt', () => {
  const store = new Store(':memory:')
  try {
    const fixture = seedEvidenceFixture(store)
    assert.equal(store.userByLogin('visual-matrix')?.role, 'superadmin')
    assert.ok(store.getRepo(fixture.repoId))
    const live = store.getJob(fixture.jobId)
    assert.equal(live?.status, 'running')
    assert.ok(live?.lease_until !== null)
    const reaped = store.getJob(fixture.reapedJobId)
    assert.equal(reaped?.status, 'failed')
    assert.equal(store.jobAttempts(fixture.reapedJobId)[0]?.status, 'reaped')
    assert.equal(fixture.path, `/repos/${fixture.repoId}`)
  } finally {
    store.close()
  }
})
