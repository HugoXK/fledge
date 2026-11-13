import type { Evidence } from './evidence.js'
import type { Translate } from '../i18n.js'

// #390: every job carries a work type, and the work type is data. A job's kind
// says which of Fledge's existing pipelines runs it (`iterate`, `review`,
// `plan`, `scope`, `verify`, `discover`, plus the new `triage`); the work type
// says what the work is and therefore what counts as done. The two are separate
// on purpose: one pipeline can carry several kinds of work, and only the work
// type may say whether the result is allowed to merge itself.
//
// The registry is the only place a work type is described. `JobKind` stays the
// list of pipelines in `src/jobs/runner.ts`; a second copy of either list is how
// `scope` and `verify` once went missing from the job form.

export type WorkType =
  | 'iterate'
  | 'triage'
  | 'dependency'
  | 'security'
  | 'docs'
  | 'performance'
  | 'accessibility'
  | 'migration'

export const WORK_TYPES: readonly WorkType[] = [
  'iterate',
  'triage',
  'dependency',
  'security',
  'docs',
  'performance',
  'accessibility',
  'migration',
]

/** The stages `src/lib/stages.ts` already knows. A work type may only use these. */
export type WorkStage = 'plan' | 'scope' | 'verify' | 'iterate' | 'review'

export type WorkRisk = 'T0' | 'T1' | 'T2' | 'T3'

/** The evidence keys a work type requires. Mirrors `Evidence` in `evidence.ts`. */
export type WorkEvidenceKey = keyof Evidence

export interface WorkTypeContract {
  type: WorkType
  /** Bilingual label, en second: the console is bilingual and the registry is data. */
  label: [string, string]
  /** One line a maintainer can read in the job page: what this work is. */
  purpose: [string, string]
  /** The stages this work type may run. `triage` runs none of them. */
  stages: readonly WorkStage[]
  /** Evidence that must be present before the result can count as done. */
  evidence: readonly WorkEvidenceKey[]
  /** The risk tier the work type declares; the diff still decides the real one. */
  risk: WorkRisk
  /** Ceiling for one job of this type, in USD. */
  budgetUsd: number
  /** Whether a pull request produced by this work type may merge under its rules. */
  autoMerge: boolean
  /** Whether this work type may create a branch and a pull request at all. */
  branch: boolean
}

// Iterate is the general-purpose type and the only one that may auto-merge: the
// merge decision was written for a reviewed code change with red/green evidence,
// and a dependency bump, a security fix, a docs edit, a performance change, an
// accessibility fix or a migration each need rules that do not exist yet. Until
// they do, those types must not inherit iterate's eligibility (#390 red test:
// "a dependency/security/docs work type cannot auto-merge under the wrong rules").
const ITERATE: WorkTypeContract = {
  type: 'iterate',
  label: ['迭代', 'Iterate'],
  purpose: ['写代码修一个问题，先红后绿，开一个 PR', 'Fix one problem in code with a red test first and one PR'],
  stages: ['plan', 'scope', 'verify', 'iterate', 'review'],
  evidence: ['scope', 'testRed', 'testGreen'],
  risk: 'T2',
  budgetUsd: 5,
  autoMerge: true,
  branch: true,
}

const TRIAGE: WorkTypeContract = {
  type: 'triage',
  label: ['分诊', 'Triage'],
  purpose: ['读取开放的 issue 和 PR，排优先级、链接重复项并给出下一项', 'Read open issues and pull requests, rank them, link duplicates and name the next item'],
  stages: [],
  evidence: [],
  risk: 'T0',
  budgetUsd: 1,
  autoMerge: false,
  branch: false,
}

const DEPENDENCY: WorkTypeContract = {
  type: 'dependency',
  label: ['依赖升级', 'Dependency'],
  purpose: ['为一个依赖做最小安全升级并跑现有测试', 'Upgrade one dependency the smallest safe way and run the existing tests'],
  stages: ['iterate', 'verify', 'review'],
  evidence: ['tests', 'checks'],
  risk: 'T2',
  budgetUsd: 3,
  autoMerge: false,
  branch: true,
}

const SECURITY: WorkTypeContract = {
  type: 'security',
  label: ['安全修复', 'Security'],
  purpose: ['修一个已证实的安全问题并留下回滚方式', 'Fix one proven security problem and record the rollback'],
  stages: ['scope', 'iterate', 'verify', 'review'],
  evidence: ['testRed', 'testGreen', 'rollback'],
  risk: 'T3',
  budgetUsd: 5,
  autoMerge: false,
  branch: true,
}

const DOCS: WorkTypeContract = {
  type: 'docs',
  label: ['文档', 'Docs'],
  purpose: ['让一处文档与代码一致，只改文档', 'Make one piece of documentation match the code, docs only'],
  stages: ['iterate', 'review'],
  evidence: ['checks'],
  risk: 'T0',
  budgetUsd: 2,
  autoMerge: false,
  branch: true,
}

const PERFORMANCE: WorkTypeContract = {
  type: 'performance',
  label: ['性能', 'Performance'],
  purpose: ['用一个可复现的测量改进一处性能', 'Improve one measured, reproducible performance problem'],
  stages: ['scope', 'iterate', 'verify', 'review'],
  evidence: ['testRed', 'testGreen'],
  risk: 'T2',
  budgetUsd: 3,
  autoMerge: false,
  branch: true,
}

const ACCESSIBILITY: WorkTypeContract = {
  type: 'accessibility',
  label: ['无障碍', 'Accessibility'],
  purpose: ['修一个可复现的无障碍缺陷', 'Fix one reproducible accessibility defect'],
  stages: ['iterate', 'verify', 'review'],
  evidence: ['testRed', 'testGreen'],
  risk: 'T1',
  budgetUsd: 2,
  autoMerge: false,
  branch: true,
}

const MIGRATION: WorkTypeContract = {
  type: 'migration',
  label: ['迁移', 'Migration'],
  purpose: ['做一次有回滚方案的数据或结构迁移', 'Run one data or schema migration with a rollback'],
  stages: ['scope', 'plan', 'verify', 'iterate', 'review'],
  evidence: ['rollback', 'checks'],
  risk: 'T3',
  budgetUsd: 5,
  autoMerge: false,
  branch: true,
}

const REGISTRY: Record<WorkType, WorkTypeContract> = {
  iterate: ITERATE,
  triage: TRIAGE,
  dependency: DEPENDENCY,
  security: SECURITY,
  docs: DOCS,
  performance: PERFORMANCE,
  accessibility: ACCESSIBILITY,
  migration: MIGRATION,
}

/**
 * The work types this build can actually run. The registry declares all eight so
 * the contracts are one list, but a type with no handler is refused exactly like
 * an unknown one: otherwise "a dependency job cannot auto-merge" would test a
 * row that can never run (#390 issue-review).
 */
export const IMPLEMENTED_WORK_TYPES: readonly WorkType[] = ['iterate', 'triage']

export function isImplementedWorkType(value: unknown): value is WorkType {
  return isWorkType(value) && (IMPLEMENTED_WORK_TYPES as readonly string[]).includes(value)
}

export function isWorkType(value: unknown): value is WorkType {
  return typeof value === 'string' && (WORK_TYPES as readonly string[]).includes(value)
}

export function contractOf(type: WorkType): WorkTypeContract {
  return REGISTRY[type]
}

/**
 * The registry lookup that refuses. An unknown value is `null`, never a default:
 * a work type nobody declared has no evidence rules, so silently reading it as
 * iterate would let it merge under rules it never satisfied.
 */
export function resolveWorkType(value: unknown): WorkTypeContract | null {
  return isWorkType(value) ? REGISTRY[value] : null
}

/**
 * The work type a pipeline kind runs as. Only `triage` is its own work type;
 * plan/scope/verify/review are stages of iterate work and `discover` proposes
 * iterate work, so they all carry iterate's contract.
 */
export function workTypeForKind(kind: string): WorkType {
  return kind === 'triage' ? 'triage' : 'iterate'
}

/** Whether a succeeded job of this work type may hand its PR to auto-merge. */
export function workTypeMayAutoMerge(type: unknown): boolean {
  return resolveWorkType(type)?.autoMerge === true
}

/** Whether this work type may produce a branch and a pull request at all. */
export function workTypeMayBranch(type: unknown): boolean {
  const contract = resolveWorkType(type)
  return contract === null ? false : contract.branch
}

/** Whether the pipeline stage is allowed for this work type. */
export function workTypeAllowsStage(type: unknown, stage: string): boolean {
  const contract = resolveWorkType(type)
  return contract === null ? false : (contract.stages as readonly string[]).includes(stage)
}

/**
 * The evidence rule, and the failing-closed half: every key the work type names
 * must be present in the report. The answer is the missing keys, so the caller
 * can say which one is absent instead of failing silently.
 */
export function missingWorkTypeEvidence(type: unknown, evidence: Evidence | null): WorkEvidenceKey[] {
  const contract = resolveWorkType(type)
  if (contract === null) return ['scope']
  const missing: WorkEvidenceKey[] = []
  for (const key of contract.evidence) {
    const value = evidence?.[key]
    const present = typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && value.trim() !== ''
    if (!present) missing.push(key)
  }
  return missing
}

export function workTypeLabel(t: Translate, type: string): string {
  const contract = resolveWorkType(type)
  return contract === null ? type : t(contract.label[0], contract.label[1])
}

export function workTypePurpose(t: Translate, type: string): string {
  const contract = resolveWorkType(type)
  return contract === null ? '' : t(contract.purpose[0], contract.purpose[1])
}
