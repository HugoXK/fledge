import test from 'node:test'
import assert from 'node:assert/strict'
import {
  IMPLEMENTED_WORK_TYPES,
  WORK_TYPES,
  contractOf,
  isImplementedWorkType,
  isWorkType,
  missingWorkTypeEvidence,
  resolveWorkType,
  workTypeAllowsStage,
  workTypeForKind,
  workTypeLabel,
  workTypeMayAutoMerge,
  workTypeMayBranch,
  workTypePurpose,
} from '../src/lib/workTypes.js'
import { translator } from '../src/i18n.js'

test('the registry declares every work type the issue names', () => {
  assert.deepEqual([...WORK_TYPES], ['iterate', 'triage', 'dependency', 'security', 'docs', 'performance', 'accessibility', 'migration'])
  for (const type of WORK_TYPES) {
    const contract = contractOf(type)
    assert.equal(contract.type, type)
    assert.ok(contract.label[0] !== '' && contract.label[1] !== '', `${type} has a bilingual label`)
    assert.ok(contract.purpose[0] !== '' && contract.purpose[1] !== '', `${type} has a bilingual purpose`)
    // #529: the registry used to declare a per-type budget in USD, and nothing
    // metered it — the enforced per-job cap is the repository's `job_budget_cny`
    // at the jobs checkpoint. A contract field no code reads is a number the page
    // shows and nothing can bind, so the exact key set is pinned instead.
    assert.deepEqual(
      Object.keys(contract).sort(),
      ['autoMerge', 'branch', 'evidence', 'label', 'purpose', 'risk', 'stages', 'type'],
      `${type} declares only fields the platform enforces`,
    )
    assert.match(contract.risk, /^T[0-3]$/)
  }
})

test('only iterate may auto-merge, and only triage may not branch', () => {
  assert.equal(workTypeMayAutoMerge('iterate'), true)
  for (const type of ['triage', 'dependency', 'security', 'docs', 'performance', 'accessibility', 'migration'] as const) {
    assert.equal(workTypeMayAutoMerge(type), false, `${type} must not inherit iterate's eligibility`)
  }
  assert.equal(workTypeMayBranch('triage'), false)
  for (const type of ['iterate', 'dependency', 'security', 'docs', 'performance', 'accessibility', 'migration'] as const) {
    assert.equal(workTypeMayBranch(type), true, `${type} may open a branch`)
  }
})

test('an unknown work type is refused instead of defaulting to iterate', () => {
  for (const value of [undefined, null, '', 'research', 'Iterate', 42, {}, []]) {
    assert.equal(resolveWorkType(value), null, `${String(value)} is not a work type`)
    assert.equal(isWorkType(value), false)
    assert.equal(workTypeMayAutoMerge(value), false)
    assert.equal(workTypeMayBranch(value), false)
  }
})

test('a declared work type with no handler is refused exactly like an unknown one', () => {
  assert.deepEqual([...IMPLEMENTED_WORK_TYPES], ['iterate', 'triage'])
  assert.equal(isImplementedWorkType('iterate'), true)
  assert.equal(isImplementedWorkType('triage'), true)
  for (const type of ['dependency', 'security', 'docs', 'performance', 'accessibility', 'migration'] as const) {
    assert.equal(resolveWorkType(type)?.type, type, `${type} still has a contract`)
    assert.equal(isImplementedWorkType(type), false, `${type} has no handler in this build`)
  }
})

test('a work type fails closed when the evidence it names is absent', () => {
  assert.deepEqual(missingWorkTypeEvidence('iterate', null), ['scope', 'testRed', 'testGreen'])
  assert.deepEqual(missingWorkTypeEvidence('iterate', { scope: 's', testRed: 'r', testGreen: 'g' }), [])
  assert.deepEqual(missingWorkTypeEvidence('security', { testRed: 'r' }), ['testGreen', 'rollback'])
  assert.deepEqual(missingWorkTypeEvidence('docs', { checks: 'ci-ok green' }), [])
  assert.deepEqual(missingWorkTypeEvidence('docs', { checks: '   ' }), ['checks'], 'blank text is not evidence')
  assert.deepEqual(missingWorkTypeEvidence('triage', null), [], 'triage carries its board instead')
  // A work type the registry does not know cannot prove anything, so it fails
  // closed on the one key every change needs.
  assert.deepEqual(missingWorkTypeEvidence('research', null), ['scope'])
})

test('a work type only runs the stages it declares', () => {
  assert.equal(workTypeAllowsStage('triage', 'iterate'), false, 'triage may not write')
  assert.equal(workTypeAllowsStage('triage', 'review'), false)
  assert.equal(workTypeAllowsStage('docs', 'iterate'), true)
  assert.equal(workTypeAllowsStage('docs', 'verify'), false)
  assert.equal(workTypeAllowsStage('security', 'verify'), true)
  assert.equal(workTypeAllowsStage('unknown-type', 'iterate'), false)
})

test('a pipeline kind maps to its work type and keeps the old default', () => {
  assert.equal(workTypeForKind('triage'), 'triage')
  for (const kind of ['iterate', 'review', 'plan', 'scope', 'verify', 'discover']) {
    assert.equal(workTypeForKind(kind), 'iterate', `${kind} runs iterate work`)
  }
})

test('the labels are bilingual and an unknown type renders as itself', () => {
  const zh = translator('zh')
  const en = translator('en')
  assert.equal(workTypeLabel(zh, 'triage'), '分诊')
  assert.equal(workTypeLabel(en, 'triage'), 'Triage')
  assert.equal(workTypeLabel(en, 'dependency'), 'Dependency')
  assert.equal(workTypeLabel(en, 'research'), 'research')
  assert.equal(workTypePurpose(en, 'triage').length > 0, true)
  assert.equal(workTypePurpose(en, 'research'), '')
})
