import type { Attribution } from './attribution.js'
import type { Evidence } from './evidence.js'

export type StageMode = 'off' | 'shadow' | 'enforced'

export const STAGE_MODES: readonly StageMode[] = ['off', 'shadow', 'enforced']

export function parseStageMode(value: unknown): StageMode | null {
  return typeof value === 'string' && (STAGE_MODES as readonly string[]).includes(value) ? (value as StageMode) : null
}

export interface StageCheck {
  ok: boolean
  errors: string[]
}

const DEV = /dev/i
const TEST = /test/i
const REVIEWER = /review/i

function roleMatches(value: string | undefined, pattern: RegExp): boolean {
  return value !== undefined && pattern.test(value)
}

export function checkStage(
  mode: StageMode,
  kind: string,
  evidence: Evidence | null,
  attribution: Attribution | null,
  reviewScore?: number,
): StageCheck {
  if (mode === 'off' || kind === 'plan') return { ok: true, errors: [] }
  const errors: string[] = []
  if (kind === 'scope') {
    if (evidence?.scope === undefined) errors.push('缺少范围（evidence.scope）')
    if (evidence?.acceptance === undefined) errors.push('缺少验收标准（evidence.acceptance）')
    if (evidence?.testPlan === undefined) errors.push('缺少测试计划（evidence.testPlan）')
    if (!roleMatches(attribution?.writtenBy, /product/i) && !roleMatches(attribution?.claimedBy, /product/i)) errors.push('范围必须由 Product 产出')
  }
  if (kind === 'verify') {
    if (evidence?.testRed === undefined) errors.push('缺少失败测试证据（evidence.testRed）')
    if (evidence?.testGreen === undefined) errors.push('缺少通过测试证据（evidence.testGreen）')
    if (!roleMatches(attribution?.testedBy, TEST)) errors.push('验证必须由 Test 执行（attribution.testedBy）')
  }
  if (kind === 'iterate') {
    if (evidence?.scope === undefined) errors.push('缺少范围证据（evidence.scope）')
    if (evidence?.acceptance === undefined) errors.push('缺少验收标准（evidence.acceptance）')
    if (evidence?.testRed === undefined) errors.push('缺少失败测试证据（evidence.testRed）')
    if (evidence?.testGreen === undefined) errors.push('缺少通过测试证据（evidence.testGreen）')
    if (!roleMatches(attribution?.implementedBy, DEV)) errors.push('实现角色必须是 Dev-1/Dev-2（attribution.implementedBy）')
    if (!roleMatches(attribution?.testedBy, TEST)) errors.push('测试角色必须是 Test（attribution.testedBy）')
  }
  if (kind === 'review') {
    if (!roleMatches(attribution?.reviewedBy, REVIEWER)) errors.push('审核角色必须是 Reviewer（attribution.reviewedBy）')
    if (reviewScore === undefined) errors.push('审核任务必须有 0-100 的 reviewScore')
  }
  return { ok: errors.length === 0, errors }
}
