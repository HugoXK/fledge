import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compileContextBundle,
  contextBundleHash,
  diffContextBundles,
  readContextBundle,
  verifyContextBundle,
  verifyContextBundleEcho,
  type ContextBundle,
} from '../src/lib/contextBundle.js'
import type { InstructionContractInput } from '../src/lib/instructions.js'

// #369: the bundle a job carries has to be verifiable by a reader who does not
// trust the row. The cases below are the ones that separate a real check from a
// badge: a hash that is valid for different bytes, an echo that names the hash
// of another bundle, and a policy change that must be visible instead of silent.

function contractInput(overrides: Partial<InstructionContractInput> = {}): InstructionContractInput {
  return {
    repo: { id: 'repo_1', fullName: 'HugoXK/fledge', defaultBranch: 'main' },
    goal: 'fix the job page',
    playbook: { version: 'v8', hash: 'playbook-hash' },
    contextFiles: [{ path: 'AGENTS.md', sha: 'agents-sha' }],
    paths: { allow: ['src/'], deny: ['deploy/'] },
    branch: { base: 'main', name: null },
    required: { evidence: ['test'], sections: ['What changed'] },
    forbidden: ['force-push'],
    carryOver: [],
    model: { provider: 'deepseek', name: 'DeepSeek-V4.1-Flash-1017' },
    role: 'Dev-3',
    ...overrides,
  }
}

function compiled(overrides: Partial<InstructionContractInput> = {}): { bundle: ContextBundle; hash: string } {
  return compileContextBundle(contractInput(overrides))
}

test('the stored bytes decide the verdict, not the recorded hash', () => {
  const first = compiled()
  const second = compiled({ goal: 'a different goal' })
  // The row claims first's hash while holding second's bytes. A check that only
  // compares the two recorded strings would call this verified.
  const verdict = verifyContextBundle(JSON.stringify(second.bundle), first.hash)
  assert.equal(verdict.state, 'mismatch')
  assert.match(verdict.detail, new RegExp(second.hash))
  assert.equal(verifyContextBundle(JSON.stringify(first.bundle), first.hash).state, 'verified')
})

test('an echo of another bundle hash is not a match, even when that hash is well formed', () => {
  const first = compiled()
  const second = compiled({ goal: 'a different goal' })
  const echo = verifyContextBundleEcho(JSON.stringify(first.bundle), first.hash, second.hash)
  assert.equal(echo.state, 'mismatch')
  assert.equal(verifyContextBundleEcho(JSON.stringify(first.bundle), first.hash, first.hash).state, 'verified')
  assert.equal(verifyContextBundleEcho(JSON.stringify(first.bundle), first.hash, null).state, 'missing')
})

test('an edited byte inside the bundle breaks verification', () => {
  const { bundle, hash } = compiled()
  const tampered = JSON.stringify({ ...bundle, contract: { ...bundle.contract, goal: 'something else' } })
  assert.equal(verifyContextBundle(tampered, hash).state, 'mismatch')
})

test('a job with no bundle hash is missing, never verified', () => {
  const { bundle } = compiled()
  assert.equal(verifyContextBundle(JSON.stringify(bundle), null).state, 'missing')
  assert.equal(verifyContextBundle(null, 'a'.repeat(64)).state, 'mismatch')
})

test('the record reconstructs the exact bundle the job ran under', () => {
  const { bundle, hash } = compiled()
  const stored = JSON.stringify(bundle)
  const read = readContextBundle(stored)
  assert.notEqual(read, null)
  assert.deepEqual(read, bundle)
  assert.equal(contextBundleHash(read as ContextBundle), hash)
  assert.equal(readContextBundle('{not json'), null)
})

test('a policy change is a named diff, and an unchanged bundle is an empty one', () => {
  const previous = compiled().bundle
  const next = compiled({ goal: 'a different goal', paths: { allow: ['src/'], deny: ['deploy/', 'data/'] } }).bundle
  const changes = diffContextBundles(previous, next)
  assert.deepEqual(changes.map((change) => change.field), ['goal', 'paths.deny', 'contractHash'])
  assert.equal(changes[0]?.before, 'fix the job page')
  assert.equal(changes[0]?.after, 'a different goal')
  assert.deepEqual(diffContextBundles(previous, previous), [])
})

test('a bundle compiled from the same policy is byte-identical', () => {
  const first = compiled()
  const second = compileContextBundle(contractInput({ paths: { allow: ['src/', 'src/'], deny: ['deploy/'] } }))
  assert.equal(second.hash, first.hash)
  assert.equal(JSON.stringify(second.bundle), JSON.stringify(first.bundle))
})

test('no environment value is copied into the bundle', () => {
  const key = 'FLEDGE_CONTEXT_BUNDLE_TEST_SECRET'
  const previous = process.env[key]
  process.env[key] = 'sk-do-not-store-me'
  try {
    const { bundle } = compiled()
    assert.equal(JSON.stringify(bundle).includes('sk-do-not-store-me'), false)
    assert.deepEqual(Object.keys(bundle).sort(), ['contract', 'contractHash', 'version'])
  } finally {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})
