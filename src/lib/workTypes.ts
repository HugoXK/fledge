import type { Evidence } from './evidence.js'
import { findDuplicatePullRequest, issueNumberFromText } from './duplicates.js'
import { issuePriority } from './issueIntake.js'

export const WORK_TYPE_IDS = [
  'iterate',
  'triage',
  'dependency',
  'security',
  'docs',
  'performance',
  'accessibility',
  'migration',
] as const

export type WorkTypeId = (typeof WORK_TYPE_IDS)[number]

export type WorkTypeStage =
  | 'iterate'
  | 'review'
  | 'plan'
  | 'scope'
  | 'verify'
  | 'discover'
  | 'triage'

export type WorkTypeEvidenceKey = keyof Evidence | 'triage'

export type WorkTypeAutoMerge = 'allow' | 'review' | 'never'

export interface WorkTypeDefinition {
  id: WorkTypeId
  label: { zh: string; en: string }
  allowedStages: readonly WorkTypeStage[]
  requiredEvidence: readonly WorkTypeEvidenceKey[]
  riskTier: 'T0' | 'T1' | 'T2' | 'T3'
  budgetCny: number
  autoMerge: WorkTypeAutoMerge
  producesPullRequest: boolean
}

const IMPLEMENTATION_STAGES: readonly WorkTypeStage[] = ['scope', 'plan', 'iterate', 'verify', 'review']

export const WORK_TYPES: Readonly<Record<WorkTypeId, WorkTypeDefinition>> = {
  iterate: {
    id: 'iterate',
    label: { zh: '迭代', en: 'Iterate' },
    allowedStages: [...IMPLEMENTATION_STAGES, 'discover'],
    requiredEvidence: ['scope', 'acceptance', 'testRed', 'testGreen'],
    riskTier: 'T2',
    budgetCny: 2,
    autoMerge: 'allow',
    producesPullRequest: true,
  },
  triage: {
    id: 'triage',
    label: { zh: '分诊', en: 'Triage' },
    allowedStages: ['triage'],
    requiredEvidence: ['triage'],
    riskTier: 'T0',
    budgetCny: 0.25,
    autoMerge: 'never',
    producesPullRequest: false,
  },
  dependency: {
    id: 'dependency',
    label: { zh: '依赖升级', en: 'Dependency' },
    allowedStages: IMPLEMENTATION_STAGES,
    requiredEvidence: ['scope', 'acceptance', 'tests', 'checks', 'rollback'],
    riskTier: 'T2',
    budgetCny: 1.5,
    autoMerge: 'review',
    producesPullRequest: true,
  },
  security: {
    id: 'security',
    label: { zh: '安全修复', en: 'Security' },
    allowedStages: IMPLEMENTATION_STAGES,
    requiredEvidence: ['scope', 'acceptance', 'testRed', 'testGreen', 'checks', 'rollback'],
    riskTier: 'T3',
    budgetCny: 2,
    autoMerge: 'never',
    producesPullRequest: true,
  },
  docs: {
    id: 'docs',
    label: { zh: '文档', en: 'Docs' },
    allowedStages: ['scope', 'plan', 'iterate', 'review'],
    requiredEvidence: ['scope', 'acceptance', 'tests'],
    riskTier: 'T0',
    budgetCny: 0.5,
    autoMerge: 'review',
    producesPullRequest: true,
  },
  performance: {
    id: 'performance',
    label: { zh: '性能', en: 'Performance' },
    allowedStages: IMPLEMENTATION_STAGES,
    requiredEvidence: ['scope', 'acceptance', 'testRed', 'testGreen', 'checks'],
    riskTier: 'T2',
    budgetCny: 2,
    autoMerge: 'review',
    producesPullRequest: true,
  },
  accessibility: {
    id: 'accessibility',
    label: { zh: '无障碍', en: 'Accessibility' },
    allowedStages: IMPLEMENTATION_STAGES,
    requiredEvidence: ['scope', 'acceptance', 'testRed', 'testGreen', 'checks'],
    riskTier: 'T1',
    budgetCny: 1,
    autoMerge: 'review',
    producesPullRequest: true,
  },
  migration: {
    id: 'migration',
    label: { zh: '迁移', en: 'Migration' },
    allowedStages: IMPLEMENTATION_STAGES,
    requiredEvidence: ['scope', 'acceptance', 'testRed', 'testGreen', 'checks', 'rollback'],
    riskTier: 'T3',
    budgetCny: 2,
    autoMerge: 'review',
    producesPullRequest: true,
  },
}

const STAGE_OF_KIND: Readonly<Record<string, WorkTypeId>> = {
  iterate: 'iterate',
  triage: 'triage',
  dependency: 'dependency',
  security: 'security',
  docs: 'docs',
  performance: 'performance',
  accessibility: 'accessibility',
  migration: 'migration',
  review: 'iterate',
  plan: 'iterate',
  scope: 'iterate',
  verify: 'iterate',
  discover: 'iterate',
}

export function resolveWorkType(value: unknown): WorkTypeDefinition | null {
  return typeof value === 'string' && (WORK_TYPE_IDS as readonly string[]).includes(value)
    ? WORK_TYPES[value as WorkTypeId]
    : null
}

export function defaultWorkTypeForKind(kind: string): string {
  return STAGE_OF_KIND[kind] ?? kind
}

export function stageAllowed(def: WorkTypeDefinition, kind: string): boolean {
  return (def.allowedStages as readonly string[]).includes(kind)
}

export function workTypeEvidenceState(
  def: WorkTypeDefinition,
  input: { evidence: Evidence | null; triage: TriageInput | null },
): 'verified' | 'unverified' {
  return missingWorkTypeEvidence(def, input).length === 0 ? 'verified' : 'unverified'
}

export function missingWorkTypeEvidence(
  def: WorkTypeDefinition,
  input: { evidence: Evidence | null; triage: TriageInput | null },
): string[] {
  const missing: string[] = []
  for (const key of def.requiredEvidence) {
    if (key === 'triage') {
      if (input.triage === null) missing.push(key)
      continue
    }
    if (input.evidence === null || input.evidence[key] === undefined) missing.push(key)
  }
  return missing
}

export function autoMergeDecision(id: WorkTypeId, options: { manual: boolean }): { ok: boolean; reason?: string } {
  const def = WORK_TYPES[id]
  if (!def.producesPullRequest) return { ok: false, reason: `${id} never produces a pull request` }
  if (options.manual) return { ok: true }
  if (def.autoMerge !== 'allow') return { ok: false, reason: `${id} requires human review` }
  return { ok: true }
}

export interface TriageIssue {
  url: string
  number?: number
  title: string
  body: string
  labels: string[]
}

export interface TriagePull {
  url: string
  number?: number
  title: string
  body: string
  head: string
  base: string
}

export interface TriageInput {
  issues: TriageIssue[]
  pulls: TriagePull[]
}

export interface TriageRankedItem {
  issueUrl: string
  number: number | null
  title: string
  priority: number
  labels: string[]
  inFlight: boolean
}

export interface TriageDuplicateLink {
  duplicateUrl: string
  canonicalUrl: string
}

export interface TriageProposal {
  ranked: TriageRankedItem[]
  duplicates: TriageDuplicateLink[]
  next: TriageRankedItem | null
  source: { issues: number; pulls: number }
}

const TRIAGE_ISSUE_LIMIT = 100
const TRIAGE_PULL_LIMIT = 100
const DUPLICATE_REFERENCE = /\b(?:duplicate|dup)\s+of\s+(?:#|https?:\/\/\S*?\/issues\/)(\d+)\b/i

function text(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, limit)
  return trimmed === '' ? null : trimmed
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'string') return []
    const label = entry.trim().slice(0, 60)
    return label === '' ? [] : [label]
  }).slice(0, 20)
}

function numberOrUrl(value: unknown, url: string): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  return issueNumberFromText(url) ?? undefined
}

function parseIssue(value: unknown): TriageIssue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const url = text(raw.url, 500)
  const title = text(raw.title, 200)
  if (url === null || title === null || !url.startsWith('https://')) return null
  const body = text(raw.body, 4000) ?? ''
  const number = numberOrUrl(raw.number, url)
  return { url, title, body, labels: labelsOf(raw.labels), ...(number === undefined ? {} : { number }) }
}

function parsePull(value: unknown): TriagePull | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const url = text(raw.url, 500)
  const title = text(raw.title, 200)
  if (url === null || title === null || !url.startsWith('https://')) return null
  const body = text(raw.body, 4000) ?? ''
  const head = text(raw.head, 300) ?? ''
  const base = text(raw.base, 300) ?? ''
  const number = numberOrUrl(raw.number, url)
  return { url, title, body, head, base, ...(number === undefined ? {} : { number }) }
}

export function parseTriageInput(value: unknown): TriageInput | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.issues)) return null
  const issues = raw.issues.slice(0, TRIAGE_ISSUE_LIMIT).flatMap((entry) => {
    const issue = parseIssue(entry)
    return issue === null ? [] : [issue]
  })
  const pulls = Array.isArray(raw.pulls)
    ? raw.pulls.slice(0, TRIAGE_PULL_LIMIT).flatMap((entry) => {
        const pull = parsePull(entry)
        return pull === null ? [] : [pull]
      })
    : []
  return { issues, pulls }
}

function normalizedTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function buildTriageProposal(input: TriageInput, repository: string): TriageProposal {
  const byNumber = new Map<number, TriageIssue>()
  for (const issue of input.issues) {
    if (issue.number !== undefined && !byNumber.has(issue.number)) byNumber.set(issue.number, issue)
  }
  const duplicateOf = new Map<string, string>()
  const linkDuplicate = (duplicate: TriageIssue, canonical: TriageIssue): void => {
    if (duplicate.url === canonical.url || duplicateOf.has(duplicate.url)) return
    duplicateOf.set(duplicate.url, canonical.url)
  }
  for (const issue of input.issues) {
    const match = DUPLICATE_REFERENCE.exec(`${issue.title}\n${issue.body}`)
    const number = match === null ? null : Number(match[1])
    if (number === null || !Number.isInteger(number)) continue
    const canonical = byNumber.get(number)
    if (canonical !== undefined) linkDuplicate(issue, canonical)
  }
  const groups = new Map<string, TriageIssue[]>()
  for (const issue of input.issues) {
    const key = normalizedTitle(issue.title)
    if (key === '') continue
    const group = groups.get(key) ?? []
    group.push(issue)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER))
    const canonical = ordered[0]
    if (canonical === undefined) continue
    for (const issue of ordered.slice(1)) linkDuplicate(issue, canonical)
  }
  const rootOf = (url: string): string => {
    let current = url
    const seen = new Set<string>()
    while (duplicateOf.has(current) && !seen.has(current)) {
      seen.add(current)
      current = duplicateOf.get(current) ?? current
    }
    return current
  }
  const duplicates: TriageDuplicateLink[] = [...duplicateOf.entries()].map(([duplicateUrl, canonicalUrl]) => ({
    duplicateUrl,
    canonicalUrl: rootOf(canonicalUrl),
  }))
  const canonicalIssues = input.issues.filter((issue) => !duplicateOf.has(issue.url))
  const ranked: TriageRankedItem[] = canonicalIssues.map((issue) => {
    const number = issue.number ?? issueNumberFromText(issue.url)
    const inFlight = number !== null && findDuplicatePullRequest(number, repository, input.pulls.map((pull) => ({ ...pull, number: pull.number ?? 0 }))) !== null
    return {
      issueUrl: issue.url,
      number,
      title: issue.title,
      priority: issuePriority(issue.labels),
      labels: issue.labels,
      inFlight,
    }
  }).sort((a, b) =>
    b.priority - a.priority
    || (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER)
    || a.title.localeCompare(b.title),
  )
  return {
    ranked,
    duplicates,
    next: ranked.find((item) => !item.inFlight) ?? null,
    source: { issues: input.issues.length, pulls: input.pulls.length },
  }
}

function proposalItem(value: unknown): TriageRankedItem | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const issueUrl = text(raw.issueUrl, 500)
  const title = text(raw.title, 200)
  if (issueUrl === null || title === null || !issueUrl.startsWith('https://')) return null
  const priority = typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : 0
  const number = typeof raw.number === 'number' && Number.isInteger(raw.number) && raw.number > 0 ? raw.number : null
  return {
    issueUrl,
    number,
    title,
    priority,
    labels: labelsOf(raw.labels),
    inFlight: raw.inFlight === true,
  }
}

export function parseTriageProposal(value: string | null): TriageProposal | null {
  if (value === null || value === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(value)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.ranked) || !Array.isArray(record.duplicates)) return null
  const ranked = record.ranked.flatMap((entry) => {
    const item = proposalItem(entry)
    return item === null ? [] : [item]
  })
  const duplicates = record.duplicates.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    const pair = entry as Record<string, unknown>
    const duplicateUrl = text(pair.duplicateUrl, 500)
    const canonicalUrl = text(pair.canonicalUrl, 500)
    return duplicateUrl === null || canonicalUrl === null || !duplicateUrl.startsWith('https://') || !canonicalUrl.startsWith('https://') ? [] : [{ duplicateUrl, canonicalUrl }]
  })
  const sourceRaw = record.source !== null && typeof record.source === 'object' && !Array.isArray(record.source)
    ? record.source as Record<string, unknown>
    : {}
  const source = {
    issues: typeof sourceRaw.issues === 'number' && Number.isFinite(sourceRaw.issues) ? sourceRaw.issues : 0,
    pulls: typeof sourceRaw.pulls === 'number' && Number.isFinite(sourceRaw.pulls) ? sourceRaw.pulls : 0,
  }
  const nextRaw = record.next
  const next = nextRaw === null || nextRaw === undefined ? null : proposalItem(nextRaw)
  return { ranked, duplicates, next, source }
}
