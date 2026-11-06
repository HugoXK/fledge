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

export function failureLabel(t: (zh: string, en: string) => string, kind: FailureKind | string): string {
  const info = FAILURES[kind as FailureKind] ?? FAILURES.unknown
  return t(info.label[0], info.label[1])
}

export function classifyFailure(job: Pick<JobRow, 'status' | 'error' | 'kind'>): FailureInfo | null {
  if (job.status !== 'failed' && job.status !== 'quota_exhausted') return null
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

export function failureBreakdown(jobs: Array<Pick<JobRow, 'status' | 'error' | 'kind'>>): Array<{ kind: FailureKind; count: number }> {
  const counts = new Map<FailureKind, number>()
  for (const job of jobs) {
    const info = classifyFailure(job)
    if (info === null) continue
    counts.set(info.kind, (counts.get(info.kind) ?? 0) + 1)
  }
  return ORDER.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => ({ kind, count: counts.get(kind) ?? 0 }))
}
