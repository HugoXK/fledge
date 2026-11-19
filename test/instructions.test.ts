import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INSTRUCTION_CONTRACT_VERSION,
  compileInstructionContract,
  evaluateAdherence,
  instructionContractHash,
} from '../src/lib/instructions.js'
import type { AdherenceObservation, InstructionContractInput } from '../src/lib/instructions.js'

// #364 slice 1: the instruction set a job runs under is prose today —the goal,
// the playbook, AGENTS.md, the path rules and the carry-over are pasted into one
// prompt, so a completed job cannot be checked against what it was told. These
// cases pin the compiled contract and the clause evaluation; the job column, the
// bridge echo and the merge refusal are the next slice, and they read this.

const baseInput = (): InstructionContractInput => ({
  repo: { id: 'repo_1', fullName: 'o/r', defaultBranch: 'main' },
  goal: 'name the workspace in the console notices',
  playbook: { version: 'v8', hash: 'a'.repeat(64) },
  contextFiles: [{ path: 'AGENTS.md', sha: 'b'.repeat(40) }],
  paths: { allow: ['src/**', 'test/**'], deny: ['deploy/**'] },
  branch: { base: 'main', name: 'dev4/364-adherence-contract' },
  required: { evidence: ['test-run'], sections: ['What changed', 'Ran'] },
  forbidden: ['force-push', 'edit-changelog-in-pr'],
  carryOver: ['#1104'],
  model: { provider: 'deepseek', name: 'DeepSeek-V4.1-Flash-1017' },
  role: 'developer',
})

const compiled = (): InstructionContractInput => baseInput()

const cleanObservation = (contractHash: string): AdherenceObservation => ({
  contractHash,
  baseBranch: 'main',
  changedPaths: ['src/views/pages.ts', 'test/pages.test.ts'],
  evidence: ['test-run'],
  sections: ['What changed', 'Ran'],
  actions: [],
})

test('the contract is content-addressed over every instruction it carries', () => {
  const input = compiled()
  const first = compileInstructionContract(input)
  const second = compileInstructionContract(compiled())
  assert.equal(first.hash, second.hash, 'the same instructions compile to the same hash')
  assert.equal(first.hash, instructionContractHash(first.contract), 'the hash is the contract, not the input')
  assert.equal(first.contract.version, INSTRUCTION_CONTRACT_VERSION, 'the compiled contract carries its version')
  assert.match(first.hash, /^[0-9a-f]{64}$/)

  const changed = compileInstructionContract({ ...compiled(), goal: 'a different goal' })
  assert.notEqual(changed.hash, first.hash, 'a changed goal is a different contract')
  const denied = compileInstructionContract({ ...compiled(), paths: { allow: ['src/**', 'test/**'], deny: ['scripts/**'] } })
  assert.notEqual(denied.hash, first.hash, 'a changed path rule is a different contract')
})

test('a job that satisfies every checkable clause is a pass', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const record = evaluateAdherence(contract, cleanObservation(hash))
  assert.equal(record.status, 'pass')
  assert.equal(record.hashVerified, true)
  assert.ok(record.clauses.length >= 5, 'the record names its clauses')
  assert.ok(record.clauses.every((clause) => clause.status === 'pass'), 'no clause is left undecided')
})

test('a changed denied path is a violation even when the job reports green tests', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const record = evaluateAdherence(contract, {
    ...cleanObservation(hash),
    changedPaths: ['src/views/pages.ts', 'deploy/systemd/fledge.service'],
  })
  assert.equal(record.status, 'violation')
  const clause = record.clauses.find((entry) => entry.id === 'paths.denied')
  assert.equal(clause?.status, 'violation')
  assert.match(clause?.detail ?? '', /deploy\/systemd\/fledge\.service/)
  const evidence = record.clauses.find((entry) => entry.id === 'evidence.required')
  assert.equal(evidence?.status, 'pass', 'a green evidence clause does not cancel a path violation')
})

test('a changed path outside the allow list is a violation', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const record = evaluateAdherence(contract, { ...cleanObservation(hash), changedPaths: ['README.md'] })
  assert.equal(record.status, 'violation')
  assert.equal(record.clauses.find((entry) => entry.id === 'paths.allowed')?.status, 'violation')
})

test('a missing required evidence clause or section is a violation', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const noEvidence = evaluateAdherence(contract, { ...cleanObservation(hash), evidence: [] })
  assert.equal(noEvidence.status, 'violation')
  const evidenceClause = noEvidence.clauses.find((entry) => entry.id === 'evidence.required')
  assert.equal(evidenceClause?.status, 'violation')
  assert.match(evidenceClause?.detail ?? '', /test-run/)

  const noSection = evaluateAdherence(contract, { ...cleanObservation(hash), sections: ['What changed'] })
  assert.equal(noSection.status, 'violation')
  const sectionClause = noSection.clauses.find((entry) => entry.id === 'sections.required')
  assert.equal(sectionClause?.status, 'violation')
  assert.match(sectionClause?.detail ?? '', /Ran/)
})

test('an action the contract forbids is a violation', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const record = evaluateAdherence(contract, { ...cleanObservation(hash), actions: ['force-push'] })
  assert.equal(record.status, 'violation')
  assert.equal(record.clauses.find((entry) => entry.id === 'actions.forbidden')?.status, 'violation')
})

test('a clause the callback cannot observe is unverifiable, never pass', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const record = evaluateAdherence(contract, {
    contractHash: hash,
    baseBranch: null,
    changedPaths: null,
    evidence: null,
    sections: null,
    actions: null,
  })
  assert.equal(record.status, 'unverifiable')
  assert.ok(record.clauses.every((clause) => clause.id === 'contract.hash' || clause.status === 'unverifiable'), 'an unobserved clause is never shown as pass')
})

test('a callback echoing another hash, or no hash, is not verified', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const mismatched = evaluateAdherence(contract, cleanObservation('c'.repeat(64)))
  assert.equal(mismatched.hashVerified, false)
  assert.notEqual(mismatched.status, 'pass')
  assert.equal(mismatched.clauses.find((entry) => entry.id === 'contract.hash')?.status, 'unverifiable')

  const missing = evaluateAdherence(contract, { ...cleanObservation(hash), contractHash: null })
  assert.equal(missing.hashVerified, false)
  assert.notEqual(missing.status, 'pass')
})

test('a violation outranks an unverifiable clause in the record', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const record = evaluateAdherence(contract, {
    ...cleanObservation(hash),
    changedPaths: ['deploy/systemd/fledge.service'],
    sections: null,
  })
  assert.equal(record.status, 'violation')
  assert.ok(record.clauses.some((clause) => clause.status === 'unverifiable'), 'the unobserved clause is still named')
})
