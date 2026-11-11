import type { JobRow } from '../db.js'
import { localizeMessage, translator, type Locale } from '../i18n.js'

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
  'PROVIDER_BUDGET_EXCEEDED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_CALL_NEVER_STARTED',
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
  // #260: the provider refused the model call inside the instance. It reaches
  // Fledge either as the DSH send error (relayed by the bridge) or as a role
  // session that ended with zero model calls; neither is a bridge outage, and
  // neither is retried as a transient stall.
  PROVIDER_BUDGET_EXCEEDED: 'quota',
  PROVIDER_RATE_LIMITED: 'quota',
  PROVIDER_CALL_NEVER_STARTED: 'model',
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
  PROVIDER_BUDGET_EXCEEDED: ['模型供应商拒绝了这次调用：实例的 DSH 预算已用完。请检查供应商额度，或配置自己的模型 API 后重试。', 'The model provider refused the call: the DSH budget of the instance is used up. Check the provider quota, or add your own model API, then retry.'],
  PROVIDER_RATE_LIMITED: ['模型供应商限流，拒绝了这次调用（剩余额度 0）。请等限流恢复，或配置自己的模型 API 后重试。', 'The model provider rate-limited the call (remaining quota 0). Wait for the limit to reset, or add your own model API, then retry.'],
  PROVIDER_CALL_NEVER_STARTED: ['实例里的会话在派发后没有发起任何模型调用：供应商额度或限流拒绝了这次调用。请检查 DSH 的供应商额度/密钥，或配置自己的模型 API 后重试。', 'The instance session made no model call after the job was dispatched: the provider budget or rate limit refused it. Check the DSH provider quota/key, or add your own model API, then retry.'],
}

// The parameterised form of a failure sentence, used only when the refusal
// carries the value. `DUPLICATE_WORK` names the pull request that already covers
// the issue; the plain entry above stays the sentence for a row that carries no
// parameter, which is the shape every writer produces today.
const DETAIL_SENTENCES: Partial<Record<FailureCode, [string, string]>> = {
  DUPLICATE_WORK: ['已有 PR 覆盖这个 issue：{detail}', 'A pull request already covers this issue: {detail}'],
}

// The enqueue path refuses before a job row exists, so its answer never reaches
// `jobs.error_code`; the route carries the code on the redirect instead and the
// banner builds the sentence from it. These are the refusals that can reach a
// banner. The credential refusal reuses its failure sentence above, so it is not
// repeated here. `BRANCH_MISSING` carries the branch after a colon, and a git ref
// can never contain one, so `BRANCH_MISSING:main` is one unambiguous value.
const REFUSAL_SENTENCES: Record<string, [string, string]> = {
  REPO_BUDGET_EXHAUSTED: ['仓库月度预算已用完，请在仓库设置里提高预算，或等下个月再试。', "This repository's monthly budget is used up; raise it in the repository settings or wait for the next month, then retry."],
  QUEUE_FULL: ['任务队列已满，请稍后再试。', 'The job queue is full; retry in a moment.'],
  QUEUE_LIMIT: ['你排队的任务过多，请等其中几个结束后再试。', 'You have too many jobs queued; wait for some of them to finish, then retry.'],
  JOB_LIMIT: ['平台同时运行的任务数已达上限（{detail} 个），请稍后再试。', 'The platform already has {detail} jobs running at once; retry in a moment.'],
  BOT_MODEL_ASSIGNMENT_FAILED: ['机器人模型未就绪：{detail}；请在仓库设置里重新应用模型。', 'The bot models are not ready: {detail}; re-apply the models in the repository settings.'],
  BRANCH_MISSING: ['目标分支 {branch} 不存在或不可访问。', 'The target branch {branch} does not exist, or this account cannot read it.'],
  // #174: already-fixed work is refused with its own code, so the banner says the
  // fix is in rather than that someone else is still working on it. Like every
  // refusal here it never reaches `jobs.error_code` — the enqueue path refuses
  // before a job row exists.
  ALREADY_FIXED: ['这个 issue 的修复已经合入上游：{detail}', 'The fix for this issue is already merged upstream: {detail}'],
  // #283: the platform stop outranks every other refusal, so its sentence has to
  // read as an operator decision rather than as a problem the reader caused.
  PLATFORM_PAUSED: ['平台已紧急停止，暂不接受新任务；等管理员恢复后再试。', 'The platform is stopped for an emergency, so no new job is accepted; retry once an admin resumes it.'],
}

const BRANCH_EMPTY: [string, string] = ['目标分支不存在或不可访问。', 'The target branch does not exist, or this account cannot read it.']

export function errorCodeOf(value: string | null | undefined): FailureCode | null {
  const code = String(value ?? '').trim()
  return (FAILURE_CODES as readonly string[]).includes(code) ? (code as FailureCode) : null
}

export function failureSentence(t: (zh: string, en: string) => string, code: string | null | undefined, detail = ''): string | null {
  const known = errorCodeOf(code)
  if (known !== null) {
    // A sentence that names something only the writer knows (the pull request
    // that already covers the issue) exists in two forms: the plain one below,
    // for a row that carries no parameter, and the parameterised one here, for a
    // refusal that does. Base kept the URL by re-deriving it inside the
    // dictionary; authoring it as `{detail}` is the same sentence built from the
    // value the service already had. The known-code branch returns before
    // `REFUSAL_SENTENCES`' empty-parameter guard, so the plain entry must stay
    // the default: a parameterised sentence with no parameter would print the
    // placeholder itself on a `jobs.error_code` row.
    const value = String(detail ?? '').trim()
    const parameterised = DETAIL_SENTENCES[known]
    if (parameterised !== undefined && value !== '') {
      return t(parameterised[0].replace('{detail}', value), parameterised[1].replace('{detail}', value))
    }
    return t(FAILURE_SENTENCES[known][0], FAILURE_SENTENCES[known][1])
  }
  const refusal = REFUSAL_SENTENCES[String(code ?? '').trim()]
  if (refusal === undefined) return null
  const value = String(detail ?? '').trim()
  if (refusal[0].includes('{branch}') && value === '') return t(BRANCH_EMPTY[0], BRANCH_EMPTY[1])
  // A parameterised sentence without its parameter says nothing useful; returning
  // null lets the banner fall through to the text the service wrote.
  if (refusal[0].includes('{detail}') && value === '') return null
  const fill = (text: string): string => text.replace('{branch}', value).replace('{detail}', value)
  return t(fill(refusal[0]), fill(refusal[1]))
}

// The banner is built in this order, so a refusal is never worse than base:
//   1. a code with a sentence entry gets that sentence in the reader's language,
//      with its parameter (`BRANCH_MISSING:main`, `JOB_LIMIT:2`) filled in;
//   2. a value that is not a code is left to `layout`'s dictionary call;
//   3. a code with no sentence keeps the writer's text that travelled after the
//      colon, translated by the same dictionary the banner used before #231;
//   4. only a bare code with neither a sentence nor a text names itself.
const CODE_VALUE = /^[A-Z][A-Z0-9_]+$/

export function failureBannerSentence(locale: Locale, value: string | null | undefined): string | null {
  const raw = String(value ?? '')
  const separator = raw.indexOf(':')
  const code = separator === -1 ? raw : raw.slice(0, separator)
  const detail = separator === -1 ? '' : raw.slice(separator + 1)
  if (!CODE_VALUE.test(code)) return null
  const t = translator(locale)
  const sentence = failureSentence(t, code, detail)
  if (sentence !== null) return sentence
  if (detail !== '') return localizeMessage(locale, detail) ?? null
  return t(`任务未能开始（${code}）。`, `The job could not start (${code}).`)
}

// #260: the dispatch path must name the provider refusal, not fold it into
// BRIDGE_ERROR. This reads the message the bridge relayed (the DSH send error or
// the DSH answer to it) and answers with the code, so `jobs.error_code` carries
// the category to the retry policy and the job page.
export function providerRefusalCode(text: string | null | undefined): FailureCode | null {
  const value = String(text ?? '').toLowerCase()
  if (value === '') return null
  if (/budget has been exceeded|budget_exceeded|max budget|current cost:/.test(value)) return 'PROVIDER_BUDGET_EXCEEDED'
  if (/rate limit exceeded|remaining:\s*0|too many requests/.test(value)) return 'PROVIDER_RATE_LIMITED'
  return null
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
  // #231 review/Node 24: `src/jobs/flybot.ts` writes "FlyBot bridge unreachable
  // (<endpoint>): <cause>". The cause is the runtime's text and Node 22 and 24
  // word one refused fetch differently - the 24 wording carries a credential word
  // and used to win the first matching pattern below, so a transport failure was
  // reported as an authorization problem. Our marker is the observable fact, so it
  // decides before the vocabulary does.
  if (/bridge unreachable/.test(text)) return FAILURES.bridge
  // #260: DSH refuses a turn with "Budget has been exceeded! Current cost: ..."
  // or "Rate limit exceeded ... Remaining: 0". The second wording used to fall
  // through to the GitHub pattern ("rate limit"), i.e. a transitory category that
  // earned two blind retries, so the provider vocabulary decides before it.
  if (/quota|额度|预算|budget|fledge_quota_exhausted|current cost:|remaining:\s*0/.test(text)) return FAILURES.quota
  // `401|403` used to be unanchored against the whole sentence, and that sentence
  // carries the bridge endpoint: an ephemeral port such as 127.0.0.1:40100 made a
  // dead bridge read as "GitHub authorization expired". Only a real status code
  // matches now.
  if (/token|权限|credential|(?<!\d)40[13](?!\d)|re-authoriz|authorization/.test(text)) return FAILURES.credential
  if (/stage_evidence_missing|阶段证据|缺少范围|缺少失败测试|缺少通过测试|缺少验收|缺少测试计划/.test(text)) return FAILURES.stage_evidence
  if (/停滞|心跳|no callback|stall/.test(text)) return FAILURES.stalled
  // #163: a dispatch that timed out at the bridge is an instance problem, not a
  // task that ran too long, and its message carries the preserved transport cause
  // (the word "timeout" included), so the bridge pattern has to win here.
  if (/bridge|instance|dsh|container|实例/.test(text)) return FAILURES.bridge
  if (/timeout|timed out|超时/.test(text)) return FAILURES.timeout
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
