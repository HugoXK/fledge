import type { JobRow } from '../db.js'

export type FailureKind =
  | 'quota'
  | 'credential'
  | 'stage_evidence'
  | 'stalled'
  | 'timeout'
  | 'bridge'
  | 'review'
  | 'workflow'
  | 'github'
  | 'model'
  | 'unknown'

export type FailureAction = 'settings' | 'reauthorize' | 'retry' | 'repo' | 'refresh' | 'none'

export interface FailureInfo {
  kind: FailureKind
  label: [string, string]
  hint: [string, string]
  action: FailureAction
}

const FAILURES: Record<FailureKind, FailureInfo> = {
  quota: {
    kind: 'quota',
    label: ['平台额度不足', 'Platform quota exhausted'],
    hint: ['配置自己的模型 API，或等待额度恢复后重试。', 'Add your own model API, or retry after the quota is restored.'],
    action: 'settings',
  },
  credential: {
    kind: 'credential',
    label: ['GitHub 授权失效', 'GitHub authorization expired'],
    hint: ['重新授权这个仓库，然后重试。', 'Re-authorize the repository, then retry.'],
    action: 'reauthorize',
  },
  stage_evidence: {
    kind: 'stage_evidence',
    label: ['阶段证据不完整', 'Stage evidence incomplete'],
    hint: ['补齐范围、失败测试和通过测试证据后重试。', 'Add scope, failing-test and passing-test evidence, then retry.'],
    action: 'retry',
  },
  stalled: {
    kind: 'stalled',
    label: ['任务停滞', 'Job stalled'],
    hint: ['检查仓库的 FlyBot 实例和 bridge，然后重试。', 'Check the repository FlyBot instance and bridge, then retry.'],
    action: 'repo',
  },
  timeout: {
    kind: 'timeout',
    label: ['任务超时', 'Job timed out'],
    hint: ['缩小任务范围，或检查实例健康后重试。', 'Narrow the task scope, or check instance health and retry.'],
    action: 'retry',
  },
  bridge: {
    kind: 'bridge',
    label: ['FlyBot 实例不可用', 'FlyBot instance unavailable'],
    hint: ['启动或重启这个仓库的实例，然后重试。', 'Start or restart this repository instance, then retry.'],
    action: 'repo',
  },
  review: {
    kind: 'review',
    label: ['审核要求修改', 'Review requested changes'],
    hint: ['按审核意见在同一个分支修复，不要开第二个 PR。', 'Fix the same branch from the review findings; do not open a second PR.'],
    action: 'retry',
  },
  workflow: {
    kind: 'workflow',
    label: ['分支或上游状态冲突', 'Branch or upstream conflict'],
    hint: ['刷新仓库、同步 fork，或等当前任务结束后重试。', 'Refresh the repository, sync the fork, or wait for the active job to finish.'],
    action: 'refresh',
  },
  github: {
    kind: 'github',
    label: ['GitHub 操作失败', 'GitHub operation failed'],
    hint: ['检查仓库权限、PR 检查和分支保护后重试。', 'Check repository permission, PR checks and branch protection, then retry.'],
    action: 'repo',
  },
  model: {
    kind: 'model',
    label: ['模型调用失败', 'Model call failed'],
    hint: ['检查模型供应商连接，或切换这个仓库的模型后重试。', 'Check the model provider connection, or switch this repository model, then retry.'],
    action: 'settings',
  },
  unknown: {
    kind: 'unknown',
    label: ['任务失败', 'Job failed'],
    hint: ['查看技术详情，或重试一次。', 'Inspect the technical detail, or retry once.'],
    action: 'retry',
  },
}

const ORDER: FailureKind[] = ['quota', 'credential', 'stage_evidence', 'stalled', 'timeout', 'bridge', 'review', 'workflow', 'github', 'model', 'unknown']

// #231: the job service writes the failure sentence itself, so the text in
// `jobs.error` is in the writer's language. The stable vocabulary is the code the
// service already answers with (`REPO_CREDENTIAL_INVALID`, `JOB_ACTIVE`,
// `STAGE_EVIDENCE_MISSING`); persisting it beside the text lets the read path build
// the sentence in the reader's language. The regex classifier below stays for rows
// written before the column existed — a new failure never depends on it.
export const FAILURE_CODES = [
  'REPO_CREDENTIAL_INVALID',
  'JOB_STALLED',
  'JOB_LEASE_EXPIRED',
  'JOB_TIMEOUT',
  'QUOTA_EXHAUSTED',
  'JOB_BUDGET_EXCEEDED',
  'DUPLICATE_WORK',
  'STAGE_EVIDENCE_MISSING',
  'BRIDGE_ERROR',
  'REPO_DISABLED',
] as const

export type FailureCode = (typeof FAILURE_CODES)[number]

export const FAILURE_CODE_KIND: Record<FailureCode, FailureKind> = {
  REPO_CREDENTIAL_INVALID: 'credential',
  JOB_STALLED: 'stalled',
  JOB_LEASE_EXPIRED: 'stalled',
  JOB_TIMEOUT: 'timeout',
  QUOTA_EXHAUSTED: 'quota',
  JOB_BUDGET_EXCEEDED: 'quota',
  DUPLICATE_WORK: 'workflow',
  STAGE_EVIDENCE_MISSING: 'stage_evidence',
  BRIDGE_ERROR: 'bridge',
  REPO_DISABLED: 'workflow',
}

const FAILURE_SENTENCES: Record<FailureCode, [string, string]> = {
  REPO_CREDENTIAL_INVALID: ['GitHub token 权限不足，请重新授权这个仓库。', 'The GitHub token for this repository lacks permission; re-authorize the repository and retry.'],
  JOB_STALLED: ['任务停滞：长时间没有心跳，已被判定为停滞。', 'The job stalled: it stopped sending heartbeats.'],
  JOB_LEASE_EXPIRED: ['任务租约过期：worker 未续约。', 'The job lease expired: its worker stopped renewing it.'],
  JOB_TIMEOUT: ['任务超时：没有在时限内回报。', 'The job timed out: it did not report back before its deadline.'],
  QUOTA_EXHAUSTED: ['平台额度已用完，请在 Settings → Model 配置自己的模型 API 后重试。', 'The platform quota is used up; add your own model API in Settings → Model, then retry.'],
  JOB_BUDGET_EXCEEDED: ['任务成本超过这个仓库的单任务预算。', "The job cost more than this repository's single-job budget."],
  DUPLICATE_WORK: ['已有 PR 覆盖这个 issue。', 'A pull request already covers this issue.'],
  STAGE_EVIDENCE_MISSING: ['任务缺少阶段证据，已停止。', 'The job is missing stage evidence, so it stopped.'],
  BRIDGE_ERROR: ['FlyBot 实例不可用，任务无法启动。', 'The FlyBot instance for this repository is unavailable.'],
  REPO_DISABLED: ['这个仓库已停用。', 'This repository is disabled.'],
}

export function errorCodeOf(value: string | null | undefined): FailureCode | null {
  const code = String(value ?? '').trim()
  return (FAILURE_CODES as readonly string[]).includes(code) ? (code as FailureCode) : null
}

export function failureSentence(t: (zh: string, en: string) => string, code: string | null | undefined): string | null {
  const known = errorCodeOf(code)
  if (known === null) return null
  const sentence = FAILURE_SENTENCES[known]
  return t(sentence[0], sentence[1])
}

export function failureLabel(t: (zh: string, en: string) => string, kind: FailureKind | string): string {
  const info = FAILURES[kind as FailureKind] ?? FAILURES.unknown
  return t(info.label[0], info.label[1])
}

export function classifyFailure(job: Pick<JobRow, 'status' | 'error' | 'kind'> & { error_code?: string | null }): FailureInfo | null {
  if (job.status !== 'failed' && job.status !== 'quota_exhausted') return null
  const code = errorCodeOf(job.error_code)
  if (code !== null) return FAILURES[FAILURE_CODE_KIND[code]]
  const text = String(job.error ?? '').toLowerCase()
  if (/quota|额度|预算|budget|fledge_quota_exhausted/.test(text)) return FAILURES.quota
  if (/token|权限|credential|401|403|re-authoriz|authorization/.test(text)) return FAILURES.credential
  if (/stage_evidence_missing|阶段证据|缺少范围|缺少失败测试|缺少通过测试|缺少验收|缺少测试计划/.test(text)) return FAILURES.stage_evidence
  if (/停滞|心跳|no callback|stall/.test(text)) return FAILURES.stalled
  if (/timeout|timed out|超时/.test(text)) return FAILURES.timeout
  if (/bridge|instance|dsh|container|实例/.test(text)) return FAILURES.bridge
  if (/review|审核|changes requested/.test(text)) return FAILURES.review
  if (/branch|分支|fork|upstream|duplicate|job_active|已有任务|work item|排队|already finished|已结束/.test(text)) return FAILURES.workflow
  if (/github|rate limit|pull request|merge|webhook|pr /.test(text)) return FAILURES.github
  if (/model|provider|gateway|502|503|模型/.test(text)) return FAILURES.model
  return FAILURES.unknown
}

export function failureBreakdown(jobs: Array<Pick<JobRow, 'status' | 'error' | 'kind'> & { error_code?: string | null }>): Array<{ kind: FailureKind; count: number }> {
  const counts = new Map<FailureKind, number>()
  for (const job of jobs) {
    const info = classifyFailure(job)
    if (info === null) continue
    counts.set(info.kind, (counts.get(info.kind) ?? 0) + 1)
  }
  return ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({ kind, count: counts.get(kind) ?? 0 }))
}
