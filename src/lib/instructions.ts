import { createHash } from 'node:crypto'
import { canonicalJson } from '../gates/plan.js'
import { matchesPath } from './pathGuard.js'
import { playbookTextHash } from '../flybot/playbook.js'

// #364 slice 1: the instruction set a job runs under is prose today — the goal,
// the playbook, AGENTS.md, the path rules and the carry-over are pasted into one
// prompt, so a finished job can say what it did and nothing can check it against
// what it was told. This module compiles that set into one content-addressed
// contract and evaluates the clauses a callback can observe. It reads and writes
// nothing: the job column, the bridge echo and the merge refusal are the next
// slice, and they consume this.
//
// The order of the clauses is fixed and is the order the job page prints. A
// clause that the callback cannot observe is `unverifiable`, never `pass`: the
// point of the record is to separate "checked and clean" from "not checked".

export const INSTRUCTION_CONTRACT_VERSION = 1

/**
 * Order by UTF-16 code unit. `localeCompare` would sort by the machine's
 * collation instead — the same file list comes out differently under en-US and
 * zh-CN — and a content-addressed contract cannot depend on the locale it was
 * compiled in.
 */
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** A set in canonical order: repeats dropped, sorted by code unit. */
function canonicalSet(values: string[]): string[] {
  return [...new Set(values)].sort(byCodeUnit)
}

export interface InstructionFile {
  path: string
  sha: string
}

/** The playbook half of the compiled contract: the version and the text's hash. */
export interface InstructionPlaybook {
  version: string | null
  /** SHA-256 of the playbook text the job was told, never a caller-supplied value (#1118). */
  hash: string
}

export interface InstructionContractInput {
  repo: { id: string; fullName: string; defaultBranch: string }
  goal: string
  /**
   * #1118: the contract names the text, not a fingerprint of the goal. The caller
   * passes the playbook it will send (`playbookFor(role, teamLabel, goal)`) and the
   * compile derives the hash, so two v8 playbooks that differ in role text or team
   * label are different contracts.
   */
  playbook: { version: string | null; text: string }
  contextFiles: InstructionFile[]
  paths: { allow: string[]; deny: string[] }
  branch: { base: string; name: string | null }
  required: { evidence: string[]; sections: string[] }
  forbidden: string[]
  carryOver: string[]
  model: { provider: string | null; name: string | null }
  role: string | null
}

export interface InstructionContract extends Omit<InstructionContractInput, 'playbook'> {
  version: number
  playbook: InstructionPlaybook
}

export type AdherenceStatus = 'pass' | 'violation' | 'unverifiable'

/**
 * One clause's outcome. `not-asked` is the fourth answer (#1175): the contract
 * carried no requirement for that family, so nothing was checked — it is not a
 * pass, and it is not `unverifiable` either, because that word means "asked for
 * and not observed". It stays out of the record's fold on purpose, so a contract
 * that asks for none of the three is still a record-level `pass` and no merge
 * outcome moves.
 */
export type ClauseStatus = AdherenceStatus | 'not-asked'

export interface ClauseResult {
  id: string
  status: ClauseStatus
  detail: string
}

/**
 * What the callback reports about the run. Every field is nullable on purpose:
 * `null` means the runner could not observe it, which is `unverifiable`, and an
 * empty array means it observed nothing, which is a real answer.
 */
export interface AdherenceObservation {
  contractHash: string | null
  baseBranch: string | null
  changedPaths: string[] | null
  evidence: string[] | null
  sections: string[] | null
  actions: string[] | null
}

export interface AdherenceRecord {
  status: AdherenceStatus
  /** True only when the callback echoed the hash of this exact contract. */
  hashVerified: boolean
  clauses: ClauseResult[]
}

export function compileInstructionContract(input: InstructionContractInput): { contract: InstructionContract; hash: string } {
  const contract: InstructionContract = {
    version: INSTRUCTION_CONTRACT_VERSION,
    repo: { ...input.repo },
    goal: input.goal,
    playbook: { version: input.playbook.version, hash: playbookTextHash(input.playbook.text) },
    // Sorted by path so two compilations of the same file set hash the same even
    // when the caller read them in a different order; the sha breaks a tie, so
    // the order is total and no compiler-dependent sort can change the result.
    contextFiles: [...input.contextFiles]
      .map((file) => ({ path: file.path, sha: file.sha }))
      .sort((left, right) => byCodeUnit(left.path, right.path) || byCodeUnit(left.sha, right.sha)),
    // The lists the contract treats as sets are canonicalised before hashing:
    // order and repeats are the caller's, not the contract's. `carryOver` is a
    // sequence of earlier turns and keeps the order it was recorded in.
    paths: { allow: canonicalSet(input.paths.allow), deny: canonicalSet(input.paths.deny) },
    branch: { ...input.branch },
    required: { evidence: canonicalSet(input.required.evidence), sections: canonicalSet(input.required.sections) },
    forbidden: canonicalSet(input.forbidden),
    carryOver: [...input.carryOver],
    model: { ...input.model },
    role: input.role,
  }
  return { contract, hash: instructionContractHash(contract) }
}

export function instructionContractHash(contract: InstructionContract): string {
  return createHash('sha256').update(canonicalJson(contract), 'utf8').digest('hex')
}

function list(observed: string[] | null, empty: string): string {
  if (observed === null) return 'not observed'
  return observed.length === 0 ? empty : observed.join(', ')
}

export function evaluateAdherence(contract: InstructionContract, observation: AdherenceObservation): AdherenceRecord {
  const expected = instructionContractHash(contract)
  const clauses: ClauseResult[] = []

  const echoed = observation.contractHash
  const hashVerified = echoed === expected
  clauses.push({
    id: 'contract.hash',
    status: hashVerified ? 'pass' : 'unverifiable',
    detail: hashVerified
      ? `the callback echoed ${expected}`
      : echoed === null
        ? `the callback echoed no contract hash; this job ran under ${expected}`
        : `the callback echoed ${echoed}; this job ran under ${expected}`,
  })

  clauses.push(
    observation.baseBranch === null
      ? { id: 'branch.base', status: 'unverifiable', detail: `the base branch was not observed; the contract expects ${contract.branch.base}` }
      : observation.baseBranch === contract.branch.base
        ? { id: 'branch.base', status: 'pass', detail: `base ${contract.branch.base}` }
        : { id: 'branch.base', status: 'violation', detail: `base ${observation.baseBranch}; the contract expects ${contract.branch.base}` },
  )

  if (observation.changedPaths === null) {
    clauses.push({ id: 'paths.denied', status: 'unverifiable', detail: 'the changed paths were not observed' })
  } else {
    const denied = observation.changedPaths.filter((path) => contract.paths.deny.some((pattern) => matchesPath(path, pattern)))
    clauses.push(
      denied.length === 0
        ? { id: 'paths.denied', status: 'pass', detail: `no changed path matches ${list(contract.paths.deny, 'an empty deny list')}` }
        : { id: 'paths.denied', status: 'violation', detail: `changed a denied path: ${denied.join(', ')}` },
    )
  }

  if (contract.paths.allow.length === 0) {
    clauses.push({ id: 'paths.allowed', status: 'pass', detail: 'the contract names no allow list' })
  } else if (observation.changedPaths === null) {
    clauses.push({ id: 'paths.allowed', status: 'unverifiable', detail: 'the changed paths were not observed' })
  } else {
    const outside = observation.changedPaths.filter((path) => !contract.paths.allow.some((pattern) => matchesPath(path, pattern)))
    clauses.push(
      outside.length === 0
        ? { id: 'paths.allowed', status: 'pass', detail: `every changed path is under ${contract.paths.allow.join(', ')}` }
        : { id: 'paths.allowed', status: 'violation', detail: `changed a path outside the allow list: ${outside.join(', ')}` },
    )
  }

  if (contract.required.evidence.length === 0) {
    clauses.push({ id: 'evidence.required', status: 'not-asked', detail: 'the contract names no required evidence' })
  } else if (observation.evidence === null) {
    clauses.push({ id: 'evidence.required', status: 'unverifiable', detail: 'the evidence was not observed' })
  } else {
    const missing = contract.required.evidence.filter((id) => !observation.evidence?.includes(id))
    clauses.push(
      missing.length === 0
        ? { id: 'evidence.required', status: 'pass', detail: `recorded ${contract.required.evidence.join(', ')}` }
        : { id: 'evidence.required', status: 'violation', detail: `missing required evidence: ${missing.join(', ')}` },
    )
  }

  if (contract.required.sections.length === 0) {
    clauses.push({ id: 'sections.required', status: 'not-asked', detail: 'the contract names no required sections' })
  } else if (observation.sections === null) {
    clauses.push({ id: 'sections.required', status: 'unverifiable', detail: 'the body sections were not observed' })
  } else {
    const missing = contract.required.sections.filter((section) => !observation.sections?.includes(section))
    clauses.push(
      missing.length === 0
        ? { id: 'sections.required', status: 'pass', detail: `the body carries ${contract.required.sections.join(', ')}` }
        : { id: 'sections.required', status: 'violation', detail: `missing required section: ${missing.join(', ')}` },
    )
  }

  if (contract.forbidden.length === 0) {
    clauses.push({ id: 'actions.forbidden', status: 'not-asked', detail: 'the contract forbids no action' })
  } else if (observation.actions === null) {
    clauses.push({ id: 'actions.forbidden', status: 'unverifiable', detail: 'the actions were not observed' })
  } else {
    const taken = contract.forbidden.filter((action) => observation.actions?.includes(action))
    clauses.push(
      taken.length === 0
        ? { id: 'actions.forbidden', status: 'pass', detail: `none of ${contract.forbidden.join(', ')}` }
        : { id: 'actions.forbidden', status: 'violation', detail: `took a forbidden action: ${taken.join(', ')}` },
    )
  }

  const status: AdherenceStatus = clauses.some((clause) => clause.status === 'violation')
    ? 'violation'
    : clauses.some((clause) => clause.status === 'unverifiable')
      ? 'unverifiable'
      : 'pass'
  return { status, hashVerified, clauses }
}
