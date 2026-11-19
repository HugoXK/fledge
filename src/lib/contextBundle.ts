import { createHash } from 'node:crypto'
import { canonicalJson } from '../gates/plan.js'
import {
  compileInstructionContract,
  instructionContractHash,
  type InstructionContract,
  type InstructionContractInput,
} from './instructions.js'

// #369: the contract from #364 is the policy a job runs under; this module makes
// one sealed copy of it that a job carries and a reader can recompute. The
// bundle is the contract plus nothing: no timestamp, no host name, no environment
// value, so two compilations of the same policy produce the same bytes and the
// hash identifies the policy rather than the moment it was compiled.
//
// The verification never trusts the recorded hash. A recorded hash is a claim
// written by the same process that stored the bytes, and a bundle that checks
// itself would pass while holding any content at all: the only question worth
// answering is whether the stored bytes still hash to the value the job reports,
// so the stored JSON is re-hashed on every read.

export const CONTEXT_BUNDLE_VERSION = 1

export interface ContextBundle {
  version: number
  contract: InstructionContract
  /** The contract's own hash, carried inside the bundle so an envelope alone identifies a policy. */
  contractHash: string
}

export type ContextBundleState = 'verified' | 'mismatch' | 'missing'

export interface ContextBundleVerification {
  state: ContextBundleState
  /** One line a page can print without re-deriving anything. */
  detail: string
}

export interface ContextBundleChange {
  field: string
  before: string
  after: string
}

export function compileContextBundle(input: InstructionContractInput): { bundle: ContextBundle; hash: string } {
  const { contract } = compileInstructionContract(input)
  const bundle: ContextBundle = {
    version: CONTEXT_BUNDLE_VERSION,
    contract,
    contractHash: instructionContractHash(contract),
  }
  return { bundle, hash: contextBundleHash(bundle) }
}

export function contextBundleHash(bundle: ContextBundle): string {
  return createHash('sha256').update(canonicalJson(bundle), 'utf8').digest('hex')
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Parse a stored bundle, returning null rather than a half-shaped object. */
export function readContextBundle(json: string | null | undefined): ContextBundle | null {
  if (json === null || json === undefined || json === '') return null
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const bundle = value as Partial<ContextBundle>
  if (typeof bundle.version !== 'number' || typeof bundle.contractHash !== 'string') return null
  if (bundle.contract === null || typeof bundle.contract !== 'object') return null
  const contract = bundle.contract as Partial<InstructionContract>
  if (typeof contract.goal !== 'string') return null
  if (contract.paths === null || typeof contract.paths !== 'object') return null
  if (!isStringArray(contract.paths?.allow) || !isStringArray(contract.paths?.deny)) return null
  if (!isStringArray(contract.forbidden) || !isStringArray(contract.carryOver)) return null
  if (!isStringArray(contract.required?.evidence) || !isStringArray(contract.required?.sections)) return null
  return bundle as ContextBundle
}

/**
 * Verify the stored bytes against the hash the job reports. `mismatch` covers
 * both directions on purpose: bytes that were edited after the hash was written,
 * and a job whose bytes were replaced by another job's bundle while the old hash
 * stayed in the row.
 */
export function verifyContextBundle(json: string | null | undefined, recordedHash: string | null | undefined): ContextBundleVerification {
  if (recordedHash === null || recordedHash === undefined || recordedHash === '') {
    return { state: 'missing', detail: 'the job records no bundle hash' }
  }
  const bundle = readContextBundle(json)
  if (bundle === null) {
    return { state: 'mismatch', detail: `the stored bundle is unreadable; the job records ${recordedHash}` }
  }
  const recomputed = contextBundleHash(bundle)
  if (recomputed !== recordedHash) {
    return { state: 'mismatch', detail: `the stored bytes hash to ${recomputed}; the job records ${recordedHash}` }
  }
  const contractHash = instructionContractHash(bundle.contract)
  if (contractHash !== bundle.contractHash) {
    return { state: 'mismatch', detail: `the bundle names contract ${bundle.contractHash}; its contract hashes to ${contractHash}` }
  }
  return { state: 'verified', detail: `the stored bytes hash to ${recordedHash}` }
}

/**
 * The callback's echo is a claim about what the runner received. It decides one
 * thing only: whether the runner and the row agree on the same bundle. It can
 * never upgrade a bundle whose own bytes fail verification, so the echo is
 * checked against the recomputed hash rather than against the recorded one.
 */
export function verifyContextBundleEcho(
  json: string | null | undefined,
  recordedHash: string | null | undefined,
  echo: string | null | undefined,
): ContextBundleVerification {
  const stored = verifyContextBundle(json, recordedHash)
  if (stored.state !== 'verified') return stored
  if (echo === null || echo === undefined || echo === '') {
    return { state: 'missing', detail: 'the callback echoed no bundle hash' }
  }
  const recomputed = contextBundleHash(readContextBundle(json) as ContextBundle)
  if (echo !== recomputed) {
    return { state: 'mismatch', detail: `the callback echoed ${echo}; the stored bundle hashes to ${recomputed}` }
  }
  return { state: 'verified', detail: `the callback echoed ${recomputed}` }
}

function list(values: string[], empty: string): string {
  return values.length === 0 ? empty : values.join(', ')
}

function fileSet(contract: InstructionContract): string {
  return contract.contextFiles.map((file) => `${file.path}@${file.sha.slice(0, 12)}`).join(', ')
}

/**
 * What a reader of the new bundle would see had changed since the previous one.
 * Ordered by the contract's own field order, so the job page and a test read the
 * same sequence, and a field that did not change is absent rather than printed
 * as identical.
 */
export function diffContextBundles(previous: ContextBundle | null, next: ContextBundle): ContextBundleChange[] {
  const changes: ContextBundleChange[] = []
  const compare = (field: string, before: string, after: string): void => {
    if (before !== after) changes.push({ field, before, after })
  }
  if (previous === null) {
    changes.push({ field: 'bundle', before: 'none', after: `${next.version} · ${next.contract.goal === '' ? 'no goal' : next.contract.goal}` })
    return changes
  }
  compare('version', String(previous.version), String(next.version))
  compare('repo', previous.contract.repo.fullName, next.contract.repo.fullName)
  compare('defaultBranch', previous.contract.repo.defaultBranch, next.contract.repo.defaultBranch)
  compare('goal', previous.contract.goal, next.contract.goal)
  compare('playbook.version', String(previous.contract.playbook.version), String(next.contract.playbook.version))
  compare('playbook.hash', previous.contract.playbook.hash, next.contract.playbook.hash)
  compare('contextFiles', fileSet(previous.contract), fileSet(next.contract))
  compare('paths.allow', list(previous.contract.paths.allow, 'none'), list(next.contract.paths.allow, 'none'))
  compare('paths.deny', list(previous.contract.paths.deny, 'none'), list(next.contract.paths.deny, 'none'))
  compare('branch.base', previous.contract.branch.base, next.contract.branch.base)
  compare('branch.name', String(previous.contract.branch.name), String(next.contract.branch.name))
  compare('required.evidence', list(previous.contract.required.evidence, 'none'), list(next.contract.required.evidence, 'none'))
  compare('required.sections', list(previous.contract.required.sections, 'none'), list(next.contract.required.sections, 'none'))
  compare('forbidden', list(previous.contract.forbidden, 'none'), list(next.contract.forbidden, 'none'))
  compare('carryOver', String(previous.contract.carryOver.length), String(next.contract.carryOver.length))
  compare('model', `${previous.contract.model.provider ?? '-'}/${previous.contract.model.name ?? '-'}`, `${next.contract.model.provider ?? '-'}/${next.contract.model.name ?? '-'}`)
  compare('role', String(previous.contract.role), String(next.contract.role))
  compare('contractHash', previous.contractHash, next.contractHash)
  return changes
}
