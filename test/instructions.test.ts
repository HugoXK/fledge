import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  INSTRUCTION_CONTRACT_VERSION,
  compileInstructionContract,
  evaluateAdherence,
  instructionContractHash,
} from '../src/lib/instructions.js'
import type { AdherenceObservation, InstructionContractInput } from '../src/lib/instructions.js'
import { playbookFor } from '../src/flybot/playbook.js'

// #364 slice 1: the instruction set a job runs under is prose today —the goal,
// the playbook, AGENTS.md, the path rules and the carry-over are pasted into one
// prompt, so a completed job cannot be checked against what it was told. These
// cases pin the compiled contract and the clause evaluation; the job column, the
// bridge echo and the merge refusal are the next slice, and they read this.

const baseInput = (): InstructionContractInput => ({
  repo: { id: 'repo_1', fullName: 'o/r', defaultBranch: 'main' },
  goal: 'name the workspace in the console notices',
  playbook: { version: 'v8', text: playbookFor('lead', 'Fledge Platform', '') },
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

test('the contract hashes the playbook text, so two v8 playbooks at one version differ', () => {
  // #1118: the record has to name the text the job was told, not a caller-supplied
  // fingerprint. `playbookFingerprint` is sha256('v8:' + goal), so every role in
  // every repository with the same goal carries the same value; the text does not.
  const text = playbookFor('lead', 'Fledge Platform', '')
  const fledge = compileInstructionContract({ ...baseInput(), playbook: { version: 'v8', text } })
  const expected = createHash('sha256').update(text, 'utf8').digest('hex')
  assert.equal(fledge.contract.playbook.version, 'v8')
  assert.equal(fledge.contract.playbook.hash, expected, "the recorded hash is the text's own SHA-256")
  assert.equal('text' in fledge.contract.playbook, false, 'the contract records the hash of the text, not the whole protocol')

  const otherLabel = compileInstructionContract({ ...baseInput(), playbook: { version: 'v8', text: playbookFor('lead', 'Another Team', '') } })
  assert.notEqual(otherLabel.contract.playbook.hash, fledge.contract.playbook.hash, 'the team label is part of the playbook text')
  assert.notEqual(otherLabel.hash, fledge.hash, 'and the contract hash covers the text hash')

  const otherRole = compileInstructionContract({ ...baseInput(), playbook: { version: 'v8', text: playbookFor('dev1', 'Fledge Platform', '') } })
  assert.notEqual(otherRole.contract.playbook.hash, fledge.contract.playbook.hash, 'the role text is part of the playbook text')
})

test('the same instruction set hashes the same under another locale and another input order', () => {
  // `localeCompare` sorts by the machine's collation, and the contract is
  // content-addressed: a review run under zh-CN would have hashed the same
  // instruction set differently from the job that ran under en-US. These inputs
  // are chosen so the two collations disagree — zh-CN puts 北京 before 上海 and
  // sorts the Chinese paths among the Latin ones.
  const input = (): InstructionContractInput => ({
    ...compiled(),
    contextFiles: [
      { path: 'src/北京.ts', sha: 'c'.repeat(40) },
      { path: 'README.md', sha: 'd'.repeat(40) },
      { path: 'src/上海.ts', sha: 'e'.repeat(40) },
      { path: 'src/z.ts', sha: 'f'.repeat(40) },
    ],
    paths: { allow: ['test/**', 'src/阿/**', 'src/**'], deny: ['scripts/**', 'deploy/**'] },
    required: { evidence: ['changelog-fragment', 'test-run'], sections: ['Ran', 'What changed'] },
    forbidden: ['edit-changelog-in-pr', 'force-push'],
  })

  const first = compileInstructionContract(input())
  const reordered = compileInstructionContract({
    ...input(),
    contextFiles: [...input().contextFiles].reverse(),
    paths: { allow: [...input().paths.allow].reverse(), deny: [...input().paths.deny].reverse() },
    required: { evidence: [...input().required.evidence].reverse(), sections: [...input().required.sections].reverse() },
    forbidden: [...input().forbidden].reverse(),
    // The carry-over keeps its order: it is a sequence of earlier turns, not a set.
  })
  assert.equal(reordered.hash, first.hash, 'the order a caller reads a set in is not part of the contract')

  // The canonical order is by UTF-16 code unit, so a list prints the same on
  // every machine and two compilations can be compared entry by entry.
  assert.deepEqual(
    first.contract.contextFiles.map((file) => file.path),
    ['README.md', 'src/z.ts', 'src/上海.ts', 'src/北京.ts'],
    'context files are ordered by code unit, not by a locale',
  )
  assert.deepEqual(first.contract.paths.allow, ['src/**', 'src/阿/**', 'test/**'])
  assert.deepEqual(first.contract.paths.deny, ['deploy/**', 'scripts/**'])

  // The comparison is locale-dependent even inside one process only up to the
  // locale Node started with, so the evidence is two child processes started
  // under different ones. `en_US.UTF-8` is the default this suite runs under;
  // `zh_CN.UTF-8` is the one that caught the defect.
  const script = `const { compileInstructionContract } = await import('./src/lib/instructions.ts'); console.log(compileInstructionContract(${JSON.stringify(input())}).hash)`
  const hashUnder = (locale: string): string => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, LANG: locale, LC_ALL: locale },
    })
    assert.equal(run.status, 0, `compiling under ${locale} failed: ${run.stderr}`)
    return run.stdout.trim()
  }
  const english = hashUnder('en_US.UTF-8')
  const chinese = hashUnder('zh_CN.UTF-8')
  assert.match(english, /^[0-9a-f]{64}$/)
  assert.equal(chinese, english, 'the same instructions hash the same under zh_CN as under en_US')
  assert.equal(english, first.hash, 'and a separate process agrees with this one')
})

test('a job that satisfies every checkable clause is a pass', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const record = evaluateAdherence(contract, cleanObservation(hash))
  assert.equal(record.status, 'pass')
  assert.equal(record.hashVerified, true)
  assert.ok(record.clauses.length >= 5, 'the record names its clauses')
  assert.ok(record.clauses.every((clause) => clause.status === 'pass'), 'no clause is left undecided')
})

// #1175: a job seals the three requirement lists empty (`src/jobs/service.ts`),
// so the empty-requirement branch is the only one these clauses can take in
// production. It answered `pass`, which reads as "checked and clean" for a
// check nobody performed; the detail beside it already said nothing was asked.
test('a requirement the contract never asked for is not asked, never a pass', () => {
  const { contract, hash } = compileInstructionContract({
    ...compiled(),
    required: { evidence: [], sections: [] },
    forbidden: [],
  })
  // The gate's observation of these three is `null`, so the empty branch wins
  // only because it is tested before the null branch; this is the production
  // shape, not a hypothetical one.
  const record = evaluateAdherence(contract, { ...cleanObservation(hash), evidence: null, sections: null, actions: null })
  for (const id of ['evidence.required', 'sections.required', 'actions.forbidden']) {
    const clause = record.clauses.find((entry) => entry.id === id)
    assert.equal(clause?.status, 'not-asked', `${id} is its own outcome, not a verdict`)
    assert.notEqual(clause?.status, 'pass', `${id} must never read as a pass`)
    assert.notEqual(clause?.status, 'unverifiable', `${id} was not asked, so it cannot be "asked and unobserved"`)
  }
  assert.equal(record.status, 'pass', 'nothing was asked and nothing failed, so the record still passes and no merge outcome moves')
})

test('a contract that names its requirements keeps a pass on every clause', () => {
  const { contract, hash } = compileInstructionContract(compiled())
  const record = evaluateAdherence(contract, cleanObservation(hash))
  for (const id of ['evidence.required', 'sections.required', 'actions.forbidden']) {
    const clause = record.clauses.find((entry) => entry.id === id)
    assert.equal(clause?.status, 'pass', `${id} was asked and satisfied, so the new outcome does not leak onto it`)
  }
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
