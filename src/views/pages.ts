import type { Config } from '../config.js'
import type { AlertView, AuditRow, DeploymentRollbackRow, DeploymentRow, JobEventRow, JobRow, ModelProviderRow, NotificationRow, OwnedSearch, PostmortemRecurrenceRow, PostmortemRow, ProviderModelRow, RepoInstanceRow, RepoRow, ReviewTrendWindow, SessionRow, UserRow, ApiTokenRow, WorkflowFailureRow, WorkItemRow } from '../db.js'
import { redactCommand, type DriftAssessment, type EnvironmentCurrent, type ReleaseSnapshot } from '../lib/deployments.js'
import { agreementContent } from '../users/agreements.js'
import { quotaView } from '../gateway/quota.js'
import { humanTimeShort } from '../lib/time.js'
import { nextRun, type NextRun } from '../lib/nextRun.js'
import { aheadOfViewer, queueRanks, rankQueued, type QueueRank } from '../lib/queueRank.js'
import { ITERATION_INTERVALS, REVIEW_INTERVALS, intervalLabel, normalizeInterval } from '../lib/intervals.js'
import { escapeHtml, layout, money, quotaMoney, type Viewer } from './layout.js'
import { renderState, stateCell, type StateAction } from './states.js'
import { redact } from '../lib/secrets.js'
import { REVIEW_INSTRUCTION_LABEL, reviewInstructionFromGoal } from '../lib/followUpInstruction.js'
import { firstRunOutcome, setupChecklist, type SetupState, type SetupStepKey } from './checklist.js'
import { oauthConfigured, tokenLoginEnabled } from '../auth/login.js'
import { allowedRepoRoles, REPO_ROLE_LABELS, type RepoRole } from '../lib/repoRole.js'
import { WORK_ITEM_STATES, WORK_ITEM_TRANSITIONS, workItemStateLabel, type WorkItemState } from '../lib/workItems.js'
import { PAT_EXPIRY_CHOICES } from '../lib/tokens.js'
import { ATTRIBUTION_FIELDS, attributionJourney, parseAttributionJson } from '../lib/attribution.js'
import { parseEvidenceJson } from '../lib/evidence.js'
import { contractOf, resolveWorkType, workTypeLabel, workTypePurpose } from '../lib/workTypes.js'
import { parseTriageJson, triageSummaryLine } from '../lib/triage.js'
import { parseModelRun } from '../lib/modelRun.js'
import { mergeReadiness, parsePathGuard, parseVerification } from '../lib/verification.js'
import { parseAdversarialRecord, type AdversarialRecord } from '../lib/adversarialReview.js'
import { releaseSurface, type ReleaseSurface } from '../lib/releaseSurface.js'
import { compareRunning, type ReleaseStatusSnapshot } from '../lib/releaseStatus.js'
import { readBackupStatus, SHA256_MAX_BYTES, type BackupCopyStatus, type BackupStatus } from '../lib/backupStatus.js'
import { classifyFailure, failureLabel, failureSentence, type FailureAction, type FailureKind } from '../lib/failure.js'
import { filterTrials, trialCounts, trialStateOf, TRIAL_DAYS, type TrialCandidateSource, type TrialFilter } from '../lib/trials.js'
import { STAGE_MODES } from '../lib/stages.js'
import { JOB_FILTER_KINDS, JOB_FILTER_STATUSES, jobFilterIsActive, jobFilterLabels, jobFilterParams, kindFilterLabel, statusFilterLabel, type JobFilter } from '../lib/jobFilters.js'
import type { InstallationRepo } from '../repos/app.js'
import { localizeMessage, localizeNotification, translator, type Locale, type Translate } from '../i18n.js'
import { parseTeam, type TeamLiveState, type TeamQuestionState } from '../flybot/instances.js'
import type { ChiefMessage } from '../lib/chiefTranscript.js'
import type { PlatformStopRecord } from '../jobs/service.js'

export interface InboxQuestion extends TeamQuestionState {
  repoId: string
  repoLabel: string
}

function advancedViewer(viewer: Viewer): boolean {
  return viewer.user.role === 'superadmin' && viewer.preview !== true
}

function csrf(viewer: Viewer): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(viewer.csrfToken)}" />`
}

function infoTip(text: string): string {
  return `<button type="button" class="info-tip" aria-label="${escapeHtml(text)}" aria-expanded="false" data-tip="${escapeHtml(text)}">!</button>`
}

function recurrenceRepositories(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function preventiveActionHtml(value: string | null): string {
  if (value === null || value === '') return '—'
  return /^https?:\/\//.test(value)
    ? `<a href="${escapeHtml(value)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a>`
    : `<code>${escapeHtml(value)}</code>`
}

// Counts on the path-guard line are read as plain numbers in both languages.
function formatCount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
}

function durationText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

function jobEventDetail(t: Translate, event: JobEventRow): string {
  if (event.kind === 'team.role' && event.meta !== null) {
    try {
      const parsed = JSON.parse(event.meta) as { calls?: unknown; tool?: unknown; activity?: unknown }
      const calls = typeof parsed.calls === 'number' ? parsed.calls : null
      const tool = typeof parsed.tool === 'string' && parsed.tool !== '' ? parsed.tool : ''
      const activity = typeof parsed.activity === 'string' && parsed.activity !== '' ? parsed.activity : ''
      const bits = [calls === null ? '' : t(`${calls} 次调用`, `${calls} calls`), tool, activity].filter((value) => value !== '')
      if (bits.length > 0) return bits.join(' · ')
    } catch {}
  }
  return (event.meta ?? '—').slice(0, 240)
}

function alertText(t: Translate, alert: AlertView): string {
  switch (alert.kind) {
    case 'job_stalled':
      return t(`任务 ${alert.jobId ?? ''} 已 ${alert.minutes ?? '?'} 分钟没有回调，可能已卡住`, `Job ${alert.jobId ?? ''} has not called back for ${alert.minutes ?? '?'} minutes and may be stuck`)
    case 'job_slow':
      return t(`任务 ${alert.jobId ?? ''} 已 ${alert.minutes ?? '?'} 分钟没有回调`, `Job ${alert.jobId ?? ''} has not called back for ${alert.minutes ?? '?'} minutes`)
    case 'pr_stale':
      return t(`PR 已打开 ${alert.hours ?? '?'} 小时`, `PR has been open for ${alert.hours ?? '?'} hours`)
    case 'credential_invalid':
      return t(`GitHub 凭据状态：${alert.state ?? 'unknown'}`, `GitHub credential state: ${alert.state ?? 'unknown'}`)
    case 'budget_near_limit':
      return t(
        `30 天已用 ${quotaMoney(alert.spentCny ?? 0)} / ${quotaMoney(alert.budgetCny ?? 0)}`,
        `spent ${quotaMoney(alert.spentCny ?? 0)} of ${quotaMoney(alert.budgetCny ?? 0)} in 30 days`,
      )
    default:
      return alert.message
  }
}

function alertHref(alert: AlertView): string {
  if (alert.repoId !== undefined && alert.jobId !== undefined) return `/repos/${alert.repoId}/jobs/${alert.jobId}`
  if (alert.repoId !== undefined) return `/repos/${alert.repoId}`
  return ''
}

function alertRows(t: Translate, alerts: AlertView[]): string {
  return alerts.map((alert) => {
    const href = alertHref(alert)
    const level = alert.level === 'critical' ? t('严重', 'Critical') : alert.level === 'warning' ? t('警告', 'Warning') : t('提示', 'Info')
    const link = alert.prUrl !== undefined
      ? `<a class="link" href="${escapeHtml(alert.prUrl)}" target="_blank" rel="noreferrer">PR</a>`
      : href === '' ? '' : `<a class="link" href="${escapeHtml(href)}">${escapeHtml(t('打开', 'Open'))}</a>`
    return `<tr><td><span class="badge ${alert.level === 'critical' ? 'bad' : alert.level === 'warning' ? 'busy' : ''}">${escapeHtml(level)}</span></td><td>${escapeHtml(alert.kind)}</td><td>${escapeHtml(alert.repoLabel ?? '')}${alert.repoLabel === undefined || alert.repoLabel === '' ? '' : ' · '}${escapeHtml(alertText(t, alert))}</td><td>${link}</td></tr>`
  }).join('')
}

function failureHref(action: FailureAction, repoId: string): string {
  if (action === 'reauthorize') return `/auth/github/reauthorize?next=${encodeURIComponent(`/repos/${repoId}`)}`
  if (action === 'settings') return '/settings'
  if (action === 'repo' || action === 'refresh') return `/repos/${repoId}`
  return ''
}

function failureActionLabel(t: Translate, action: FailureAction): string {
  if (action === 'reauthorize') return t('重新授权', 'Re-authorize')
  if (action === 'settings') return t('打开设置', 'Open settings')
  if (action === 'repo') return t('打开仓库', 'Open repository')
  if (action === 'refresh') return t('刷新仓库', 'Refresh repository')
  return ''
}

function readinessLabel(t: Translate, state: 'ready' | 'blocked' | 'unknown'): string {
  if (state === 'ready') return t('可合并', 'Ready')
  if (state === 'blocked') return t('被阻止', 'Blocked')
  return t('未核实', 'Not verified')
}

function readinessBadge(t: Translate, state: 'ready' | 'blocked' | 'unknown'): string {
  const cls = state === 'ready' ? 'good' : state === 'blocked' ? 'bad' : 'busy'
  return `<span class="badge ${cls}">${escapeHtml(readinessLabel(t, state))}</span>`
}

function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  return `${local.slice(0, 1)}***@${domain}`
}

// #356: a session row is recognisable without handing out the address. The last
// IPv4 octet and everything past the second IPv6 group are dropped, so a user can
// tell their own sessions apart but the page never carries a full address.
function maskIp(ip: string | null): string {
  if (ip === null || ip === '') return '—'
  if (ip.includes(':')) {
    const groups = ip.split(':').filter((group) => group !== '')
    return `${groups.slice(0, 2).join(':')}::`
  }
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0` : ip
}

function agreementHtml(text: string): string {
  return text
    .split(/\n\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function statusLabel(t: Translate, status: string): string {
  const labels: Record<string, string> = {
    succeeded: t('成功', 'Succeeded'),
    failed: t('失败', 'Failed'),
    running: t('运行中', 'Running'),
    queued: t('排队中', 'Queued'),
    approved: t('已批准', 'Approved'),
    rejected: t('已拒绝', 'Rejected'),
    pending: t('待审批', 'Pending'),
    onboarding: t('待申请', 'Onboarding'),
    idle: t('空闲', 'Idle'),
    quota_exhausted: t('额度用完', 'Quota exhausted'),
    paused: t('已暂停', 'Paused'),
    cancelled: t('已取消', 'Cancelled'),
    ready: t('就绪', 'Ready'),
    starting: t('启动中', 'Starting'),
    provisioning: t('初始化中', 'Provisioning'),
    stopped: t('已停止', 'Stopped'),
    starting_container: t('启动容器', 'Starting container'),
  }
  return labels[status] ?? status
}

// A webhook delivery stores its state as an internal code. The console names the
// three states in the reader's language and keeps the code only as the filter
// value, so `/admin/webhooks?status=` links keep filtering exactly as before.
function deliveryStatusLabel(t: Translate, status: string): string {
  const labels: Record<string, string> = {
    processing: t('处理中', 'Processing'),
    processed: t('已处理', 'Processed'),
    failed: t('失败', 'Failed'),
  }
  return labels[status] ?? status
}

function badge(t: Translate, status: string): string {
  const cls = status === 'succeeded' || status === 'approved' ? 'badge good' : status === 'failed' || status === 'rejected' || status === 'quota_exhausted' ? 'badge bad' : status === 'running' || status === 'queued' || status === 'pending' ? 'badge busy' : 'badge'
  return `<span class="${cls}">${escapeHtml(statusLabel(t, status))}</span>`
}

function triggerLabel(t: Translate, trigger: string): string {
  if (trigger === 'manual') return t('手动', 'Manual')
  if (trigger === 'schedule') return t('定时', 'Scheduled')
  if (trigger === 'followup') return t('跟进', 'Follow-up')
  return trigger
}

function repoRoleLabel(t: Translate, role: string | null): string {
  if (role === 'maintainer' || role === 'developer') {
    const [zh, en] = REPO_ROLE_LABELS[role]
    return t(zh, en)
  }
  return t('未选择', 'Not selected')
}

function roleLabel(t: Translate, role: string): string {
  if (role === 'superadmin') return t('超级管理员', 'Super admin')
  if (role === 'admin') return t('管理员', 'Admin')
  if (role === 'user') return t('用户', 'User')
  return role
}

function permissionLabel(t: Translate, permission: string): string {
  const labels: Record<string, [string, string]> = {
    admin: ['管理员', 'Admin'],
    maintain: ['维护者', 'Maintainer'],
    write: ['写入', 'Write'],
    triage: ['分诊', 'Triage'],
    read: ['只读', 'Read'],
    none: ['无', 'None'],
  }
  const value = labels[permission]
  return value === undefined ? permission : t(value[0], value[1])
}

const DISCOVERY_INTERVALS = ITERATION_INTERVALS.filter((value) => value >= 60)

function intervalOptions(t: Translate, selected = 1440, values = ITERATION_INTERVALS): string {
  const current = normalizeInterval(selected)
  const list = values.includes(current) ? values : [...values, current].sort((a, b) => a - b)
  return list
    .map((value) => `<option value="${value}"${value === current ? ' selected' : ''}>${escapeHtml(intervalLabel(value, t))}</option>`)
    .join('')
}

function reviewIntervalOptions(t: Translate, selected = 1440): string {
  return intervalOptions(t, selected, REVIEW_INTERVALS)
}


function goalTemplateSelect(t: Translate, target: string): string {
  return `<label>${escapeHtml(t('任务模板', 'Task template'))}
    <select data-goal-template data-goal-target="${escapeHtml(target)}">
      <option value="">${escapeHtml(t('选择一个模板…', 'Choose a template…'))}</option>
      <option value="bug" data-text="Reproduce one concrete, user-visible bug. Write a failing test first, make the smallest correct fix, run the relevant tests, and open one PR. Do not refactor unrelated code.">${escapeHtml(t('修一个可复现 bug', 'Fix a reproducible bug'))}</option>
      <option value="tests" data-text="Add focused tests for one existing module's highest-risk failure path. Write the failing test first, then the smallest fix or test-only change, and open one PR.">${escapeHtml(t('补关键测试', 'Add focused tests'))}</option>
      <option value="docs" data-text="Fix one place where the docs or comments disagree with the code. Verify the code first, make the smallest documentation change, and open one PR. Do not add unproven features.">${escapeHtml(t('修正文档/注释', 'Fix docs or comments'))}</option>
      <option value="deps" data-text="Check one dependency for a real security or compatibility issue. Make the smallest safe upgrade, run the existing tests, record pass/fail, and open one PR. Do not upgrade unrelated packages.">${escapeHtml(t('处理一个依赖问题', 'Handle one dependency issue'))}</option>
    </select>
  </label>`
}

function jobKindLabel(t: Translate, job: { kind: string }): string {
  // #568: the chain used to fall through to 迭代 / Iterate for a kind it did not
  // name, and `scope` and `verify` were missing, so two real kinds read as a
  // third. One label table (`KIND_LABELS` in `lib/jobFilters.ts`) is the source;
  // `research` stays here only for a row written before the type dropped it.
  if (job.kind === 'research') return t('分析', 'Research')
  return kindFilterLabel(t, job.kind)
}

function jobLinks(job: JobRow): string {
  const links = [
    job.pr_url === null ? '' : `<a href="${escapeHtml(job.pr_url)}" target="_blank" rel="noreferrer">PR</a>`,
    job.issue_url === null ? '' : `<a href="${escapeHtml(job.issue_url)}" target="_blank" rel="noreferrer">Issue</a>`,
  ].filter((link) => link !== '')
  return links.length === 0 ? '—' : links.join(' · ')
}

function jobSummary(locale: Locale, t: Translate, job: JobRow): string {
  // #231: the failure code decides the sentence; the dictionary stays for a row
  // that carries no code (a job written before the column, or a free-text summary).
  const byCode = job.summary === null || job.summary.trim() === '' ? failureSentence(t, job.error_code) : null
  // #458: the row is written through the redactor, but a row stored before that
  // change still holds the raw text, so the render pass is the second line of
  // defence. Every summary cell and the job page go through this function.
  const raw = redact((byCode ?? localizeMessage(locale, (job.summary ?? job.error ?? '').trim()) ?? '').trim())
  const cost = job.cost_usd > 0 ? ` · $${job.cost_usd.toFixed(4)}` : ''
  if (job.kind === 'review') {
    const score = job.review_score === null ? '' : ` · ${job.review_score}/100`
    const meaningful = raw !== '' && raw !== 'probe' && raw.length >= 12
    return meaningful ? `${raw}${score}${cost}` : `${t('审核完成', 'Review completed')}${score}${cost}`
  }
  if (raw === '' || raw === 'probe' || raw.length < 8) {
    if (job.status === 'succeeded') return `${job.kind === 'research' ? t('分析完成', 'Research completed') : t('任务完成', 'Job completed')}${cost}`
    if (job.status === 'failed') return `${job.kind === 'research' ? t('分析失败', 'Research failed') : t('任务失败', 'Job failed')}${cost}`
    if (job.status === 'paused') return `${t('已暂停', 'Paused')}${cost}`
    if (job.status === 'cancelled') return `${t('已取消', 'Cancelled')}${cost}`
    return '—'
  }
  return `${raw}${cost}`
}

function jobTeamStats(job: JobRow): Array<{ role: string; label: string; calls: number; activity: string; tool: string; step: string; lastActivityAt: number | null }> | null {
  if (job.team_stats_json === null) return null
  try {
    const parsed = JSON.parse(job.team_stats_json) as Array<Record<string, unknown>>
    if (!Array.isArray(parsed)) return null
    return parsed.filter((entry) => typeof entry.role === 'string').map((entry) => ({
      role: String(entry.role),
      label: typeof entry.label === 'string' ? entry.label : String(entry.role),
      calls: typeof entry.calls === 'number' ? entry.calls : 0,
      activity: typeof entry.activity === 'string' ? entry.activity : 'idle',
      tool: typeof entry.tool === 'string' ? entry.tool : '',
      step: typeof entry.step === 'string' ? entry.step : '',
      lastActivityAt: typeof entry.lastActivityAt === 'number' ? entry.lastActivityAt : null,
    }))
  } catch {
    return null
  }
}

function jobAttribution(t: Translate, job: JobRow): string {
  return attributionJourney(parseAttributionJson(job.attribution_json))
    .map(({ role, keys }) => {
      const labels = keys.map((key) => {
        const field = ATTRIBUTION_FIELDS.find((entry) => entry.key === key)
        return field === undefined ? key : t(field.zh, field.en)
      })
      return `${role} ${labels.join(' + ')}`
    })
    .join(' · ')
}

function jobPlainSummary(locale: Locale, t: Translate, job: JobRow, max = 160): { full: string; short: string } {
  const full = jobSummary(locale, t, job)
  return { full, short: full.length > max ? `${full.slice(0, max)}…` : full }
}

/** What an empty job list says; the action belongs to the page that renders it. */
interface EmptyJobs {
  title?: string
  body: string
  action?: StateAction
}

function jobRows(locale: Locale, jobs: JobRow[], empty?: EmptyJobs, ranks?: Map<string, QueueRank>): string {
  const t = translator(locale)
  if (jobs.length === 0) return stateCell(4, { kind: 'empty', title: empty?.title ?? t('还没有任务。', 'No jobs yet.'), body: empty === undefined ? t('添加仓库并选择角色后运行一次；每个任务只开一个 PR。', 'Add a repository, choose a role and run one job; each job opens at most one pull request.') : empty.body, action: empty?.action ?? { href: '/dashboard#add-repo', label: t('添加仓库', 'Add repository') } })
  return jobs
    .map((job) => {
      const summary = jobPlainSummary(locale, t, job)
      const attribution = jobAttribution(t, job)
      const rank = job.status === 'queued' ? ranks?.get(job.id) : undefined
      return `<tr data-job-id="${escapeHtml(job.id)}">
        <td class="job-cell" data-label="${escapeHtml(t('任务', 'Job'))}">
          <a href="/repos/${escapeHtml(job.repo_id)}/jobs/${escapeHtml(job.id)}"><code>${escapeHtml(job.id)}</code></a> <span class="badge kind">${escapeHtml(jobKindLabel(t, job))}</span>
          <small class="job-meta">${escapeHtml(triggerLabel(t, job.trigger))} · ${escapeHtml(humanTimeShort(job.created_at))}</small>${rank === undefined ? '' : `<small class="job-meta" title="${escapeHtml(t('队列位置按优先级、再按到达顺序', 'queue position by priority, then arrival'))}" data-queue-rank>#${rank.position}/${rank.total} · P${job.priority}</small>`}
        </td>
        <td data-job-status data-label="${escapeHtml(t('状态', 'Status'))}">${badge(t, job.status)}${classifyFailure(job) === null ? '' : `<br /><small class="muted">${escapeHtml(failureLabel(t, classifyFailure(job)!.kind))}</small>`}</td>
        <td class="job-links" data-label="${escapeHtml(t('PR / Issue', 'PR / Issue'))}">${jobLinks(job)}</td>
        <td data-job-summary class="job-summary" data-priority="low" data-label="${escapeHtml(t('摘要', 'Summary'))}"><span data-job-summary-text title="${escapeHtml(summary.full)}">${escapeHtml(summary.short)}</span>${attribution === '' ? '' : `<small class="muted" data-job-attribution>${escapeHtml(attribution)}</small>`}</td>
      </tr>`
    })
    .join('')
}

function jobTable(locale: Locale, jobs: JobRow[], empty: EmptyJobs | undefined, table: { id: string; name?: string; ranks?: Map<string, QueueRank> }): string {
  const t = translator(locale)
  const name = escapeHtml(table.name ?? t('任务', 'Jobs'))
  return `<div class="table-scroll"><table class="job-table table-priority" id="${escapeHtml(table.id)}" aria-label="${name}"><thead><tr><th>${escapeHtml(t('任务', 'Job'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('PR / Issue', 'PR / Issue'))}</th><th data-priority="low">${escapeHtml(t('摘要', 'Summary'))}</th></tr></thead><tbody>${jobRows(locale, jobs, empty, table.ranks)}</tbody></table></div>`
}

function jobList(locale: Locale, jobs: JobRow[], repoLabels: Map<string, string> = new Map(), empty?: EmptyJobs): string {
  const t = translator(locale)
  if (jobs.length === 0) return renderState({ kind: 'empty', title: empty?.title ?? t('还没有任务。', 'No jobs yet.'), body: empty === undefined ? t('添加仓库并选择角色后运行一次；每个任务只开一个 PR。', 'Add a repository, choose a role and run one job; each job opens at most one pull request.') : empty.body, action: empty?.action ?? { href: '/dashboard', label: t('打开仓库', 'Open a repository') } })
  return `<div class="list">${jobs
    .map((job) => {
      const summary = jobPlainSummary(locale, t, job, 100)
      const label = repoLabels.get(job.repo_id)
      const links = jobLinks(job)
      return `<div class="list-row" data-job-id="${escapeHtml(job.id)}">
        <div class="list-main">
          <div class="list-title">${badge(t, job.status)} <span class="badge kind">${escapeHtml(jobKindLabel(t, job))}</span> <a class="list-title-link" href="/repos/${escapeHtml(job.repo_id)}/jobs/${escapeHtml(job.id)}" title="${escapeHtml(summary.full)}"><span>${escapeHtml(summary.short)}</span></a></div>
          <small>${label === undefined ? '' : `${escapeHtml(label)} · `}<a href="/repos/${escapeHtml(job.repo_id)}/jobs/${escapeHtml(job.id)}"><code>${escapeHtml(job.id)}</code></a> · ${escapeHtml(triggerLabel(t, job.trigger))} · ${escapeHtml(humanTimeShort(job.created_at))}${links === '—' ? '' : ` · ${links}`}</small>
        </div>
      </div>`
    })
    .join('')}</div>`
}

export function inboxSection(locale: Locale, viewer: Viewer, questions: InboxQuestion[], returnTo: string): string {
  const t = translator(locale)
  const cards = questions.length === 0
    ? `<p class="muted">${escapeHtml(t('没有待回答的问题。', 'No open questions.'))}</p>`
    : questions
    .map((question) => {
      const options = question.options
        .map((option) => `<label class="option-card"><input type="${question.multiSelect ? 'checkbox' : 'radio'}" name="selected" value="${escapeHtml(option)}" /><span>${escapeHtml(option)}</span></label>`)
        .join('')
      return `<div class="question-card" data-question="${escapeHtml(question.id)}">
        <div class="question-head">
          <strong>${escapeHtml(question.question || t('团队提问', 'Team question'))}</strong>
          <a class="badge" href="/repos/${escapeHtml(question.repoId)}${advancedViewer(viewer) ? '/team' : '#inbox'}">${escapeHtml(question.repoLabel)}</a>
        </div>
        ${question.detail === '' ? '' : `<p class="fine">${escapeHtml(question.detail)}</p>`}
        <form method="post" action="/repos/${escapeHtml(question.repoId)}/team/answer" class="form question-form" data-answer-form>
          ${csrf(viewer)}
          <input type="hidden" name="sessionId" value="${escapeHtml(question.sessionId)}" />
          <input type="hidden" name="questionId" value="${escapeHtml(question.id)}" />
          <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
          ${options === '' ? '' : `<div class="question-options">${options}</div>`}
          <div class="question-answer-row">
            <input class="question-custom" name="custom" placeholder="${escapeHtml(t('也可以填写自己的答案…', 'Or type your own answer…'))}" autocomplete="off" />
            <button class="btn btn-small" type="submit">${escapeHtml(t('发送回答', 'Send answer'))}</button>
          </div>
          <p class="fine bad question-error" data-question-error hidden></p>
        </form>
      </div>`
    })
    .join('')
  return `<section class="card inbox" id="inbox" aria-live="polite"${questions.length === 0 ? ' hidden' : ''}>
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('需要你处理', 'NEEDS YOUR INPUT'))}</div>
        <h2>${escapeHtml(t('FlyBot 在等你回答', 'FlyBot is waiting for you'))} <span class="count" data-inbox-count>${questions.length}</span></h2>
        <p class="muted">${escapeHtml(t('回答会直接发送给正在运行的团队，不需要进入仓库工作台。', 'Answers go straight to the running team; you do not need to open the repository console.'))}</p>
      </div>
      ${returnTo === '/dashboard' ? '' : `<a class="link" href="/dashboard">${escapeHtml(t('查看仓库', 'View repositories'))}</a>`}
    </div>
    <div class="inbox-list">${cards}</div>
    <p class="fine" data-inbox-status role="status" aria-live="polite"></p>
  </section>`
}

// #231: a notification that carries a failure code rebuilds its sentence from the
// code instead of translating the raw text, which is how "The job X failed:
// GitHub token 权限不足…" used to reach an English reader. The stored row keeps the
// text the writer produced, for operators and for the API.
function noticeText(locale: Locale, t: Translate, entry: NotificationRow): string {
  const sentence = failureSentence(t, entry.code)
  if (sentence !== null) {
    // The stored message keeps the wrapper its writer used, so the wrapper is
    // rebuilt with `t()` instead of reused: a `zh` reader must not get
    // "The job X failed:" around a Chinese sentence, and an `en` reader must not
    // get "任务 X 失败：" around an English one.
    const wrapper = /^(审核|任务) (\S+) 失败：|^The (review job|job) (\S+) failed: /.exec(entry.message)
    if (wrapper !== null) {
      const review = wrapper[1] === '审核' || wrapper[3] === 'review job'
      const id = wrapper[2] ?? wrapper[4] ?? ''
      return review
        ? t(`审核 ${id} 失败：${sentence}`, `The review job ${id} failed: ${sentence}`)
        : t(`任务 ${id} 失败：${sentence}`, `The job ${id} failed: ${sentence}`)
    }
    if (locale === 'en') return sentence
  }
  return localizeNotification(locale, entry.message)
}

function noticeBlock(locale: Locale, viewer: Viewer, notifications: NotificationRow[]): string {
  const t = translator(locale)
  const unread = notifications.filter((entry) => entry.read_at === null)
  if (unread.length === 0) return ''
  return `<div class="card notices"><h2>${escapeHtml(t('通知', 'Notifications'))}</h2>${unread
    .slice(0, 3)
    .map((entry) => `<div class="notice"><span>${escapeHtml(noticeText(locale, t, entry))}</span><small>${escapeHtml(humanTimeShort(entry.created_at))}</small></div>`)
    .join('')}<form method="post" action="/notifications/read">${csrf(viewer)}<button class="link" type="submit">${escapeHtml(t('全部标为已读', 'Mark all read'))}</button></form></div>`
}

export function landingPage(config: Config, viewer?: Viewer | null, devLogin = false, locale: Locale = 'zh'): string {
  const t = translator(locale)
  // The same two predicates the route guard calls; the page must not decide this alone.
  const oauth = oauthConfigured(config)
  const tokenLogin = tokenLoginEnabled(config)
  const tokenForm = `<details class="card narrow mt-24" id="token-login" open>
      <summary>${escapeHtml(t('使用 GitHub token 登录（备用）', 'Sign in with a GitHub token (fallback)'))}</summary>
      <form method="post" action="/auth/token" class="form">
        <label>${escapeHtml(t('GitHub token', 'GitHub token'))} <input name="token" type="password" placeholder="github_pat_… 或 ghp_…" required autocomplete="off" /></label>
        <p class="fine">${escapeHtml(t('只用于确认 GitHub 身份，不会保存。仓库 token 在添加仓库时单独填写。', 'Used only to confirm your GitHub identity and never stored. Repository tokens are entered separately when you add a repository.'))}</p>
        <button class="btn" type="submit">${escapeHtml(t('用 token 登录', 'Sign in with token'))}</button>
      </form>
    </details>`
  const body = `<section class="hero">
    <div class="hero-copy">
      <div class="eyebrow">${escapeHtml(t('托管 · 自我迭代 · 可审查', 'HOSTED · SELF-ITERATING · REVIEWABLE'))}</div>
      <h1>${escapeHtml(t('让仓库自己长大。', 'Let your repositories grow.'))}</h1>
      <p class="lede">${escapeHtml(t('把多个 GitHub 仓库交给 Fledge。FlyBot 会持续阅读代码、写失败的测试、修最小的根因，并开一个你可以审查的 PR。你只需要决定合不合。', 'Hand several GitHub repositories to Fledge. FlyBot reads the code, writes a failing test, fixes the smallest root cause and opens a pull request you can review. You only decide whether to merge.'))}</p>
      <div class="actions">
        ${oauth ? `<a class="btn" href="/auth/github">${escapeHtml(t('使用 GitHub 登录', 'Sign in with GitHub'))}</a>` : `<a class="btn" href="#token-login">${escapeHtml(t('使用 GitHub token 登录', 'Sign in with a GitHub token'))}</a>`}
        ${devLogin ? `<a class="btn btn-ghost" href="/auth/dev">${escapeHtml(t('Dev 登录（本地）', 'Dev sign-in (local)'))}</a>` : ''}
        <a class="btn btn-ghost" href="https://github.com/HugoXK/fledge" target="_blank" rel="noreferrer">${escapeHtml(t('看源码', 'View source'))}</a>
      </div>
    </div>
    <aside class="loop-card" aria-label="${escapeHtml(t('Fledge 迭代循环', 'Fledge iteration loop'))}">
      <div class="loop-head"><span>${escapeHtml(t('迭代循环', 'FLEDGE LOOP'))}</span><span class="loop-tag">${escapeHtml(t('只开 PR', 'PR ONLY'))}</span></div>
      <ol class="loop-steps">
        <li class="loop-step"><span class="loop-num">01</span><div><b>${escapeHtml(t('接入', 'Connect'))}</b><small>${escapeHtml(t('GitHub 登录 + 仓库 token', 'GitHub sign-in + repo token'))}</small></div></li>
        <li class="loop-step"><span class="loop-num">02</span><div><b>${escapeHtml(t('测试', 'Test'))}</b><small>${escapeHtml(t('先写一个失败的测试', 'Write a failing test first'))}</small></div></li>
        <li class="loop-step"><span class="loop-num">03</span><div><b>${escapeHtml(t('修复', 'Fix'))}</b><small>${escapeHtml(t('改最小的根因', 'Fix the smallest root cause'))}</small></div></li>
        <li class="loop-step"><span class="loop-num">04</span><div><b>${escapeHtml(t('审查', 'Review'))}</b><small>${escapeHtml(t('你决定合不合', 'You decide whether to merge'))}</small></div></li>
      </ol>
      <div class="loop-foot">${escapeHtml(t('一个 issue → 一个分支 → 一个 PR', 'one issue → one branch → one PR'))}</div>
    </aside>
    <div class="hero-note">
      <p class="fine">${escapeHtml(t('首次登录需要 GitHub 授权；没有权限时先签署《免责声明》和《信息安全承诺》，提交后可在状态页查看排队位置，不要重复提交。平台初始额度 1 元；用完后配置自己的模型 API 即可继续。', 'The first sign-in needs GitHub authorization. Without access, sign the Disclaimer and the Information Security Commitment first; after submitting, the status page shows your queue position. Do not submit twice. The platform starts with 1 CNY of quota; when it runs out, add your own model API to continue.'))}</p>
      ${oauth ? '' : `<p class="fine">${escapeHtml(t('OAuth App 尚未配置；先用 GitHub token 登录（只用于确认身份，不会保存），部署后可在 .env 补 OAuth。', 'The OAuth App is not configured yet. Use the GitHub token fallback (identity only, never stored); add OAuth in .env after deployment.'))}</p>`}
      ${tokenLogin ? tokenForm : ''}
    </div>
  </section>
  <section class="grid3">
    <article class="card feature"><span class="feature-num">01 / REPOS</span><h3>${escapeHtml(t('多仓库', 'Many repositories'))}</h3><p>${escapeHtml(t('一个账号绑定多个仓库，每个仓库有自己的目标、节奏和状态。', 'One account can connect several repositories, each with its own goal, cadence and state.'))}</p></article>
    <article class="card feature"><span class="feature-num">02 / PR</span><h3>${escapeHtml(t('可审查', 'Reviewable'))}</h3><p>${escapeHtml(t('每个任务只产出一个聚焦的 PR。不直接推 main，默认不自动合并；只有 maintainer 显式开启后才会自动合并。', 'Every job produces one focused pull request. No direct pushes to main and no auto-merge by default; only a maintainer can opt in.'))}</p></article>
    <article class="card feature"><span class="feature-num">03 / MODEL</span><h3>${escapeHtml(t('自己的模型', 'Bring your own model'))}</h3><p>${escapeHtml(t('平台额度用完不会停摆：填入任意 OpenAI 兼容服务，任务继续跑。', 'Running out of platform quota does not stop you: connect any OpenAI-compatible service and jobs keep running.'))}</p></article>
  </section>`
  return layout({ title: t('让仓库自己长大', 'Let your repositories grow'), viewer, body, config, locale, path: '/' })
}

export function pendingPage(config: Config, viewer: Viewer, locale: Locale = 'zh'): string {
  const t = translator(locale)
  const body = `<section class="card narrow">
    <div class="eyebrow">${escapeHtml(t('申请待审批', 'APPLICATION PENDING'))}</div>
    <h1>${escapeHtml(t('申请已提交', 'Application submitted'))}</h1>
    <p>${escapeHtml(t(`@${viewer.user.login}，你的访问申请已经发送给管理员 ${config.mail.adminEmail}。`, `@${viewer.user.login}, your access request was sent to the administrator ${config.mail.adminEmail}.`))}</p>
    <p class="muted">${escapeHtml(t(`批准后会收到邮件。通过后刷新本页即可进入控制台。申请状态：${statusLabel(t, viewer.user.status)}`, `You will receive email after approval. Refresh this page to enter the dashboard once approved. Status: ${statusLabel(t, viewer.user.status)}`))}</p>
    <form method="post" action="/auth/logout">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('退出登录', 'Sign out'))}</button></form>
  </section>`
  return layout({ title: t('申请已提交', 'Application submitted'), viewer, body, config, locale, path: '/apply/status' })
}

export function rejectedPage(config: Config, viewer: Viewer, locale: Locale = 'zh'): string {
  const t = translator(locale)
  const body = `<section class="card narrow">
    <h1>${escapeHtml(t('申请未通过', 'Application not approved'))}</h1>
    <p>${escapeHtml(t(`@${viewer.user.login}，这次申请没有通过。如果情况有变化，可以稍后重新登录申请。`, `@${viewer.user.login}, this application was not approved. If your situation changes, you can sign in and apply again later.`))}</p>
    <form method="post" action="/auth/logout">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('退出登录', 'Sign out'))}</button></form>
  </section>`
  return layout({ title: t('申请未通过', 'Application not approved'), viewer, body, config, locale, path: '/apply/status' })
}

// #285: five controls on the jobs card rebuild the same query, and each may
// change only its own parameter. The state a control must keep is read from one
// place here, because a link that re-lists the keys itself is how the window
// buttons lost the filter, both "Clear filters" links lost the window, and the
// repository pager lost both.
const NO_JOB_FILTER: JobFilter = { repo: '', status: '', kind: '' }

/** The window and the active filter, as the query keys every control carries. */
function dashboardStateParams(filter: JobFilter, windowDays: number): Record<string, string> {
  return { ...(windowDays === 30 ? { window: '30' } : {}), ...jobFilterParams(filter) }
}

/** A `/dashboard` link that keeps the window and the filter unless `extra` changes them. */
function dashboardHref(filter: JobFilter, windowDays: number, extra: Record<string, string> = {}, hash = '#jobs'): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...dashboardStateParams(filter, windowDays), ...extra })) {
    if (value !== '') params.set(key, value)
  }
  const query = params.toString()
  return query === '' ? `/dashboard${hash}` : `/dashboard?${query}${hash}`
}

// #232: the filter is a plain GET form, so the browser owns the state and a
// refresh, a shared link and the pagination links all describe the same list.
function jobFilterForm(locale: Locale, filter: JobFilter, repos: Array<{ id: string; label: string }>, windowDays: number): string {
  const t = translator(locale)
  const options = (values: Array<{ value: string; label: string }>, selected: string): string =>
    values
      .map((option) => `<option value="${escapeHtml(option.value)}"${option.value === selected ? ' selected' : ''}>${escapeHtml(option.label)}</option>`)
      .join('')
  return `<form method="get" action="/dashboard#jobs" class="job-filters" data-job-filter>
    ${windowDays === 30 ? '<input type="hidden" name="window" value="30" />' : ''}
    <label>${escapeHtml(t('仓库', 'Repository'))}<select name="repo">${options(
      [{ value: '', label: t('全部仓库', 'All repositories') }, ...repos.map((repo) => ({ value: repo.id, label: repo.label }))],
      filter.repo,
    )}</select></label>
    <label>${escapeHtml(t('状态', 'Status'))}<select name="status">${options(
      [{ value: '', label: t('全部状态', 'All statuses') }, ...JOB_FILTER_STATUSES.map((status) => ({ value: status, label: statusFilterLabel(t, status) }))],
      filter.status,
    )}</select></label>
    <label>${escapeHtml(t('类型', 'Kind'))}<select name="kind">${options(
      [{ value: '', label: t('全部类型', 'All kinds') }, ...JOB_FILTER_KINDS.map((kind) => ({ value: kind, label: kindFilterLabel(t, kind) }))],
      filter.kind,
    )}</select></label>
    <div class="job-filter-actions">
      <button class="btn btn-small" type="submit">${escapeHtml(t('筛选', 'Filter'))}</button>
      ${jobFilterIsActive(filter) ? `<a class="link" href="${escapeHtml(dashboardHref(NO_JOB_FILTER, windowDays))}">${escapeHtml(t('清除筛选', 'Clear filters'))}</a>` : ''}
    </div>
  </form>`
}

// #227: one primary action at a time. Done steps collapse to a tick, the current
// step carries the only button, and a blocked step states its reason instead of
// offering a control that cannot work yet.
function setupSection(setup: SetupState | undefined, t: Translate, primaryElsewhere = false): string {
  if (setup === undefined) return ''
  const outcome = firstRunOutcome(setup, t)
  if (outcome !== null) {
    return `<section class="card" id="first-run" data-first-pr>
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('第一次运行', 'FIRST RUN'))}</div>
        <h2>${escapeHtml(outcome.title)}</h2>
        <p class="muted">${escapeHtml(outcome.body)}</p>
      </div>
      <a class="btn" href="${escapeHtml(outcome.action.href)}">${escapeHtml(outcome.action.label)}</a>
    </div>
  </section>`
  }
  const checklist = setupChecklist(setup, t)
  const rows = checklist.steps
    .map((step, index) => {
      const current = checklist.next?.key === step.key
      const mark = step.done ? '✓' : String(index + 1)
      const status = step.done
        ? `<span class="setup-done">${escapeHtml(t('已完成', 'Done'))}</span>`
        : step.blocked === null
          ? ''
          : `<span class="setup-blocked">${escapeHtml(step.blocked)}</span>`
      // #230: when the next-action block already renders this step's button,
      // the checklist is the detail of that action and must not repeat it.
      const action = current && step.blocked === null && !primaryElsewhere
        ? `<a class="btn btn-small" data-setup-primary href="${escapeHtml(step.action.href)}">${escapeHtml(step.action.label)}</a>`
        : ''
      return `<li class="setup-step${step.done ? ' is-done' : ''}${current ? ' is-current' : ''}" data-setup-step="${step.key}"${current ? ' aria-current="step"' : ''}>
        <span class="setup-mark" aria-hidden="true">${mark}</span>
        <div class="setup-main"><strong>${escapeHtml(step.title)}</strong>${status}</div>
        ${action}
      </li>`
    })
    .join('')
  return `<section class="card" id="setup" data-setup data-setup-next="${checklist.next?.key ?? ''}">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('开始使用', 'GETTING STARTED'))}</div>
        <h2>${escapeHtml(t('第一次运行', 'Your first run'))}</h2>
        <p class="muted">${escapeHtml(t(`${checklist.done} / ${checklist.total} 步已完成`, `${checklist.done} of ${checklist.total} steps done`))}</p>
      </div>
      <span class="badge">${checklist.done}/${checklist.total}</span>
    </div>
    <ol class="setup-steps">${rows}</ol>
  </section>`
}

// #230: the dashboard has one next action, derived on the server from data the
// page already loads. The order is the order a person would take them: a
// question only they can answer, a blocker the platform knows about, the most
// urgent alert, the latest failed job, the unfinished first run, then a quiet
// all-clear that says when the platform runs again on its own. Nothing here
// reads a second source of truth, so the block cannot disagree with the
// sections below it.
export type NextActionKind = 'questions' | 'alert' | 'job' | 'quota' | 'setup' | 'clear'

export interface NextActionView {
  kind: NextActionKind
  title: string
  body: string
  href: string
  label: string
  // A step of the first-run checklist: the block carries that step's own
  // primary button so the checklist below renders the detail without a second.
  setupStep: SetupStepKey | null
  // The same next-run sentence the repository page prints (#564), carried
  // apart from the prose so both surfaces can be asserted against one string.
  nextRunLine?: string
}

// The scheduler's inputs are not all on RepoRow: whether there is open work, an
// active job and a ready instance come from other tables the route reads.
export interface NextRunFact {
  repoId: string
  openWork: boolean
  activeJob: boolean
  instanceReady: boolean
}

function nextRunLine(next: NextRun, t: Translate): string {
  switch (next.state) {
    case 'disabled': return t('仓库已停用，自动运行不会开始', 'Repository disabled; no automatic run starts')
    case 'not-ready': return t('FlyBot 实例未就绪，自动运行不会开始', 'FlyBot instance not ready; no automatic run starts')
    case 'auto-off': return t('自动工作已关闭', 'Auto work off')
    case 'active-job': return t('当前任务结束后再排', 'After the active job finishes')
    case 'idle': return t('空闲：没有开放工作项；会按发现间隔检查', 'Idle: no open work; the discovery interval still runs')
    case 'waiting-first-run': return t('等待首次运行', 'Waiting for first run')
    case 'due': return t('等待调度', 'Waiting for the scheduler')
    case 'scheduled': return humanTimeShort(new Date(next.at ?? 0).toISOString())
  }
}

// One sentence per repository, computed by the rule the worker uses (#564). The
// old dashboard answered `last_run_at + interval_minutes`, which for a default
// 1440-minute repository with open work was 23h45m away from the truth.
function nextScheduledRun(input: { repos: RepoRow[]; facts: NextRunFact[]; config: Config; t: Translate }): { text: string; line: string } {
  const { repos, facts, config, t } = input
  const automatic = repos.filter((repo) => repo.auto_iterate === 1)
  if (automatic.length === 0) return { text: t('没有仓库开启自动迭代。', 'No repository runs automatically.'), line: '' }
  const flybotAvailable = config.flybot.instanceImage !== ''
  const rows = automatic.map((repo) => {
    const fact = facts.find((entry) => entry.repoId === repo.id)
    const state = nextRun({
      lastRunAt: repo.last_run_at,
      intervalMinutes: repo.interval_minutes,
      workCooldownMinutes: config.runner.workCooldownMinutes,
      autoIterate: repo.auto_iterate === 1,
      hasOpenWork: fact === undefined ? true : fact.openWork,
      hasActiveJob: fact?.activeJob ?? false,
      repoEnabled: repo.enabled === 1,
      instanceReady: flybotAvailable && fact !== undefined ? fact.instanceReady : true,
    })
    return { repo, state }
  })
  const runnable = rows.filter((row) => row.state.state === 'scheduled' || row.state.state === 'due')
  // A repository the scheduler knows nothing about must not shadow one it does.
  const chosen = runnable.length === 0 ? rows[0]! : runnable.reduce((a, b) => ((b.state.at ?? 0) < (a.state.at ?? 0) ? b : a))
  const label = `${chosen.repo.upstream_owner || chosen.repo.owner}/${chosen.repo.upstream_name || chosen.repo.name}`
  const line = nextRunLine(chosen.state, t)
  const text = chosen.state.state === 'scheduled' || chosen.state.state === 'due'
    ? t(`下次自动运行：${label} · ${line}`, `Next automatic run: ${label} · ${line}`)
    : t(`自动运行暂停：${label} · ${line}`, `Automatic run paused: ${label} · ${line}`)
  return { text, line }
}

// An English page must not lead with a sentence only the platform writes in
// Chinese: `localizeMessage` maps the strings it knows, and when it has no
// mapping this test is what keeps the raw text off the headline card.
const CJK_TEXT = /[\u4e00-\u9fff]/

function nextActionFor(input: {
  t: Translate
  locale: Locale
  questions: InboxQuestion[]
  alerts: AlertView[]
  // The account's newest job, not the job-table slice: the table is paged and
  // filtered, and a filter must not decide what the page leads with.
  latestJob: JobRow | undefined
  quota: ReturnType<typeof quotaView>
  setup: SetupState | undefined
  repos: RepoRow[]
  nextRunFacts: NextRunFact[]
  config: Config
}): NextActionView {
  const { t, locale, questions, alerts, latestJob, quota, setup, repos, nextRunFacts, config } = input
  if (questions.length > 0) {
    return {
      kind: 'questions',
      title: questions.length === 1
        ? t('FlyBot 在等你回答 1 个问题。', 'FlyBot is waiting on 1 answer.')
        : t(`FlyBot 在等你回答 ${questions.length} 个问题。`, `FlyBot is waiting on ${questions.length} answers.`),
      body: t('回答会直接发送给正在运行的团队。', 'Answers go straight to the running team.'),
      href: '#inbox',
      label: t('去回答', 'Answer'),
      setupStep: null,
    }
  }
  if (quota.exhausted) {
    return {
      kind: 'quota',
      title: t('平台额度已用完。', 'Platform quota is used up.'),
      body: t('配置自己的模型 API 后任务才能继续。', 'Add your own model API to keep jobs running.'),
      href: '/settings#model-providers',
      label: t('配置模型', 'Add a model'),
      setupStep: null,
    }
  }
  const alert = alerts[0]
  if (alert !== undefined) {
    const href = alert.prUrl ?? alertHref(alert)
    return {
      kind: 'alert',
      title: alertText(t, alert),
      body: alerts.length === 1
        ? t('这是唯一需要你处理的事项。', 'This is the only item that needs you.')
        : t(`最紧急的一条；其余 ${alerts.length - 1} 条在下面列出。`, `The most urgent one; the other ${alerts.length - 1} are listed below.`),
      href: href === '' ? '#attention' : href,
      label: alert.prUrl === undefined ? t('打开', 'Open') : t('打开 PR', 'Open pull request'),
      setupStep: null,
    }
  }
  const latest = latestJob
  if (latest !== undefined && latest.status === 'failed') {
    const reason = (latest.error ?? '').trim()
    const localized = (localizeMessage(locale, reason) ?? '').trim()
    const failure = classifyFailure(latest)
    // The platform writes some failure sentences in Chinese only. Showing the
    // raw text on a page in the other language is a mixed-language headline a
    // reader cannot act on, so the card falls back to the failure class, which
    // exists in both languages, and leaves the raw text on the job page.
    const body = reason === ''
      ? t('打开任务看失败原因，修好后重跑。', 'Open the job for the reason, fix it and run again.')
      : localized !== '' && (locale !== 'en' || !CJK_TEXT.test(localized))
        ? localized.slice(0, 160)
        : t(`${failure?.label[0] ?? '任务失败'}，打开任务查看原因。`, `${failure?.label[1] ?? 'Job failed'}; open the job for the detail.`)
    return {
      kind: 'job',
      title: t(`最近一次任务失败：${latest.id}`, `The latest job failed: ${latest.id}`),
      body,
      href: `/repos/${latest.repo_id}/jobs/${latest.id}`,
      label: t('查看任务', 'Open job'),
      setupStep: null,
    }
  }
  const checklist = setup === undefined ? null : setupChecklist(setup, t)
  if (checklist !== null && checklist.next !== undefined) {
    const step = checklist.next
    return {
      kind: 'setup',
      title: step.title,
      body: step.blocked ?? t('这是第一次运行剩下的下一步。', 'The next step of your first run.'),
      href: step.action.href,
      label: step.action.label,
      setupStep: step.key,
    }
  }
  const nextRunView = nextScheduledRun({ repos, facts: nextRunFacts, config, t })
  return {
    kind: 'clear',
    title: t('现在没有需要你处理的事情。', 'Nothing needs you right now.'),
    body: nextRunView.text,
    nextRunLine: nextRunView.line,
    href: '',
    label: '',
    setupStep: null,
  }
}

function nextActionSection(action: NextActionView, t: Translate): string {
  const primary = action.setupStep === null
    ? `<a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
    : `<a class="btn" data-setup-primary href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
  return `<section class="card" id="next-action" data-next-action="${action.kind}" aria-labelledby="next-action-title">
    <div class="eyebrow">${escapeHtml(t('下一步', 'NEXT ACTION'))}</div>
    <h2 id="next-action-title">${escapeHtml(action.title)}</h2>
    <p class="muted"${action.nextRunLine === undefined ? '' : ` data-next-run="${escapeHtml(action.nextRunLine)}"`}>${escapeHtml(action.body)}</p>
    ${action.kind === 'clear' ? '' : primary}
  </section>`
}

export function dashboardPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repos: RepoRow[]
  jobs: JobRow[]
  // #230 review: the headline job is the account's newest, which the route
  // reads separately from the paged and filtered table slice.
  latestJob?: JobRow
  notifications: NotificationRow[]
  questions?: InboxQuestion[]
  personal?: {
    repos: number
    jobs: number
    succeeded: number
    failed: number
    prs: number
    merged: number
    costUsd: number
    openWorkItems: number
    lastJobAt: string | null
  }
  windowDays?: number
  alerts?: AlertView[]
  reposPage?: number
  reposTotal?: number
  jobsPage?: number
  jobsTotal?: number
  jobFilter?: JobFilter
  repoOptions?: Array<{ id: string; label: string }>
  // #230: the page slice is enough for the table, but the next scheduled run
  // must consider every repository, not only the visible page of ten.
  allRepos?: RepoRow[]
  // #564: open work, an active job and a ready instance decide the next run, and
  // they live outside RepoRow, so the route reads them for every repository. A
  // caller that omits them still gets the shared formula, not a second one.
  nextRunFacts?: NextRunFact[]
  // #565: the instance queue is wider than the visible table slice, so a queued
  // row's position and total come from the route's queue read, not the page. A
  // caller that omits the queue renders the list exactly as before.
  queued?: JobRow[]
  setup?: SetupState
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repos, jobs, notifications, notice, error } = input
  const ranks = input.queued === undefined ? undefined : queueRanks(input.queued)
  const questions = input.questions ?? []
  const personal = input.personal
  const windowDays = input.windowDays ?? 7
  const alerts = input.alerts ?? []
  const reposPage = input.reposPage ?? 1
  const reposTotal = input.reposTotal ?? repos.length
  const jobsPage = input.jobsPage ?? 1
  const jobsTotal = input.jobsTotal ?? jobs.length
  const jobFilter = input.jobFilter ?? { repo: '', status: '' as const, kind: '' }
  const repoOptions = input.repoOptions ?? []
  const t = translator(locale)
  const quota = quotaView(viewer.user, config)
  const nextAction = nextActionFor({
    t,
    locale,
    questions,
    alerts,
    latestJob: input.latestJob ?? jobs[0],
    quota,
    setup: input.setup,
    repos: input.allRepos ?? repos,
    nextRunFacts: input.nextRunFacts ?? [],
    config,
  })
  // The add-repository form, the inbox, the attention table and the job table
  // all live inside the disclosure. A browser does not open <details> for an
  // in-page anchor, so the disclosure must already be open or a link that points
  // inside it lands on hidden content. The pager and the filter form are the
  // other two ways in: both target `#jobs`, so a page loaded on page two or with
  // an active filter is a page whose table must be visible.
  const jobTableDeepLinked = jobsPage > 1 || jobFilterIsActive(jobFilter)
  const secondaryOpen = jobTableDeepLinked || ['#add-repo', '#inbox', '#attention'].includes(nextAction.href)
  const repoRows = repos.length === 0
    ? stateCell(5, { kind: 'empty', title: t('还没有仓库。', 'No repositories yet.'), body: t('添加第一个仓库并选择你的角色，任务才会开始。', 'Add your first repository and choose your role before any job can start.'), action: { href: '#add-repo', label: t('添加仓库', 'Add repository') } })
    : repos
        .map(
          (repo) => `<tr data-repo-id="${escapeHtml(repo.id)}">
            <td data-label="${escapeHtml(t('仓库', 'Repository'))}"><a href="/repos/${escapeHtml(repo.id)}"><strong>${escapeHtml(repo.upstream_owner || repo.owner)}/${escapeHtml(repo.upstream_name || repo.name)}</strong></a>${repo.is_fork === 1 ? `<br /><small class="muted">${escapeHtml(t('fork', 'fork'))} ${escapeHtml(repo.fork_owner)}/${escapeHtml(repo.fork_name)}</small>` : ''} <span class="badge kind">${escapeHtml(repoRoleLabel(t, repo.repo_role))}</span>${repo.reviewer_enabled === 1 ? ' <span class="badge">reviewer</span>' : ''}${repo.repo_role === null ? `<br /><small class="muted">${escapeHtml(t('打开仓库选择角色', 'Open the repository to choose a role'))}</small>` : ''}</td>
            <td data-label="${escapeHtml(t('模式', 'Mode'))}">${repo.auto_iterate === 1 ? `<span class="badge good">${escapeHtml(t('自动工作', 'Auto work'))}</span>` : `<span class="badge">${escapeHtml(t('手动', 'Manual'))}</span>`}</td>
            <td data-label="${escapeHtml(t('状态', 'Status'))}">${badge(t, repo.last_status ?? 'idle')}</td>
            <td data-label="${escapeHtml(t('上次运行', 'Last run'))}">${escapeHtml(humanTimeShort(repo.last_run_at))}</td>
            <td data-label="${escapeHtml(t('操作', 'Actions'))}"><a class="link" href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('打开', 'Open'))}</a></td>
          </tr>`,
        )
        .join('')
  const manualForm = `      <form method="post" action="/repos" class="form">
        ${csrf(viewer)}
        <label>${escapeHtml(t('上游仓库', 'Upstream repository'))}${infoTip(t('Fledge 会检查并在需要时创建你的 fork；开发分支推到 fork，issue 和 PR 提到上游。若上游 owner 就是你，则直接在原仓库开分支。', 'Fledge checks and creates your fork when needed; branches go to the fork while issues and PRs target the upstream. If you own the upstream, work directly in it.'))} <input name="repo" placeholder="owner/name" required autocomplete="off" /></label>
        <label>${escapeHtml(t('GitHub token', 'GitHub token'))}${infoTip(t('token 需要能读取上游、创建 fork、写入 fork，并在上游创建 issue/PR；建议只授权实际需要的仓库。token 会加密保存，页面不会回显。', 'The token must read the upstream, create and write the fork, and open issues/PRs on the upstream. Grant only the repositories you need. It is encrypted and never shown again.'))} <input name="token" type="password" placeholder="github_pat_… 或 ghp_…" required autocomplete="off" /></label>
        ${goalTemplateSelect(t, 'goal-new')}
        <label>${escapeHtml(t('迭代目标（可选）', 'Iteration goal (optional)'))}${infoTip(t('目标越具体，产出越稳定。模板会填入一个可执行的目标。', 'The more concrete the goal, the more stable the output. A template fills in a ready prompt.'))} <textarea id="goal-new" name="goal" rows="3" placeholder="${escapeHtml(t('例如：持续修复 issue 里的可复现 bug，只改最小范围。', 'For example: fix reproducible bugs from issues with the smallest safe change.'))}"></textarea></label>
        <div class="row" data-auto-group>
          <label class="check"><input type="checkbox" name="auto" value="1" /> ${escapeHtml(t('自动迭代', 'Auto-iterate'))}</label>
          <label>${escapeHtml(t('发现间隔', 'Discovery interval'))}${infoTip(t('没有工作项时按这个间隔做一次发现（最少 60 分钟）；最多提出一个具体 issue，不会直接开 PR。有工作项时按全局最短工作间隔推进。', 'With no work this interval runs one discovery session (minimum 60 minutes) that may open at most one concrete issue, never a PR. Open work uses the global short work cooldown.'))} <select name="interval">${intervalOptions(t, 1440, DISCOVERY_INTERVALS)}</select></label>
        </div>
        <div class="row" data-review-group>
          <label class="check"><input type="checkbox" name="review" value="1" /> ${escapeHtml(t('启用 PR 审核角色', 'Enable PR reviewer role'))}${infoTip(t('只有 maintainer 角色且 GitHub admin/maintain 权限时才可启用；审核任务独立于迭代任务。', 'Available only with the maintainer role and GitHub admin/maintain permission; review jobs run separately from iterate jobs.'))}</label>
          <label>${escapeHtml(t('审核间隔', 'Review interval'))} <select name="reviewInterval">${reviewIntervalOptions(t)}</select></label>
        </div>
        <p class="fine">${escapeHtml(t('添加后请选择你的角色；未选择前不会启动任务。', 'Choose your role after adding; jobs stay paused until you do.'))}</p>
        <button class="btn" type="submit">${escapeHtml(t('添加仓库', 'Add repository'))}</button>
      </form>`
  const body = `<section class="workspace-hero">
    <div class="workspace-intro">
      <div class="eyebrow">${escapeHtml(t('仓库', 'REPOSITORIES'))}</div>
      <h1>${escapeHtml(t('仓库', 'Repositories'))}</h1>
      <p class="muted">${escapeHtml(t('接入仓库、设置迭代目标，并查看最近任务。', 'Connect repositories, set iteration goals and review recent jobs.'))}</p>
    </div>
  </section>
  ${quota.exhausted ? `<div class="banner bad">${escapeHtml(t('平台额度已用完。请到 Settings → Model 配置你自己的模型 API，任务才能继续。', 'Platform quota is used up. Add your own model API in Settings → Model to keep jobs running.'))}</div>` : ''}
  ${noticeBlock(locale, viewer, notifications)}
  ${nextActionSection(nextAction, t)}
  <details class="secondary" data-secondary${secondaryOpen ? ' open' : ''}>
    <summary>${escapeHtml(t('更多：仓库、交付与任务', 'More: repositories, delivery and jobs'))}</summary>
    <div class="secondary-body">
  ${setupSection(input.setup, t, nextAction.setupStep !== null)}
  <section class="quota-card card" id="quota">
    <div>
      <div class="eyebrow">${escapeHtml(t('平台额度', 'PLATFORM QUOTA'))}</div>
      <div class="quota-big">${quota.unlimited ? escapeHtml(t('不限额', 'Unlimited')) : quotaMoney(quota.remainingCny)}${quota.unlimited ? '' : `<small> / ${money(quota.initialCny)}</small>`}</div>
      <p class="muted">${escapeHtml(quota.unlimited ? t(`已用 ${quotaMoney(quota.usedCny)} · 平台额度不限额`, `Used ${quotaMoney(quota.usedCny)} · platform quota is unlimited`) : t(`已用 ${quotaMoney(quota.usedCny)} · 平台额度用完后可配置自己的模型 API`, `Used ${quotaMoney(quota.usedCny)} · add your own model API when the platform quota runs out`))}</p>
    </div>
    <div class="meter"><span style="width:${quota.unlimited ? '0' : Math.min(100, Math.max(0, (quota.usedCny / Math.max(0.0001, quota.initialCny)) * 100)).toFixed(2)}%"></span></div>
  </section>
  ${inboxSection(locale, viewer, questions, '/dashboard')}
  ${alerts.length === 0 ? '' : `<section class="card" id="attention">
    <div class="row between"><h2>${escapeHtml(t('需要处理', 'Needs attention'))}</h2><span class="fine">${escapeHtml(t('只显示你自己的仓库和任务。', 'Only your repositories and jobs.'))}</span></div>
    <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('级别', 'Level'))}</th><th>${escapeHtml(t('类型', 'Kind'))}</th><th>${escapeHtml(t('详情', 'Detail'))}</th><th></th></tr></thead><tbody>${alertRows(t, alerts)}</tbody></table></div>
  </section>`}

  <section class="card" id="delivery">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('我的交付', 'MY DELIVERY'))}</div>
        <h2>${escapeHtml(t('交付与成本', 'Delivery and cost'))}</h2>
        <p class="muted">${escapeHtml(t(`最近 ${windowDays} 天；只统计你自己的工作。缺失数据用 — 表示。`, `Last ${windowDays} days; your work only. Missing data is shown as —.`))}</p>
      </div>
      <div class="row">
        <a class="btn ${windowDays === 7 ? '' : 'btn-ghost'}" href="${escapeHtml(dashboardHref(jobFilter, windowDays, { window: '7' }))}">${escapeHtml(t('7 天', '7 days'))}</a>
        <a class="btn ${windowDays === 30 ? '' : 'btn-ghost'}" href="${escapeHtml(dashboardHref(jobFilter, windowDays, { window: '30' }))}">${escapeHtml(t('30 天', '30 days'))}</a>
      </div>
    </div>
    ${personal !== undefined && personal.jobs === 0 ? `<p class="fine">${escapeHtml(t('还没有任务。先添加仓库并选择角色，然后运行一次。', 'No jobs yet. Add a repository, choose a role, and run one.'))} <a class="link" href="#add-repo">${escapeHtml(t('添加仓库', 'Add repository'))}</a></p>` : ''}
    <div class="cols">
      <div class="list">
        <div class="list-row"><div class="list-main"><strong>${personal === undefined ? '—' : personal.jobs}</strong><small>${escapeHtml(t('任务', 'Jobs'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${personal === undefined || personal.jobs === 0 ? '—' : `${Math.round((personal.succeeded / personal.jobs) * 1000) / 10}%`}</strong><small>${escapeHtml(t('成功率', 'Success rate'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${personal === undefined ? '—' : personal.prs}</strong><small>${escapeHtml(t('PR', 'Pull requests'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${personal === undefined ? '—' : personal.merged}</strong><small>${escapeHtml(t('已合并 PR', 'Merged PRs'))}</small></div></div>
      </div>
      <div class="list">
        <div class="list-row"><div class="list-main"><strong>${personal === undefined ? '—' : quotaMoney(personal.costUsd * config.quota.usdCny)}</strong><small>${escapeHtml(t('平台计费成本', 'Platform-billed cost'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${personal === undefined ? '—' : personal.openWorkItems}</strong><small>${escapeHtml(t('未完成工作项', 'Open work items'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${personal === undefined || personal.lastJobAt === null ? '—' : escapeHtml(humanTimeShort(personal.lastJobAt))}</strong><small>${escapeHtml(t('最近任务', 'Last job'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${personal === undefined ? '—' : personal.repos}</strong><small>${escapeHtml(t('仓库', 'Repositories'))}</small></div></div>
      </div>
    </div>
  </section>

  <section class="cols">
    <div class="card">
      <h2>${escapeHtml(t('仓库', 'Repositories'))}</h2>
      <div class="table-scroll"><table class="table-cards"><thead><tr><th>${escapeHtml(t('仓库', 'Repository'))}</th><th>${escapeHtml(t('模式', 'Mode'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('上次运行', 'Last run'))}</th><th></th></tr></thead><tbody>${repoRows}</tbody></table></div>
      ${pager('/dashboard', 'reposPage', reposPage, reposTotal, 10, t, { ...dashboardStateParams(jobFilter, windowDays), jobsPage }, '#add-repo')}
    </div>
    <div class="card" id="add-repo">
      <h2>${escapeHtml(t('添加仓库', 'Add repository'))}</h2>
      ${config.githubApp.id === '' ? `<p class="fine">${escapeHtml(t('GitHub App 未配置，请使用下面的 fine-grained token。', 'The GitHub App is not configured; use the fine-grained token below.'))}</p>${manualForm}` : `<div class="add-choice"><h3>${escapeHtml(t('方式一（推荐）：GitHub App', 'Option 1 (recommended): GitHub App'))}</h3><p class="muted">${escapeHtml(t('安装 App 并选择仓库，不需要创建 PAT；Fledge 使用短时 installation token。', 'Install the App and choose repositories; no PAT is needed. Fledge uses short-lived installation tokens.'))}</p><p><a class="btn" href="/auth/github/app/install">${escapeHtml(t('通过 GitHub App 接入', 'Connect with GitHub App'))}</a> <a class="link" href="/repos/new">${escapeHtml(t('选择已安装的仓库', 'Choose installed repositories'))}</a></p></div><details class="add-manual"><summary>${escapeHtml(t('方式二：手动提供 fine-grained token', 'Option 2: provide a fine-grained token manually'))}</summary>${manualForm}</details>`}
      <p class="fine">${escapeHtml(t('两种方式选一种即可；GitHub App 不需要 PAT。', 'Choose one of the two options; the GitHub App does not need a PAT.'))}</p>
    </div>
  </section>

  <section class="card" id="jobs">
    <div class="row between">
      <h2>${escapeHtml(t('最近任务', 'Recent jobs'))}</h2>
      <span class="fine">${escapeHtml(t(`共 ${jobsTotal} 个任务`, `${jobsTotal} job${jobsTotal === 1 ? '' : 's'}`))}</span>
    </div>
    ${jobFilterForm(locale, jobFilter, repoOptions, windowDays)}
    ${jobFilterIsActive(jobFilter) && jobs.length === 0
      ? renderState({
          kind: 'empty',
          title: t('没有任务符合这些筛选。', 'No jobs match these filters'),
          body: jobFilterLabels(jobFilter, repoOptions, t).join(t('、', ', ')),
          action: { href: dashboardHref(NO_JOB_FILTER, windowDays), label: t('清除筛选', 'Clear filters') },
        })
      : jobTable(locale, jobs, { body: t('添加仓库并选择角色后运行一次；每个任务只开一个 PR。', 'Add a repository, choose a role and run one job; each job opens at most one pull request.'), action: { href: '#add-repo', label: t('添加仓库', 'Add repository') } }, { id: 'dashboard-jobs-table', ranks })}
    ${pager('/dashboard', 'jobsPage', jobsPage, jobsTotal, 10, t, { reposPage, ...(windowDays === 30 ? { window: 30 } : {}), ...jobFilterParams(jobFilter) }, '#jobs')}
  </section>
    </div>
  </details>`
  return layout({ title: t('仓库', 'Repositories'), viewer, body, config, locale, path: '/dashboard', active: 'dashboard', notice, error })
}

export function repoPage(input: { config: Config; locale: Locale; viewer: Viewer; repo: RepoRow; instance?: RepoInstanceRow; jobs: JobRow[]; prJobs?: JobRow[]; workItems?: WorkItemRow[]; pendingPlan?: { jobId: string; deadline: string }; workState?: string; reviewTrend?: { week: ReviewTrendWindow; month: ReviewTrendWindow }; models?: Array<ProviderModelRow & { provider_label: string }>; repoModelIds?: string[]; repoDefaultModelId?: string; repoBotModels?: Array<{ role: string; provider_model_id: string }>; repoSpendCny?: number; questions?: InboxQuestion[]; chiefMessages?: ChiefMessage[]; activeJob?: boolean; jobsPage?: number; jobsTotal?: number; queued?: JobRow[]; notice?: string; error?: string; postmortems?: PostmortemRow[]; recurrences?: PostmortemRecurrenceRow[];  providers?: ModelProviderRow[]; workflowFailures?: WorkflowFailureRow[]; usage?: { repos: number; reposCap: number; instances: number; instancesCap: number } }): string {
  const { config, locale, viewer, repo, instance, jobs, notice, error } = input
  const ranks = input.queued === undefined ? undefined : queueRanks(input.queued)
  const workItems = input.workItems ?? []
  const workState = input.workState
  const prJobs = input.prJobs ?? []
  const models = input.models ?? []
  const providers = input.providers ?? []
  const providerPolicy = new Set((repo.provider_allowlist ?? '').split(',').map((id) => id.trim()).filter((id) => id !== ''))
  const repoModelIds = new Set(input.repoModelIds ?? [])
  const repoDefaultModelId = input.repoDefaultModelId ?? ''
  const botModelMap = new Map((input.repoBotModels ?? []).map((entry) => [entry.role, entry.provider_model_id]))
  const repoSpendCny = input.repoSpendCny ?? 0
  const questions = input.questions ?? []
  const chiefMessages = input.chiefMessages ?? []
  const jobsPage = input.jobsPage ?? 1
  const jobsTotal = input.jobsTotal ?? jobs.length
  const t = translator(locale)
  // #361: a review trend is only honest if "no sample" is visible. Every number
  // below is `—` when the window has nothing behind it, a rate is `—` when no
  // review in the window recorded an outcome, and fewer than
  // REVIEW_TREND_SMALL_SAMPLE reviews is labelled rather than smoothed.
  const reviewTrend = input.reviewTrend
  const trendWindows: Array<{ key: string; zh: string; en: string; window: ReviewTrendWindow }> = reviewTrend === undefined
    ? []
    : [
        { key: 'week', zh: '7 天', en: '7 days', window: reviewTrend.week },
        { key: 'month', zh: '30 天', en: '30 days', window: reviewTrend.month },
      ]
  const trendRate = (window: ReviewTrendWindow): string =>
    window.changesRequestedRate === null ? '—' : `${window.changesRequestedRate}% (${window.changesRequested}/${window.outcomes})`
  const trendModels = (window: ReviewTrendWindow): string =>
    window.models.length === 0 ? '—' : window.models.map((model) => `${model.label} ×${model.reviews}`).join(', ')
  const trendSample = (window: ReviewTrendWindow): string =>
    window.smallSample ? ` <span class="badge" data-trend-small-sample="1">${escapeHtml(t(`小样本 n=${window.reviews}`, `Small sample n=${window.reviews}`))}</span>` : ''
  const reviewTrendRows = trendWindows
    .map(({ key, zh, en, window }) => `<tr data-trend-window="${key}"><th scope="row">${escapeHtml(t(zh, en))}</th><td>${window.reviews === 0 ? '—' : `${window.reviews}${trendSample(window)}`}</td><td>${window.averageScore === null ? '—' : window.averageScore}</td><td>${escapeHtml(trendRate(window))}</td><td>${escapeHtml(durationText(window.medianPrOpenToReviewMs))}</td><td>${escapeHtml(durationText(window.medianPrOpenToMergeMs))}</td><td>${escapeHtml(trendModels(window))}</td></tr>`)
    .join('')
  const reviewTrendEmpty = trendWindows
    .filter(({ window }) => window.reviews === 0)
    .map(({ key, zh, en }) => `<small class="muted" data-trend-empty="${key}">${escapeHtml(t(`最近 ${zh}没有审核，所以显示 —，不是 0。`, `No review in the last ${en}, so the window shows — rather than 0.`))}</small>`)
    .join(' ')
  const openPostmortems = input.postmortems ?? []
  const recurrenceRows = input.recurrences ?? []
  const recurrenceByKey = new Map(recurrenceRows.map((row) => [row.recurrence_key, row]))
  const postmortemRows = openPostmortems.map((row) => {
    const recurrence = recurrenceByKey.get(row.recurrence_key)
    const count = recurrence?.count ?? 1
    const affected = recurrence === undefined ? [repo.id] : recurrenceRepositories(recurrence.repositories_json)
    return `<tr>
      <td data-label="${escapeHtml(t('任务', 'Job'))}"><a href="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(row.job_id)}"><code>${escapeHtml(row.job_id)}</code></a><br /><small class="muted">${escapeHtml(humanTimeShort(row.last_seen_at))}</small></td>
      <td data-label="${escapeHtml(t('分类', 'Category'))}"><span class="badge">${escapeHtml(row.category)}</span><br /><small class="muted">${escapeHtml(row.evidence_state === 'verified' ? t('证据已记录', 'Evidence recorded') : t('未核实：没有证据，不猜原因', 'Unverified: no evidence, no guessed cause'))}</small></td>
      <td data-label="${escapeHtml(t('疑似原因', 'Suspected cause'))}">${escapeHtml(row.suspected_cause ?? t('未核实', 'Unverified'))}</td>
      <td data-label="${escapeHtml(t('复发', 'Recurrence'))}"><code>${escapeHtml(row.recurrence_key.slice(0, 12))}</code><br /><small class="muted">${escapeHtml(t(`已见 ${count}×`, `Seen ${count}×`))} · ${escapeHtml(t(`${affected.length} 个仓库`, `${affected.length} repository(ies)`))}</small></td>
      <td data-label="${escapeHtml(t('首次 / 最近', 'First / last'))}"><small class="muted">${escapeHtml(humanTimeShort(recurrence?.first_seen_at ?? row.first_seen_at))}<br />${escapeHtml(humanTimeShort(recurrence?.last_seen_at ?? row.last_seen_at))}</small></td>
      <td data-label="${escapeHtml(t('预防措施', 'Preventive action'))}">${preventiveActionHtml(row.preventive_action)}<br /><small class="muted">${escapeHtml(row.preventive_verified === 1 ? t('已核实', 'Verified') : t('待核实', 'Awaiting verification'))}</small></td>
    </tr>`
  }).join('')
  // #542: intake records the decision, so this card never prints a bare count.
  // Every row names the workflow, the branch/event, the attempt and — when
  // Fledge chose not to analyse — the reason it chose that.
  const workflowFailures = input.workflowFailures ?? []
  const workflowFailureStatus = (status: string): string =>
    status === 'queued' ? t('已记录，待分析', 'Recorded, queued for analysis') : t('已忽略', 'Ignored')
  const workflowFailureReason = (reason: string | null): string =>
    reason === 'pull_request'
      ? t('PR 运行：由 PR 跟进处理', 'Pull-request run: the PR follow-up owns it')
      : reason === 'not_default_branch'
        ? t('不在默认分支（标签或其它分支）', 'Not on the default branch (a tag or another branch)')
        : t('等待分析', 'Awaiting analysis')
  const workflowFailureLog = (row: WorkflowFailureRow): string => {
    if (row.log_error !== null && row.log_error !== '') return t(`日志不可用：${row.log_error}`, `Log unavailable: ${row.log_error}`)
    if (row.log_excerpt !== null && row.log_excerpt !== '') return t(`日志摘录已保存（已脱敏，${row.log_excerpt.length} 字符）`, `Log excerpt stored (redacted, ${row.log_excerpt.length} chars)`)
    return t('未读取日志', 'No log stored')
  }
  const workflowFailureRows = workflowFailures.map((row) => `<tr data-workflow-failure="${escapeHtml(row.status)}">
      <td data-label="${escapeHtml(t('工作流', 'Workflow'))}">${escapeHtml(row.workflow_name)}<br /><small class="muted"><a class="link" href="${escapeHtml(row.run_url)}" rel="noopener">#${row.run_id}</a> · <code>${escapeHtml(row.head_sha.slice(0, 7))}</code></small></td>
      <td data-label="${escapeHtml(t('分支 / 事件', 'Branch / event'))}"><code>${escapeHtml(row.head_branch === '' ? '—' : row.head_branch)}</code><br /><small class="muted">${escapeHtml(row.event === '' ? '—' : row.event)} · ${escapeHtml(t(`第 ${row.attempt} 次尝试`, `attempt ${row.attempt}`))}</small></td>
      <td data-label="${escapeHtml(t('状态', 'Status'))}">${escapeHtml(workflowFailureStatus(row.status))}</td>
      <td data-label="${escapeHtml(t('原因', 'Reason'))}">${escapeHtml(workflowFailureReason(row.reason))}</td>
      <td data-label="${escapeHtml(t('日志', 'Log'))}"><small class="muted">${escapeHtml(workflowFailureLog(row))}</small></td>
      <td data-label="${escapeHtml(t('记录时间', 'Recorded'))}"><small class="muted">${escapeHtml(humanTimeShort(row.created_at))}</small></td>
    </tr>`).join('')
  const workflowFailuresCard = `<section class="card" id="workflow-failures">
    <div class="row between"><div><div class="eyebrow">${escapeHtml(t('默认分支失败', 'DEFAULT-BRANCH FAILURES'))}</div><h2>${escapeHtml(t('失败的运行', 'Failed workflow runs'))}</h2><p class="muted">${escapeHtml(t('默认分支上失败的运行记录在这里；PR 运行仍由 PR 跟进处理。本版会读取失败 job 的日志，先脱敏再保存一个有长度上限的摘录；不重跑、不建 issue，日志读失败也会保留记录并写明原因。', 'Failed runs on the default branch are recorded here; pull-request runs stay with the PR follow-up. This slice reads the failed job log, redacts it before storing a bounded excerpt, and reruns nothing and opens no issue; a failed log read keeps the record and names the reason.'))}</p></div><span class="fine">${escapeHtml(t(`${workflowFailures.length} 条记录`, `${workflowFailures.length} recorded`))}</span></div>
    ${workflowFailures.length === 0
      ? `<p class="muted">${escapeHtml(t('还没有记录到默认分支失败。', 'No default-branch failure has been recorded yet.'))}</p>`
      : `<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('工作流', 'Workflow'))}</th><th>${escapeHtml(t('分支 / 事件', 'Branch / event'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('原因', 'Reason'))}</th><th>${escapeHtml(t('日志', 'Log'))}</th><th>${escapeHtml(t('记录时间', 'Recorded'))}</th></tr></thead><tbody>${workflowFailureRows}</tbody></table></div>`}
  </section>`
  const postmortemCard = `<section class="card" id="postmortems">
    <div class="row between"><div><div class="eyebrow">${escapeHtml(t('故障复盘', 'INCIDENTS'))}</div><h2>${escapeHtml(t('未关闭的复盘', 'Open postmortems'))}</h2><p class="muted">${escapeHtml(t('每个失败、停滞或取消的任务有一条复盘；同一复发键只保留一个计数，并在第二次出现时升级一次。缺少证据时标记为未核实，不猜原因。', 'One postmortem per failed, stalled or cancelled job; one recurrence key counts the same cause and escalates once on its second sighting. Missing evidence is unverified, never a guessed cause.'))}</p></div><span class="fine">${escapeHtml(t(`${openPostmortems.length} 个未关闭`, `${openPostmortems.length} open`))}</span></div>
    ${openPostmortems.length === 0
      ? `<p class="muted">${escapeHtml(t('没有未关闭的复盘。', 'No open postmortems.'))}</p>`
      : `<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('任务', 'Job'))}</th><th>${escapeHtml(t('分类', 'Category'))}</th><th>${escapeHtml(t('疑似原因', 'Suspected cause'))}</th><th>${escapeHtml(t('复发', 'Recurrence'))}</th><th>${escapeHtml(t('首次 / 最近', 'First / last'))}</th><th>${escapeHtml(t('预防措施', 'Preventive action'))}</th></tr></thead><tbody>${postmortemRows}</tbody></table></div>`}
  </section>`
  const reviewTrendCard = reviewTrend === undefined ? '' : `<section class="card" id="review-trend">
    <div class="row between"><div><div class="eyebrow">${escapeHtml(t('审核质量', 'REVIEW QUALITY'))}</div><h2>${escapeHtml(t('审核趋势', 'Review trend'))}</h2><p class="muted">${escapeHtml(t('只统计这个仓库已完成的审核。空窗口显示 —；少于 5 个审核标注为小样本；要求修改率的分母是记录了结果的审核，不是全部审核。', 'Completed reviews for this repository only. An empty window shows —; fewer than 5 reviews is labelled a small sample; the changes-requested rate is over reviews that recorded an outcome, not all reviews.'))}</p></div></div>
    <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('窗口', 'Window'))}</th><th>${escapeHtml(t('审核数', 'Reviews'))}</th><th>${escapeHtml(t('平均分', 'Average score'))}</th><th>${escapeHtml(t('要求修改率', 'Changes requested'))}</th><th>${escapeHtml(t('PR→审核', 'PR→review'))}</th><th>${escapeHtml(t('PR→合并', 'PR→merge'))}</th><th>${escapeHtml(t('模型', 'Model'))}</th></tr></thead><tbody>${reviewTrendRows}</tbody></table></div>
    ${reviewTrendEmpty === '' ? '' : `<p class="fine">${reviewTrendEmpty}</p>`}
  </section>`
  const advanced = advancedViewer(viewer)
  const upstreamOwner = repo.upstream_owner || repo.owner
  const upstreamName = repo.upstream_name || repo.name
  const forkOwner = repo.fork_owner || repo.owner
  const forkName = repo.fork_name || repo.name
  const upstreamUrl = repo.upstream_html_url ?? `https://github.com/${upstreamOwner}/${upstreamName}`
  const forkUrl = repo.fork_html_url ?? `https://github.com/${forkOwner}/${forkName}`
  const targetBranch = repo.target_branch !== '' ? repo.target_branch : (repo.upstream_default_branch || repo.default_branch)
  const appAttribution = config.githubApp.useUserToken && repo.installation_id !== null && !(viewer.user.github_token_scopes ?? '').split(/[ ,]+/).includes('repo')
  const defaultBranch = repo.upstream_default_branch || repo.default_branch
  const repoRole: RepoRole | null = repo.repo_role === 'maintainer' || repo.repo_role === 'developer' ? repo.repo_role : null
  const allowedRoles = allowedRepoRoles(repo.permission)
  const githubCanReview = repo.can_review === 1
  const canMaintain = repoRole === 'maintainer'
  const canReview = githubCanReview && canMaintain
  const reviewerEnabled = repo.reviewer_enabled === 1
  const reviewerLabel = repoRole !== 'maintainer'
    ? t('审核需要 maintainer 角色', 'Reviewer needs the maintainer role')
    : !githubCanReview
      ? t('审核不可用', 'Reviewer unavailable')
      : reviewerEnabled
        ? t('审核已启用', 'Reviewer on')
        : t('审核可用但未启用', 'Reviewer available')
  const roleMissing = repoRole === null
  const reviewStatus = repo.last_review_status === null ? '' : ` · ${badge(t, repo.last_review_status)}`
  const activeJob = input.activeJob ?? jobs.some((job) => job.status === 'queued' || job.status === 'running')
  const openWork = workItems.some((item) => item.state !== 'merged' && item.state !== 'closed')
  // #564: the same rule the worker applies, so this page and the dashboard
  // cannot disagree about when the repository runs again.
  const nextRunState = nextRun({
    lastRunAt: repo.last_run_at,
    intervalMinutes: repo.interval_minutes,
    workCooldownMinutes: config.runner.workCooldownMinutes,
    autoIterate: repo.auto_iterate === 1,
    hasOpenWork: openWork,
    hasActiveJob: activeJob,
    repoEnabled: repo.enabled === 1,
    instanceReady: config.flybot.instanceImage === '' ? true : instance?.status === 'ready',
  })
  const nextRunText = nextRunLine(nextRunState, t)
  const instanceTeam = instance === undefined ? null : parseTeam(instance.team_json)
  const instanceReady = instance?.status === 'ready' && instanceTeam !== null
  const flybotAvailable = config.flybot.instanceImage !== ''
  const flybotReady = !flybotAvailable || instance?.status === 'ready'
  const repoEnabled = repo.enabled === 1
  const credentialOk = repo.credential_state !== 'invalid'
  const runnable = repoEnabled && flybotReady && credentialOk
  // The empty job list points at what this page can actually do: choose a role,
  // run this repository, or fix what blocks a run. Another page's action is wrong here.
  const emptyJobs: EmptyJobs = roleMissing
    ? { body: t('先选择你在这个仓库的角色，然后运行第一个任务。', 'Choose your role for this repository, then run the first job.'), action: { href: '#role', label: t('选择角色', 'Choose a role') } }
    : runnable
      ? { body: t('立即运行会创建这个仓库的第一个任务；每次运行只开一个 PR。', 'Run now creates the first job for this repository; each run opens at most one pull request.'), action: { formAction: `/repos/${repo.id}/run`, label: t('立即运行', 'Run now'), csrf: csrf(viewer) } }
      : { body: t('先修复 FlyBot 实例或 GitHub 凭据，然后再运行。', 'Fix the FlyBot instance or the GitHub credential first, then run.'), action: { label: t('实例与凭据在本页的连接卡片里。', 'The instance and the credential are on the connection card of this page.') } }
  const instanceNotice = config.flybot.instanceImage === ''
    ? `<div class="banner">${escapeHtml(t('这个部署没有启用每仓库 FlyBot 实例，任务由全局 mock/runner 处理。', 'This deployment has no per-repository FlyBot instance; jobs use the global mock/runner.'))}</div>`
    : instance === undefined
      ? `<div class="banner">${escapeHtml(t('FlyBot 实例尚未创建。保存仓库后会自动初始化；也可以手动启动。', 'The FlyBot instance has not been created yet. It starts automatically after the repository is saved, or you can start it manually.'))}</div>`
      : instance.status !== 'ready'
        ? `<div class="banner ${instance.status === 'failed' ? 'bad' : ''}">${escapeHtml(t(`FlyBot 实例状态：${statusLabel(t, instance.status)}`, `FlyBot instance status: ${statusLabel(t, instance.status)}`))}${instance.last_error === null ? '' : ` · ${escapeHtml(instance.last_error)}`}</div>`
        : ''
  const instanceActions = config.flybot.instanceImage === ''
    ? ''
    : instance === undefined || instance.status === 'failed' || instance.status === 'stopped'
      ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(t('启动 FlyBot', 'Start FlyBot'))}</button></form>`
      : instance.status === 'ready'
        ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance/stop" data-confirm="${escapeHtml(t('停止这个仓库的 FlyBot 实例？正在运行的工作会中断。', 'Stop the FlyBot instance for this repository? Running work will be interrupted.'))}">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('停止 FlyBot', 'Stop FlyBot'))}</button></form>`
        : `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance" data-confirm="${escapeHtml(t('重新初始化 FlyBot 会重建实例，正在运行的工作可能中断。继续？', 'Reinitializing FlyBot rebuilds the instance and may interrupt running work. Continue?'))}">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('重新初始化 FlyBot', 'Reinitialize FlyBot'))}</button></form>`
  const permission = permissionLabel(t, repo.permission)
  const reviewerScopeText = instanceTeam === null ? '' : instanceTeam.reviewerScope === 'upstream'
    ? t('上游全部 PR', 'all upstream PRs')
    : instanceTeam.reviewerScope === 'self' ? t('仅自审', 'self-review') : t('未启用', 'off')
  const reviewerNote = reviewerEnabled
    ? `${t('已启用', 'Enabled')} · ${reviewerScopeText}`
    : canReview ? t('未启用（设置里开启）', 'Created but disabled (enable in settings)') : t('不可用', 'Unavailable')
  const teamRoles = instanceTeam === null ? [] : [
    { label: t('总控', 'Chief'), id: instanceTeam.chief, note: t('已创建', 'Created') },
    { label: t('负责人', 'Lead'), id: instanceTeam.lead, note: t('已创建', 'Created') },
    { label: t('产品', 'Product'), id: instanceTeam.product, note: t('已创建', 'Created') },
    { label: t('测试', 'Test'), id: instanceTeam.test, note: t('已创建', 'Created') },
    { label: t('安全', 'Security'), id: instanceTeam.security, note: t('已创建', 'Created') },
    { label: t('审核', 'Reviewer'), id: instanceTeam.reviewer ?? '—', note: reviewerNote },
    { label: t('开发 1', 'Dev-1'), id: instanceTeam.dev1, note: t('已创建', 'Created') },
    { label: t('开发 2', 'Dev-2'), id: instanceTeam.dev2, note: t('已创建', 'Created') },
  ]
  const teamGrid = teamRoles.length === 0 ? '' : `<div class="team-grid">${teamRoles.map((role) => `<div class="team-role"><b>${escapeHtml(role.label)}</b><span>${escapeHtml(role.note)}</span></div>`).join('')}</div>
    <details class="fine session-details"><summary>${escapeHtml(t('查看 session ID', 'View session IDs'))}</summary><div class="session-list">${teamRoles.map((role) => `<code>${escapeHtml(role.label)}: ${escapeHtml(role.id)}</code>`).join('')}</div></details>`
  const repoHeader = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('仓库', 'REPOSITORY'))}</div>
        <h1>${escapeHtml(upstreamOwner)}/${escapeHtml(upstreamName)}</h1>
        <p class="muted">${escapeHtml(t('目标分支', 'Target branch'))} <code>${escapeHtml(targetBranch)}</code>${targetBranch === defaultBranch ? '' : ` · ${escapeHtml(t('默认分支', 'Default branch'))} <code>${escapeHtml(defaultBranch)}</code>`} · ${escapeHtml(repo.auto_iterate === 1 ? t('自动迭代已开启', 'Auto-iteration on') : t('仅手动运行', 'Manual runs only'))} · ${escapeHtml(t('自动间隔', 'Auto every'))} <b>${escapeHtml(intervalLabel(repo.interval_minutes, t))}</b> · ${escapeHtml(t('下次约', 'Next'))} <span data-next-run>${escapeHtml(nextRunText)}</span> · ${badge(t, repo.last_status ?? 'idle')}</p>
        <p class="fine">${escapeHtml(t('上游', 'Upstream'))} <a href="${escapeHtml(upstreamUrl)}" target="_blank" rel="noreferrer">${escapeHtml(upstreamOwner)}/${escapeHtml(upstreamName)}</a> · ${repo.is_fork === 1 ? `${escapeHtml(t('Fork', 'Fork'))} <a href="${escapeHtml(forkUrl)}" target="_blank" rel="noreferrer">${escapeHtml(forkOwner)}/${escapeHtml(forkName)}</a>` : escapeHtml(t('自有仓库，无需 fork', 'Own repository, no fork'))} · ${escapeHtml(t('GitHub 权限', 'GitHub permission'))} <code>${escapeHtml(permission)}</code> · ${escapeHtml(t('你的角色', 'Your role'))} <code>${escapeHtml(repoRoleLabel(t, repoRole))}</code> · ${escapeHtml(reviewerLabel)}</p>
      </div>
      <div class="row">
        <a class="btn btn-ghost" href="/repos/${escapeHtml(repo.id)}/workspace">${escapeHtml(t('工作区', 'Workspace'))}</a>
        ${advanced ? `<a class="btn btn-ghost" href="/repos/${escapeHtml(repo.id)}/team">${escapeHtml(t('团队工作台', 'Team console'))}</a>` : ''}
        ${roleMissing ? `<span class="badge busy">${escapeHtml(t('先选择角色', 'Choose a role first'))}</span>` : !runnable ? `<span class="badge busy">${escapeHtml(t('仓库不可运行', 'Not runnable'))}</span>` : `<form method="post" action="/repos/${escapeHtml(repo.id)}/run">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(t('立即运行', 'Run now'))}</button></form>
        <form method="post" action="/repos/${escapeHtml(repo.id)}/plan">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('只出计划', 'Plan only'))}</button></form>`}
        ${!roleMissing && runnable && canReview && reviewerEnabled ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/review">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('立即审核', 'Review now'))}</button></form>` : ''}
      </div>
    </div>
  </section>`
  // #523: triage is repository-scoped and read-only, so the start control sits
  // beside the run and review starts on the page the owner already controls. The
  // one input it accepts is an optional issue URL; the route refuses a link that
  // is not this repository's, so the field says so instead of letting the
  // callback discover it later.
  const triageFieldId = `triage-issue-${repo.id}`
  const triageForm = roleMissing
    ? `<p class="muted">${escapeHtml(t('先选择你的角色，然后才能开始分诊。', 'Choose your role first; triage opens after that.'))}</p>`
    : `<form method="post" action="/repos/${escapeHtml(repo.id)}/triage" class="form">
      ${csrf(viewer)}
      <label for="${escapeHtml(triageFieldId)}">${escapeHtml(t('Issue URL（可选）', 'Issue URL (optional)'))}
        <input id="${escapeHtml(triageFieldId)}" name="issueUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://github.com/${escapeHtml(upstreamOwner)}/${escapeHtml(upstreamName)}/issues/1" aria-describedby="${escapeHtml(triageFieldId)}-hint"${activeJob ? ' disabled' : ''} />
      </label>
      <p class="fine" id="${escapeHtml(triageFieldId)}-hint">${escapeHtml(t('填一个这个仓库的 issue，看板就从它开始；留空则通读全部开着的 issue 和 PR。别的仓库或别的站点的链接会被拒绝，任务不会开始。', 'A link from this repository starts the board with that issue; leaving it empty reads every open issue and pull request. A link from another repository or host is refused and no job starts.'))}</p>
      <div class="row">
        <button class="btn" type="submit"${activeJob ? ' disabled' : ''}>${escapeHtml(t('开始分诊', 'Triage now'))}</button>
        ${activeJob ? `<span class="fine">${escapeHtml(t('已有任务在运行，结束后才能开始分诊。', 'A job is already running; triage starts once it finishes.'))}</span>` : ''}
      </div>
    </form>`
  const triageCard = `<section class="card" id="triage">
    <div class="eyebrow">${escapeHtml(t('分诊', 'TRIAGE'))}</div>
    <h2>${escapeHtml(t('分诊这个仓库', 'Triage this repository'))}</h2>
    <p class="muted">${escapeHtml(t('读出开着的 issue 和 PR，按优先级排序、标出重复项，并点名下一项。只读：不开分支，也不开 PR。', 'Reads the open issues and pull requests, ranks them by priority, links duplicates and names the next item. Read-only: no branch and no pull request.'))}</p>
    ${triageForm}
  </section>`
  const instanceCard = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('每仓库 FlyBot', 'PER-REPOSITORY FLYBOT'))}</div>
        <h2>${escapeHtml(advanced ? t('实例与团队', 'Instance & team') : t('FlyBot 状态', 'FlyBot status'))}</h2>
        <p class="muted">${instance === undefined ? escapeHtml(t('未创建', 'Not created')) : `${badge(t, instance.status)}${advanced ? ` <span class="muted">${escapeHtml(instance.container)}</span>` : ''}`}${instanceReady && advanced ? ` · ${escapeHtml(t('任务先发给总控，再由负责人执行', 'jobs go to the Chief, then the Lead'))}` : ''}</p>
      </div>
      ${advanced ? instanceActions : ''}
    </div>
    ${advanced ? teamGrid : ''}
  </section>`
  const chiefThread = `<div class="chief-thread" id="chief-thread">${chiefMessages.length === 0
    ? `<p class="muted">${escapeHtml(t('还没有对话。给 Chief 发第一句。', 'No conversation yet. Send the Chief the first message.'))}</p>`
    : chiefMessages.map((message) => `<div class="chief-msg ${message.role}">
      <div class="chief-role">${escapeHtml(message.role === 'user' ? t('你', 'You') : 'Chief')}${message.at > 0 ? ` · ${escapeHtml(humanTimeShort(new Date(message.at).toISOString()))}` : ''}</div>
      <div class="chief-text">${escapeHtml(message.text)}</div>
    </div>`).join('')}</div>`
  const chiefCard = advanced ? '' : `<section class="card chief-card" id="chief" data-chief-api="${instanceReady ? `/api/repos/${escapeHtml(repo.id)}/chief/messages` : ''}" data-chief-events="${instanceReady ? `/api/repos/${escapeHtml(repo.id)}/chief/events` : ''}" data-chief-message="${instanceReady ? `/api/repos/${escapeHtml(repo.id)}/chief/message` : ''}" data-chief-csrf="${escapeHtml(viewer.csrfToken)}">
    <div class="row between">
      <div>
        <h2>${escapeHtml(t('和 Chief 沟通', 'Talk to the Chief'))}</h2>
        <p class="muted">${escapeHtml(t('你只需要和 Chief 沟通；团队内部由 Chief 分派。对话会写入审计。', 'You only need to talk to the Chief; the Chief routes work inside the team. The conversation is audited.'))}</p>
      </div>
      <div class="row"><a class="link" href="#inbox">${escapeHtml(t('待回答的问题', 'Open questions'))}</a><a class="link" href="/repos/${escapeHtml(repo.id)}#chief">${escapeHtml(t('刷新回复', 'Refresh replies'))}</a></div>
    </div>
    ${chiefThread}
    ${instanceReady ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/chief/message" class="form chief-form" data-chief-form>
      ${csrf(viewer)}
      <div class="chief-quick">
        <button type="button" class="chip" data-chief-prompt="${escapeHtml(t('请汇报当前进度和下一步。', 'Report the current progress and next step.'))}">${escapeHtml(t('汇报进度', 'Progress'))}</button>
        <button type="button" class="chip" data-chief-prompt="${escapeHtml(t('下一步你准备做什么？', 'What will you do next?'))}">${escapeHtml(t('下一步', 'Next step'))}</button>
        <button type="button" class="chip" data-chief-prompt="${escapeHtml(t('先不要改代码，说明当前风险。', 'Do not change code yet; explain the current risks.'))}">${escapeHtml(t('先别改代码', 'Do not change code'))}</button>
      </div>
      <label>${escapeHtml(t('留言', 'Message'))}<textarea class="chief-input" name="text" rows="3" maxlength="4000" required placeholder="${escapeHtml(t('例如：先汇报当前进度和风险，不要改代码。', 'For example: report current progress and risks first; do not change code.'))}"></textarea></label>
      <div class="chief-compose-row"><p class="chief-status" data-chief-status role="status" aria-live="polite"></p><button class="btn" type="submit">${escapeHtml(t('发送给 Chief', 'Send to Chief'))}</button></div>
    </form>` : `<p class="muted">${escapeHtml(t('FlyBot 实例就绪后可以和 Chief 沟通。', 'You can talk to the Chief after the FlyBot instance is ready.'))}</p>`}
  </section>`
  const roleDescriptions: Record<RepoRole, string> = {
    maintainer: t('可以运行 review / triage / 维护类任务；需要 GitHub admin 或 maintain 权限。', 'Can run review/triage/maintenance jobs; requires GitHub admin or maintain permission.'),
    developer: t('只运行迭代和计划任务；不运行 review/triage，也不能启用自动合并。', 'Runs iterate and plan jobs only; no review/triage and no auto-merge.'),
  }
  const roleCard = roleMissing
    ? `<section class="card" id="role">
        <div class="eyebrow">${escapeHtml(t('你的角色', 'YOUR ROLE'))}</div>
        <h2>${escapeHtml(t('选择你在这个仓库的角色', 'Choose your role for this repository'))}</h2>
        <p class="muted">${escapeHtml(t('角色来自你在这个 GitHub 仓库的权限，Fledge 不会自动替你选择。未选择前不会启动定时或手动任务。', 'The role comes from your permission on this GitHub repository; Fledge will not choose it for you. Scheduled and manual jobs stay paused until you choose.'))}</p>
        <form method="post" action="/repos/${escapeHtml(repo.id)}/role" class="form">
          ${csrf(viewer)}
          <div class="row">
            ${allowedRoles.map((role) => `<button class="btn" type="submit" name="role" value="${role}">${escapeHtml(repoRoleLabel(t, role))}</button>`).join('')}
          </div>
        </form>
        <div class="list">
          ${allowedRoles.map((role) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(repoRoleLabel(t, role))}</strong><small>${escapeHtml(roleDescriptions[role])}</small></div></div>`).join('')}
        </div>
        <p class="fine">${escapeHtml(t('GitHub 权限是 admin/maintain 时才能选 maintainer；其他权限只能选 developer。平台管理员不能替你改这个角色。', 'Maintainer is available only with GitHub admin/maintain permission; every other permission can only be developer. Platform admins cannot change this role for you.'))}</p>
      </section>`
    : ''
  const visibleWorkItems = workState === undefined ? workItems : workItems.filter((item) => item.state === workState)
  const workRows = visibleWorkItems.length === 0
    ? stateCell(6, { kind: 'empty', title: workState === undefined ? t('还没有工作项。', 'No work items yet.') : t(`没有状态为“${workItemStateLabel(t, workState)}”的工作项。`, `No work items are in “${workItemStateLabel(t, workState)}”.`), body: workState === undefined ? t('创建一个，或让任务自动生成。', 'Create one, or let a job create it.') : t('换一个状态筛选，或回到全部。', 'Switch the filter, or go back to all.'), action: workState === undefined ? { href: '/dashboard', label: t('回到仓库', 'Back to repositories') } : { href: `/repos/${escapeHtml(repo.id)}`, label: t('查看全部工作项', 'Show all work items') } })
    : visibleWorkItems.map((item) => {
        const nextStates = WORK_ITEM_TRANSITIONS[item.state as WorkItemState] ?? []
        const stateOptions = nextStates.map((state) => `<option value="${state}">${escapeHtml(workItemStateLabel(t, state))}</option>`).join('')
        return `<tr>
          <td data-label="${escapeHtml(t('工作项', 'Work item'))}"><strong>${escapeHtml(item.title)}</strong>${item.detail === '' ? '' : `<br /><small class="muted">${escapeHtml(item.detail.slice(0, 180))}</small>`}</td>
          <td data-label="${escapeHtml(t('状态', 'State'))}"><span class="badge kind">${escapeHtml(item.state === 'closed' && item.closed_reason === 'plan_expired' ? t('已关闭 · 计划过期', 'Closed — plan expired') : workItemStateLabel(t, item.state))}</span><br /><small class="muted">${escapeHtml(workItemStageLabel(t, item.state))}</small></td>
          <td data-label="${escapeHtml(t('优先级', 'Priority'))}">${item.priority}</td>
          <td data-label="Issue / PR">${item.issue_url === null ? '' : `<a href="${escapeHtml(item.issue_url)}" target="_blank" rel="noreferrer">Issue</a>`}${item.issue_url !== null && item.pr_url !== null ? ' · ' : ''}${item.pr_url === null ? '' : `<a href="${escapeHtml(item.pr_url)}" target="_blank" rel="noreferrer">PR</a>`}</td>
          <td data-label="${escapeHtml(t('任务', 'Job'))}">${item.job_id === null ? '—' : `<a href="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(item.job_id)}"><code>${escapeHtml(item.job_id)}</code></a>`}</td>
          <td data-label="${escapeHtml(t('操作', 'Actions'))}"><div class="row">
            ${item.state === 'merged' || item.state === 'closed' ? '' : `<form method="post" action="/repos/${escapeHtml(repo.id)}/work/${escapeHtml(item.id)}/run">${csrf(viewer)}<button class="btn btn-small" type="submit">${escapeHtml(t('开始工作', 'Start work'))}</button></form>`}
            ${item.state === 'merged' || item.state === 'closed' ? '' : `<form method="post" action="/repos/${escapeHtml(repo.id)}/work/${escapeHtml(item.id)}/scope">${csrf(viewer)}<button class="btn btn-ghost btn-small" type="submit">${escapeHtml(t('Product 范围', 'Product scope'))}</button></form>`}
            ${item.pr_url === null ? '' : `<form method="post" action="/repos/${escapeHtml(repo.id)}/work/${escapeHtml(item.id)}/verify">${csrf(viewer)}<button class="btn btn-ghost btn-small" type="submit">${escapeHtml(t('Test 验证', 'Test verify'))}</button></form>`}
            ${stateOptions === '' ? '' : `<form method="post" action="/repos/${escapeHtml(repo.id)}/work/${escapeHtml(item.id)}/state" class="row">${csrf(viewer)}<select name="state" aria-label="${escapeHtml(t('新状态', 'New state'))}">${stateOptions}</select><button class="btn btn-ghost btn-small" type="submit">${escapeHtml(t('更新状态', 'Update state'))}</button></form>`}
          </div></td>
        </tr>`
      }).join('')
  const workCounts = new Map<string, number>()
  for (const item of workItems) workCounts.set(item.state, (workCounts.get(item.state) ?? 0) + 1)
  const workBoard = `<section class="card" id="board">
    <div class="row between"><h2>${escapeHtml(t('交付看板', 'Delivery board'))}</h2><span class="fine">${workState === undefined ? escapeHtml(t('按工作项状态汇总；点击状态可筛选下面的列表。', 'Grouped by state; click a state to filter the list below.')) : `<a class="link" href="/repos/${escapeHtml(repo.id)}#work">${escapeHtml(t('清除筛选', 'Clear filter'))}</a>`}</span></div>
    <div class="table-scroll"><table class="table-cards table-cards-head"><thead><tr>${WORK_ITEM_STATES.map((state) => `<th><a class="link" href="/repos/${escapeHtml(repo.id)}?workState=${state}#work">${escapeHtml(workItemStateLabel(t, state))}</a></th>`).join('')}</tr></thead><tbody><tr>${WORK_ITEM_STATES.map((state) => `<td data-label="${escapeHtml(workItemStateLabel(t, state))}"><strong>${workCounts.get(state) ?? 0}</strong></td>`).join('')}</tr></tbody></table></div>
  </section>`

  const workCard = `<section class="card">
    <div class="row between"><h2>${escapeHtml(t('工作项', 'Work items'))}</h2><span class="fine">${workState === undefined ? escapeHtml(t('Issue / PR / 状态 / 优先级', 'Issue / PR / state / priority')) : escapeHtml(t(`筛选：${workItemStateLabel(t, workState)}`, `Filter: ${workItemStateLabel(t, workState)}`))}</span></div>
    <form method="post" action="/repos/${escapeHtml(repo.id)}/work" class="form">
      ${csrf(viewer)}
      <div class="row">
        <label class="grow">${escapeHtml(t('标题', 'Title'))} <input name="title" required maxlength="200" /></label>
        <label>${escapeHtml(t('优先级', 'Priority'))} <input name="priority" type="number" min="0" max="100" value="0" class="w-90" /></label>
      </div>
      <div class="row">
        <label class="grow">${escapeHtml(t('Issue URL（可选）', 'Issue URL (optional)'))} <input name="issueUrl" placeholder="https://github.com/owner/repo/issues/1" /></label>
      </div>
      <label>${escapeHtml(t('说明', 'Detail'))} <textarea name="detail" rows="3" placeholder="${escapeHtml(t('用户问题、现状、验收标准。', 'User problem, current state, acceptance criteria.'))}"></textarea></label>
      <button class="btn" type="submit">${escapeHtml(t('创建工作项', 'Create work item'))}</button>
    </form>
    <div class="table-scroll mt-14"><table class="table-cards"><thead><tr><th>${escapeHtml(t('工作项', 'Work item'))}</th><th>${escapeHtml(t('状态', 'State'))}</th><th>${escapeHtml(t('优先级', 'Priority'))}</th><th>Issue / PR</th><th>${escapeHtml(t('任务', 'Job'))}</th><th></th></tr></thead><tbody>${workRows}</tbody></table></div>
  </section>`;
  const prRows = prJobs.length === 0
    ? stateCell(7, { kind: 'empty', title: t('没有待处理的 PR。', 'No pull requests waiting.'), body: t('任务产出 PR 后会出现在这里；没有就是真的没有在等。', 'A pull request appears here once a job opens one; an empty list means nothing is waiting.'), action: { href: `/repos/${escapeHtml(repo.id)}`, label: t('回到仓库', 'Back to repository') } })
    : prJobs.map((job) => {
        const number = /\/pull\/(\d+)/.exec(job.pr_url ?? '')?.[1] ?? ''
        const readiness = mergeReadiness(job)
        const reasons = readiness.reasons.slice(0, 2).join(' · ')
        return `<tr><td data-label="PR"><a href="${escapeHtml(job.pr_url ?? '')}" target="_blank" rel="noreferrer">#${escapeHtml(number)}</a></td><td data-label="${escapeHtml(t('状态', 'Status'))}">${badge(t, job.status)}</td><td data-label="${escapeHtml(t('核实', 'Verified'))}">${readinessBadge(t, readiness.state)}${reasons === '' ? '' : `<br /><small class="muted">${escapeHtml(reasons)}</small>`}</td><td data-label="${escapeHtml(t('审核分', 'Review'))}">${job.review_score === null ? '—' : job.review_score}</td><td data-label="${escapeHtml(t('成本', 'Cost'))}">${escapeHtml(quotaMoney(job.cost_usd * config.quota.usdCny))}</td><td data-label="${escapeHtml(t('创建', 'Created'))}">${escapeHtml(humanTimeShort(job.created_at))}</td><td data-label="${escapeHtml(t('操作', 'Actions'))}"><div class="row"><form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/recheck">${csrf(viewer)}<button class="btn btn-ghost btn-small" type="submit">${escapeHtml(t('重新核实', 'Re-check'))}</button></form>${repo.repo_role === 'maintainer' ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/merge">${csrf(viewer)}<button class="btn btn-ghost btn-small" type="submit">${escapeHtml(t('合并', 'Merge'))}</button></form>` : ''}</div></td></tr>`
      }).join('')
  const deliveryCard = `<section class="card"><h2>${escapeHtml(t('待处理 PR', 'Pull requests to decide'))}</h2>
    ${repo.auto_merge === 0 && prJobs.length >= 3 ? `<div class="banner">${escapeHtml(t(`有 ${prJobs.length} 个 PR 等待合并。如果检查一直全绿，可在仓库设置里开启自动合并。`, `${prJobs.length} pull requests are waiting. If checks stay green, enable auto-merge in repository settings.`))} <a class="link" href="#repo-settings">${escapeHtml(t('去设置', 'Open settings'))}</a></div>` : ''}
    <p class="muted">${escapeHtml(t('合并前会重新检查 PR 状态、checks、commit status、reviews 和 branch protection。', 'Merging re-checks the PR state, checks, commit status, reviews and branch protection.'))}</p>
    ${repo.repo_role === 'maintainer' && prJobs.length > 0 ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/delivery/merge-clean" data-confirm="${escapeHtml(t('逐个重新检查并合并所有 clean PR？有阻塞的会跳过。', 'Re-check and merge all clean PRs? Blocked PRs are skipped.'))}">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('合并所有 clean PR', 'Merge all clean PRs'))}</button></form>` : ''}
    <div class="table-scroll"><table class="table-cards"><thead><tr><th>PR</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('核实', 'Verified'))}</th><th>${escapeHtml(t('审核分', 'Review'))}</th><th>${escapeHtml(t('成本', 'Cost'))}</th><th>${escapeHtml(t('创建', 'Created'))}</th><th></th></tr></thead><tbody>${prRows}</tbody></table></div></section>`
  const lifecycleItems: string[] = []
  if (!repoEnabled) lifecycleItems.push(t('仓库已停用：不会自动或手动运行任务。', 'Repository disabled: no jobs run automatically or manually.'))
  if (flybotAvailable && instance?.status !== 'ready') lifecycleItems.push(t(`FlyBot ${instance === undefined ? '未创建' : statusLabel(t, instance.status)}：任务不会运行。`, `FlyBot is ${instance === undefined ? 'not created' : statusLabel(t, instance.status)}: jobs will not run.`))
  if (!credentialOk) lifecycleItems.push(t('GitHub 凭据失效：调度已暂停。', 'GitHub credentials are invalid: scheduling is paused.'))
  if (repo.auto_iterate === 1 && (!repoEnabled || !flybotReady)) lifecycleItems.push(t('自动工作已开启，但当前不会运行。', 'Auto work is on but cannot run right now.'))
  const lifecycleActions = [
    !repoEnabled ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/enable">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('启用仓库', 'Enable repository'))}</button></form>` : '',
    flybotAvailable && instance?.status !== 'ready' ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('启动 FlyBot', 'Start FlyBot'))}</button></form>` : '',
    !credentialOk ? `<a class="btn btn-ghost" href="/auth/github/reauthorize?next=${encodeURIComponent(`/repos/${repo.id}`)}">${escapeHtml(t('重新授权 GitHub', 'Re-authorize GitHub'))}</a>` : '',
  ].join('')
  const lifecycleBanner = lifecycleItems.length === 0 ? '' : `<div class="banner bad"><strong>${escapeHtml(t('当前状态', 'Current state'))}</strong><ul>${lifecycleItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>${lifecycleActions === '' ? '' : `<div class="row">${lifecycleActions}</div>`}</div>`
  // #359: an unapproved plan gets a deadline on the page it blocks, not only a
  // "waiting" badge on the job, with the three ways out named.
  const planBanner = input.pendingPlan === undefined ? '' : `<div class="banner"><strong>${escapeHtml(t('计划待批准', 'Plan awaiting approval'))}</strong> ${escapeHtml(t(`计划 ${input.pendingPlan.jobId} 将在 ${input.pendingPlan.deadline} 过期。`, `Plan ${input.pendingPlan.jobId} expires on ${input.pendingPlan.deadline}.`))} ${escapeHtml(t('请在过期前批准、拒绝，或重新创建计划；过期后工作项会关闭，重新创建计划即可继续。', 'Approve it, reject it, or create a new plan before that date; after it the work item closes and a new plan is the way back.'))} <a class="link" href="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(input.pendingPlan.jobId)}">${escapeHtml(t('查看计划并批准 / 拒绝', 'Open the plan to approve or reject'))}</a></div>`
  const dangerCard = `<section class="card">
    <h2>${escapeHtml(t('危险操作', 'Danger zone'))}</h2>
    <p class="muted">${escapeHtml(t('这里的操作只影响 Fledge 连接，不会删除 GitHub 仓库。停止调度会保留实例和历史；停止 FlyBot 会停止容器；删除会移除连接、实例、任务和 token。', 'These actions affect the Fledge connection only; the GitHub repository is not deleted. Stop scheduling keeps the instance and history; Stop FlyBot stops the container; Delete removes the connection, instance, jobs and tokens.'))}</p>
    <div class="row">
      ${repoEnabled ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/disable">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('停止调度', 'Stop scheduling'))}</button></form>` : `<form method="post" action="/repos/${escapeHtml(repo.id)}/enable">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('恢复调度', 'Resume scheduling'))}</button></form>`}
      ${flybotAvailable ? (instance?.status === 'ready' ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance/stop" data-confirm="${escapeHtml(t('停止这个仓库的 FlyBot 实例？正在运行的工作会中断。', 'Stop the FlyBot instance for this repository? Running work will be interrupted.'))}">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('停止 FlyBot', 'Stop FlyBot'))}</button></form>` : `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('启动 FlyBot', 'Start FlyBot'))}</button></form>`) : ''}
    </div>
    <form method="post" action="/repos/${escapeHtml(repo.id)}/delete" class="form">
      ${csrf(viewer)}
      <label>${escapeHtml(t('输入仓库名', 'Type the repository name'))} <code>${escapeHtml(repo.name)}</code> ${escapeHtml(t('确认删除', 'to confirm deletion'))} <input name="confirmName" autocomplete="off" required /></label>
      <button class="btn btn-danger" type="submit">${escapeHtml(t('删除仓库连接', 'Delete repository connection'))}</button>
    </form>
  </section>`
  // #539 review: the memory page existed but nothing linked to it, so it was
  // reachable only by typing the URL. It is a page, not a section of this one,
  // so the entry point is a card rather than a tab that would only scroll.
  const memoryCard = `<section class="card" id="repo-memory">
    <h2>${escapeHtml(t('项目记忆', 'Project memory'))}</h2>
    <p class="muted">${escapeHtml(t('这个仓库的版本化记忆：决策、约定和踩过的坑，按角色可见，每次读到的是确定的版本而不是摘要。', "This repository's versioned memory: decisions, conventions and hard-won lessons, scoped by role, and always read as an exact revision rather than a summary."))}</p>
    <p><a class="link" href="/repos/${escapeHtml(repo.id)}/memory">${escapeHtml(t('打开项目记忆', 'Open project memory'))}</a></p>
  </section>`
  // #234: the page was one long column of sixteen cards, so the things a user
  // acts on sat under configuration. The six sections below are a regroup of
  // cards that already render here - nothing new is computed - and #overview is
  // the section a bare /repos/:id opens. public/repoTabs.js follows the hash,
  // including the inner anchors that existed before the tabs.
  const repoTabs = `<nav class="repo-subnav" id="repo-tabs" aria-label="${escapeHtml(t('仓库分区', 'Repository sections'))}">${([['overview', '概览', 'Overview'], ['delivery', '交付', 'Delivery'], ['work', '工作', 'Work'], ['team', '团队', 'Team'], ['settings', '设置', 'Settings'], ['danger', '危险操作', 'Danger']] as const).map(([id, zh, en]) => `<a class="repo-tab" id="repo-tab-${id}" href="#${id}"${id === 'overview' ? ' aria-current="page"' : ''}>${escapeHtml(t(zh, en))}</a>`).join('')}</nav>`
  const repoSection = (id: string, content: string): string => `<section class="repo-section" id="${id}" data-repo-section="${id}" aria-labelledby="repo-tab-${id}">${content}</section>`
  const jobsCard = `  <section class="card" id="jobs">
    <h2>${escapeHtml(t('任务', 'Jobs'))}</h2>
    ${jobTable(locale, jobs, emptyJobs, { id: 'repo-jobs-table', ranks })}
    ${pager(`/repos/${repo.id}`, 'jobsPage', jobsPage, jobsTotal, 10, t, {}, '#jobs')}
  </section>`
  const usage = input.usage
  const usageLine = usage === undefined ? '' : `<p class="muted" data-usage-line>${escapeHtml(t(
    `已用仓库 ${usage.repos}/${usage.reposCap === 0 ? '∞' : usage.reposCap}，FlyBot 实例 ${usage.instances}/${usage.instancesCap === 0 ? '∞' : usage.instancesCap}`,
    `Repositories used ${usage.repos}/${usage.reposCap === 0 ? '∞' : usage.reposCap}, FlyBot instances ${usage.instances}/${usage.instancesCap === 0 ? '∞' : usage.instancesCap}`,
  ))}</p>`
  const settingsCards = `  <section class="cols">
    <div class="card" id="repo-settings">
      <h2>${escapeHtml(t('迭代目标', 'Iteration goal'))}</h2>
      ${usageLine}
      <form method="post" action="/repos/${escapeHtml(repo.id)}/settings" class="form">
        ${csrf(viewer)}
        ${goalTemplateSelect(t, 'goal-settings')}
        <textarea id="goal-settings" name="goal" rows="5" placeholder="${escapeHtml(t('这个仓库每次迭代应该关注什么？', 'What should each iteration focus on for this repository?'))}">${escapeHtml(repo.goal)}</textarea>
        <label>${escapeHtml(t('目标分支', 'Target branch'))}${infoTip(t('PR 会合入这个分支；Fledge 仍会新建工作分支，不会直接 push 目标分支。留空使用仓库默认分支。', 'Pull requests target this branch; Fledge still creates a working branch and never pushes to the target branch. Leave blank for the repository default.'))} <input name="targetBranch" value="${escapeHtml(targetBranch)}" placeholder="main / develop / release/2.x" autocomplete="off" /></label>
        <label>${escapeHtml(t('你的角色', 'Your role'))}${infoTip(t('角色来自你在这个 GitHub 仓库的权限。admin/maintain 可选 maintainer 或 developer；其他权限只能选 developer。平台管理员不能替你改。', 'The role comes from your permission on this GitHub repository. admin/maintain can choose maintainer or developer; every other permission can only be developer. Platform admins cannot change it for you.'))} <select name="repoRole" required>${repoRole === null ? `<option value="" selected disabled>${escapeHtml(t('请选择…', 'Choose…'))}</option>` : ''}${allowedRoles.map((role) => `<option value="${role}"${repoRole === role ? ' selected' : ''}>${escapeHtml(repoRoleLabel(t, role))}</option>`).join('')}</select></label>
        <div class="row" data-auto-group>
          <label class="check"><input type="checkbox" name="auto" value="1" ${repo.auto_iterate === 1 ? 'checked' : ''} /> ${escapeHtml(t('自动迭代', 'Auto-iterate'))}</label>
          <label class="check"><input type="checkbox" name="enabled" value="1" ${repo.enabled === 1 ? 'checked' : ''} /> ${escapeHtml(t('启用', 'Enabled'))}</label>
          <label>${escapeHtml(t('发现间隔', 'Discovery interval'))}${infoTip(t('没有工作项时按这个间隔做一次发现（最少 60 分钟）；最多提出一个具体 issue，不会直接开 PR。有工作项时按全局最短工作间隔推进。', 'With no work this interval runs one discovery session (minimum 60 minutes) that may open at most one concrete issue, never a PR. Open work uses the global short work cooldown.'))} <select name="interval">${intervalOptions(t, Math.max(60, repo.interval_minutes), DISCOVERY_INTERVALS)}</select></label>
        </div>
        <div class="row" data-review-group>
          <label class="check"><input type="checkbox" name="review" value="1" ${reviewerEnabled ? 'checked' : ''} ${canReview ? '' : 'disabled'} data-role-can-review="${githubCanReview ? '1' : '0'}" /> ${escapeHtml(t('启用 PR 审核', 'Enable PR reviewer'))}</label>
          <label>${escapeHtml(t('审核间隔', 'Review interval'))} <select name="reviewInterval" ${canReview ? '' : 'disabled'}>${reviewIntervalOptions(t, repo.review_interval_minutes)}</select></label>
        </div>
        <div class="row" data-merge-group>
          <label class="check"><input type="checkbox" name="autoMerge" value="1" ${canMaintain && repo.auto_merge === 1 ? 'checked' : ''} ${canMaintain ? '' : 'disabled'} /> ${escapeHtml(t('允许 maintainer 自动合并 PR', 'Allow maintainer auto-merge'))}${infoTip(t('默认关闭。只有 maintainer 能开启；开启后 Fledge 会在 PR 检查通过且没有 changes requested 时执行 squash merge。developer 不能开启。', 'Off by default. Only a maintainer can enable it. When on, Fledge squash-merges a PR only after checks are green and no changes are requested. Developers cannot enable it.'))}</label>
        </div>
        <label class="check"><input type="checkbox" name="planRequired" value="1" ${repo.plan_required === 1 ? 'checked' : ''} /> ${escapeHtml(t('先出计划，批准后执行', 'Plan first; execute only after approval'))}${infoTip(t('开启后“立即运行”先生成计划；maintainer 批准计划后才写代码。', 'When on, Run now creates a plan; code is written only after a maintainer approves it.'))}</label>
        <div class="row">
          <label class="grow">${escapeHtml(t('允许修改路径（可选）', 'Allowed paths (optional)'))}${infoTip(t('逗号或换行分隔。批准计划时会填入执行 prompt；不是硬性沙箱。', 'Comma or newline separated. Included in the execution prompt at plan approval; not a hard sandbox.'))} <input name="allowPaths" value="${escapeHtml(repo.allow_paths)}" placeholder="src/, docs/" /></label>
          <label class="grow">${escapeHtml(t('禁止修改路径（可选）', 'Forbidden paths (optional)'))} <input name="denyPaths" value="${escapeHtml(repo.deny_paths)}" placeholder=".github/, deploy/" /></label>
        </div>
        <div class="row">
          <label>${escapeHtml(t('合并方式', 'Merge method'))} <select name="mergeMethod">${['squash', 'merge', 'rebase'].map((method) => `<option value="${method}"${(repo.merge_method || 'squash') === method ? ' selected' : ''}>${method}</option>`).join('')}</select></label>
          <label>${escapeHtml(t('团队阶段门禁', 'Team stage gate'))} <select name="stageMode">${STAGE_MODES.map((mode) => `<option value="${mode}"${(repo.stage_mode || 'off') === mode ? ' selected' : ''}>${escapeHtml(mode === 'enforced' ? t('强制', 'Enforced') : mode === 'shadow' ? t('观察', 'Shadow') : t('关闭', 'Off'))}</option>`).join('')}</select></label>
        </div>
        <p class="fine">${escapeHtml(t('强制模式下，实现任务必须带范围、验收标准、失败/通过测试证据和 Dev/Test 分工，审核任务必须带 Reviewer 和评分；否则任务失败且不会自动合并。观察模式只记录不阻断。', 'In enforced mode an implement job needs scope, acceptance criteria, red/green test evidence and Dev/Test roles; a review job needs a Reviewer and a score. Shadow mode records without blocking.'))}</p>
        <div class="row">
          <label class="check"><input type="checkbox" name="requireProtection" value="1" ${repo.require_protection === 1 ? 'checked' : ''} /> ${escapeHtml(t('自动合并前要求 branch protection', 'Require branch protection before auto-merge'))}${infoTip(t('开启后 Fledge 会检查保护规则、required checks 和 required approvals；读不到保护规则时不会自动合并。', 'When on, Fledge checks the protection rule, required checks and required approvals; if the rule cannot be read, it will not auto-merge.'))}</label>
        </div>
        <p class="fine">${escapeHtml(t('Branch protection', 'Branch protection'))}: <code>${escapeHtml(repo.protection_state ?? 'unknown')}</code>${repo.protection_checked_at === null ? '' : ` · ${escapeHtml(humanTimeShort(repo.protection_checked_at))}`}</p>
        <div class="row">
          <label>${escapeHtml(t('仓库月度预算（元）', 'Monthly repository budget (CNY)'))} <input name="monthlyBudget" type="number" min="0" max="10000" step="0.01" value="${repo.monthly_budget_cny.toFixed(2)}" /></label>
          <label>${escapeHtml(t('单任务预算（元）', 'Per-job budget (CNY)'))} <input name="jobBudget" type="number" min="0" max="10000" step="0.01" value="${repo.job_budget_cny.toFixed(2)}" /></label>
          <label>${escapeHtml(t('超出单任务预算时', 'When the per-job budget is exceeded'))}${infoTip(t('在任务的下一个检查点生效：此时已经记录了花费，不需要再调用一次模型。', 'Takes effect at the job\'s next checkpoint, where the spend is already recorded and no extra model call is needed.'))}
            <select name="jobBudgetAction">
              <option value="alert" ${repo.job_budget_action === 'alert' ? 'selected' : ''}>${escapeHtml(t('只提醒（默认）', 'Alert only (default)'))}</option>
              <option value="pause" ${repo.job_budget_action === 'pause' ? 'selected' : ''}>${escapeHtml(t('暂停任务，可从断点恢复', 'Pause the job; it can resume from its checkpoint'))}</option>
              <option value="cancel" ${repo.job_budget_action === 'cancel' ? 'selected' : ''}>${escapeHtml(t('取消任务', 'Cancel the job'))}</option>
            </select>
          </label>
        </div>
        <p class="fine">${escapeHtml(t('本月已用', 'Spent this month'))} ${escapeHtml(quotaMoney(repoSpendCny))}${repo.monthly_budget_cny > 0 ? ` / ${escapeHtml(quotaMoney(repo.monthly_budget_cny))}` : ''}</p>
        <div class="row">
          <label class="grow">${escapeHtml(t('可用模型', 'Available models'))}${infoTip(t('提供方和模型在 Settings 里管理；这里只选择这个仓库允许使用的模型。', 'Providers and models are managed in Settings; select only the models this repository may use.'))}
            ${models.length === 0
              ? `<span class="muted">${escapeHtml(t('还没有模型。先到 Settings 添加提供方和模型。', 'No models yet. Add a provider and models in Settings.'))}</span>`
              : `<span class="list">${[...new Set(models.map((model) => model.provider_label))].map((provider) => `<div class="mb-6"><strong>${escapeHtml(provider)}</strong><br />${models.filter((model) => model.provider_label === provider).map((model) => `<label class="check"><input type="checkbox" name="modelIds" value="${escapeHtml(model.id)}" ${repoModelIds.has(model.id) ? 'checked' : ''} /> ${escapeHtml(model.label)} <small class="muted">${escapeHtml(model.model)}</small></label>`).join('')}</div>`).join('')}</span>`}
          </label>
        </div>
        <div class="row">
          <label class="grow">${escapeHtml(t('允许的提供方（可选）', 'Allowed providers (optional)'))}${infoTip(t('只允许这个仓库使用勾选的提供方；一个都不勾表示不限制。提供方本身由你在 Settings 里添加。', 'Restrict this repository to the checked providers; none checked means no allowlist. Providers are added in Settings.'))}
            ${providers.length === 0
              ? `<span class="muted">${escapeHtml(t('还没有提供方。先到 Settings 添加。', 'No providers yet. Add one in Settings.'))}</span>`
              : `<span class="list">${providers.map((provider) => `<label class="check"><input type="checkbox" name="allowedProviderIds" value="${escapeHtml(provider.id)}" ${provider.allowed === 1 ? (providerPolicy.has(provider.id) ? 'checked' : '') : 'disabled'} /> ${escapeHtml(provider.label)} <small class="muted">${escapeHtml(provider.region === '' ? t('未标注区域', 'no region') : provider.region)}${provider.allowed === 1 ? '' : ` · ${escapeHtml(t('已停用', 'disabled'))}`}</small>${provider.data_policy_url === '' ? '' : ` · <a class="link" href="${escapeHtml(provider.data_policy_url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(t('数据政策', 'Data policy'))}</a>`}</label>`).join('')}</span>`}
          </label>
          <label>${escapeHtml(t('区域约束（可选）', 'Region constraint (optional)'))} <input name="providerRegion" value="${escapeHtml(repo.required_region ?? '')}" maxlength="80" placeholder="eu" /></label>
        </div>
        <p class="fine">${escapeHtml(t('区域约束比较提供方标注的区域（不区分大小写）；留空表示不限区域。这个策略只作用于当前仓库。', 'The region constraint compares the provider region label case-insensitively; empty allows any region. This policy applies to this repository only.'))}</p>
        <label>${escapeHtml(t('默认模型', 'Default model'))} <select name="defaultModelId"><option value="">${escapeHtml(t('平台默认', 'Platform default'))}</option>${models.map((model) => `<option value="${escapeHtml(model.id)}"${repoDefaultModelId === model.id ? ' selected' : ''}>${escapeHtml(model.provider_label)} · ${escapeHtml(model.label)}${repoModelIds.has(model.id) ? '' : ' *'}</option>`).join('')}</select></label>
        ${models.length === 0 ? '' : `<div class="row bot-models">${([['chief', 'Chief'], ['lead', 'Lead'], ['product', 'Product'], ['test', 'Test'], ['security', 'Security'], ['reviewer', 'Reviewer'], ['dev1', 'Dev-1'], ['dev2', 'Dev-2']] as const).map(([role, label]) => `<label>${escapeHtml(label)} <select name="botModel_${role}"><option value="">${escapeHtml(t('跟随默认', 'Follow default'))}</option>${models.filter((model) => repoModelIds.has(model.id)).map((model) => `<option value="${escapeHtml(model.id)}"${botModelMap.get(role) === model.id ? ' selected' : ''}>${escapeHtml(model.provider_label)} · ${escapeHtml(model.label)}</option>`).join('')}</select></label>`).join('')}</div>
        <p class="fine">${escapeHtml(t('每个 bot 可以单独选择模型；不选则跟随默认。保存选择后，空闲时点击“应用模型并重启工作区”才会生效，Fledge 会通过 DSH 把模型分配给对应 bot。', 'Each bot can choose a model; empty follows the default. After saving, use "Apply models and restart workspace" while idle; Fledge assigns the model through DSH.'))}</p>`}
        ${roleMissing ? `<p class="fine">${escapeHtml(t('先选择你的角色，审核和自动合并才会生效。', 'Choose your role before review or auto-merge can take effect.'))}</p>` : !githubCanReview ? `<p class="fine">${escapeHtml(t('你在这个上游没有 admin/maintain 权限，审核角色不可用。', 'You do not have admin/maintain permission on this upstream, so the reviewer role is unavailable.'))}</p>` : !canMaintain ? `<p class="fine">${escapeHtml(t('developer 不能启用 PR 审核或自动合并；切换为 maintainer 后才可用。', 'A developer cannot enable PR review or auto-merge; switch to maintainer first.'))}</p>` : ''}
        ${advanced ? `<details class="fine advanced-help"><summary>${escapeHtml(t('团队与调度规则', 'Team and scheduling rules'))}</summary>
          <p>${escapeHtml(t('保存目标后，团队 playbook 会按新目标更新：总控 → 负责人 → 产品/测试/安全/审核/开发。审核角色只有勾选“启用 PR 审核”后才会参与。', 'Saving the goal updates the team playbook: Chief -> Lead -> Product/Test/Security/Reviewer/Dev. The Reviewer takes part only when "Enable PR reviewer" is checked.'))}</p>
          <p>${escapeHtml(t('间隔是最小运行间隔；上一轮未结束时本轮会跳过。手动运行会重置迭代倒计时，审核任务不会。平台全局同时最多 2 个任务。', 'The interval is a minimum gap; a run is skipped while the previous one is active. A manual run resets the countdown; a review does not. The platform runs at most two jobs at a time.'))}</p>
        </details>` : ''}
        <button class="btn" type="submit">${escapeHtml(t('保存', 'Save'))}</button>
      </form>
      ${repo.models_dirty === 1 ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/models/apply" class="mt-12">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('应用模型并重启工作区', 'Apply models and restart workspace'))}</button><p class="fine">${escapeHtml(t('有运行中的任务时会拒绝重启。', 'Restart is refused while a job is running.'))}</p></form>` : ''}
    </div>
    <div class="card" id="connection">
      <h2>${escapeHtml(t('连接', 'Connection'))}</h2>
      <p class="muted">${escapeHtml(t('GitHub token 已加密保存；页面不会显示明文。如果仓库或 token 变了，删除后重新添加。', 'The GitHub token is encrypted and never rendered in plain text. If the repository or token changes, delete and add it again.'))}</p>
      <p class="fine">${escapeHtml(t('审核最近运行', 'Last review'))} ${escapeHtml(repo.last_review_at === null ? t('尚未运行', 'Not run yet') : humanTimeShort(repo.last_review_at))}${reviewStatus}</p>
      <div class="row mb-12">
        <form method="post" action="/repos/${escapeHtml(repo.id)}/refresh">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('重新检测上游 / fork', 'Refresh upstream / fork'))}</button></form>
      </div>
      <p class="fine">${escapeHtml(t('平台只通过 GitHub API 读取元数据、创建 fork 和分支/PR；不会 clone 到公共磁盘。', 'The platform only uses the GitHub API to read metadata, create forks and open branches/PRs; it never clones to public disk.'))}</p>
    </div>
  </section>`
  const body = `<div class="repo-page">${repoHeader}${repoTabs}${repoSection('overview', `${planBanner}${lifecycleBanner}${triageCard}${appAttribution ? `<div class="banner">${escapeHtml(t('当前 GitHub App 操作的 issue / PR 会以 Fledge-Platform 身份创建。重新用 GitHub 登录并授予 repo 权限后，将以你的身份创建。', 'GitHub App issue/PR actions are currently attributed to Fledge-Platform. Re-authorize your GitHub account with repo access to create them as yourself.'))} <a class="link" href="/auth/github/reauthorize?next=${encodeURIComponent(`/repos/${repo.id}`)}">${escapeHtml(t('重新授权 GitHub', 'Re-authorize GitHub'))}</a></div>` : ''}${inboxSection(locale, viewer, questions, `/repos/${repo.id}`)}${chiefCard}${memoryCard}`)}${repoSection('delivery', `${workflowFailuresCard}${postmortemCard}${reviewTrendCard}${deliveryCard}${jobsCard}`)}${repoSection('work', `${workBoard}${workCard}`)}${repoSection('team', `${roleCard}${instanceNotice}${instanceCard}`)}${repoSection('settings', settingsCards)}${repoSection('danger', dangerCard)}</div>`
  return layout({ title: `${upstreamOwner}/${upstreamName}`, viewer, body: `${body}${advanced ? '' : '<script src="/assets/chief.js" defer></script>'}<script src="/assets/repoTabs.js" defer></script>`, config, locale, path: `/repos/${repo.id}`, active: 'dashboard', notice, error })
}

function workItemStageLabel(t: Translate, state: string): string {
  const map: Record<string, [string, string]> = {
    proposed: ['范围', 'Scope'],
    triaged: ['范围', 'Scope'],
    assigned: ['范围', 'Scope'],
    in_progress: ['实现', 'Implement'],
    pr_ready: ['验证', 'Verify'],
    in_review: ['审核', 'Review'],
    changes_requested: ['修改', 'Fix'],
    approved: ['合并', 'Merge'],
    merged: ['完成', 'Done'],
    closed: ['关闭', 'Closed'],
  }
  const entry = map[state] ?? ['—', '—']
  return t(entry[0], entry[1])
}

function teamRoleLabel(t: Translate, role: string): string {
  const labels: Record<string, [string, string]> = {
    chief: ['总控', 'Chief'],
    lead: ['负责人', 'Lead'],
    product: ['产品', 'Product'],
    test: ['测试', 'Test'],
    security: ['安全', 'Security'],
    reviewer: ['审核', 'Reviewer'],
    dev1: ['开发 1', 'Dev-1'],
    dev2: ['开发 2', 'Dev-2'],
  }
  const value = labels[role]
  return value === undefined ? role : t(value[0], value[1])
}

function activityLabel(t: Translate, activity: string): string {
  if (activity === 'thinking') return t('思考中', 'Thinking')
  if (activity === 'working') return t('工作中', 'Working')
  if (activity === 'idle') return t('空闲', 'Idle')
  if (activity === 'unknown') return t('未知', 'Unknown')
  return activity
}

function teamSession(team: ReturnType<typeof parseTeam>, role: string): string {
  if (team === null) return ''
  if (role === 'chief') return team.chief
  if (role === 'lead') return team.lead
  if (role === 'product') return team.product
  if (role === 'test') return team.test
  if (role === 'security') return team.security
  if (role === 'reviewer') return team.reviewer ?? ''
  if (role === 'dev1') return team.dev1
  if (role === 'dev2') return team.dev2
  return ''
}

function teamTimeline(t: Translate, timeline: Array<{ role: string; label: string; at: number; calls: number; kind: string; activity: string; tool: string; step: string }> | undefined): string {
  if (timeline === undefined || timeline.length === 0) return `<p class="muted">${escapeHtml(t('还没有活动记录。', 'No activity yet.'))}</p>`
  return `<div class="list">${timeline.map((entry) => {
    const what = entry.kind === 'active'
      ? `${activityLabel(t, entry.activity)}${entry.tool === '' ? '' : ` · ${entry.tool}${entry.step === '' ? '' : ` · ${entry.step}`}`}`
      : t('刚结束', 'ended')
    return `<div class="list-row"><div class="list-main"><strong>${escapeHtml(teamRoleLabel(t, entry.role))}</strong><small>${escapeHtml(what)} · ${entry.calls} ${escapeHtml(t('次调用', 'calls'))} · ${escapeHtml(humanTimeShort(new Date(entry.at).toISOString()))}</small></div></div>`
  }).join('')}</div>`
}

export function teamPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repo: RepoRow
  instance?: RepoInstanceRow
  state?: TeamLiveState
  stateError?: string
  jobs: JobRow[]
  jobsPage?: number
  jobsTotal?: number
  queued?: JobRow[]
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repo, instance, state, stateError, jobs, notice, error } = input
  const jobsPage = input.jobsPage ?? 1
  const jobsTotal = input.jobsTotal ?? jobs.length
  const ranks = input.queued === undefined ? undefined : queueRanks(input.queued)
  const t = translator(locale)
  const team = instance === undefined ? null : parseTeam(instance.team_json)
  const ready = instance?.status === 'ready' && team !== null
  const roleKeys = ['chief', 'lead', 'product', 'test', 'security', 'reviewer', 'dev1', 'dev2']
  const roles = roleKeys.map((role) => {
    const live = state?.bots.find((bot) => bot.role === role)
    return {
      role,
      label: teamRoleLabel(t, role),
      sessionId: live?.sessionId ?? teamSession(team, role),
      activity: live?.activity ?? 'unknown',
      calls: live?.calls ?? 0,
      tool: live?.tool ?? '',
      step: live?.step ?? '',
      since: live?.since ?? null,
      disabled: live?.disabled ?? (role === 'reviewer' && repo.reviewer_enabled !== 1),
    }
  })
  const roleCards = roles
    .map(
      (role) => `<div class="team-role${role.activity === 'thinking' || role.activity === 'working' ? ' is-thinking' : ''}${role.disabled ? ' is-disabled' : ''}" data-role="${escapeHtml(role.role)}">
        <b>${escapeHtml(role.label)}</b>
        <span class="team-activity">${escapeHtml(role.disabled ? t('未启用', 'Disabled') : activityLabel(t, role.activity))}</span>
        <small class="team-tool" data-team-tool>${escapeHtml(role.disabled ? '' : `${role.tool}${role.step === '' ? '' : ` · ${role.step}`}`)}</small>
        <small class="team-elapsed" data-team-since="${role.since === null ? '' : role.since}"></small>
        <small class="team-calls">${!role.disabled && role.calls > 0 ? `${role.calls} ${escapeHtml(t('次调用', 'calls'))}` : ''}</small>
      </div>`,
    )
    .join('')
  const sessionDetails = roles.some((role) => role.sessionId !== '')
    ? `<details class="fine session-details"><summary>${escapeHtml(t('查看 session ID', 'View session IDs'))}</summary><div class="session-list">${roles.filter((role) => role.sessionId !== '').map((role) => `<code>${escapeHtml(role.label)}: ${escapeHtml(role.sessionId)}</code>`).join('')}</div></details>`
    : ''
  const questions = state?.questions ?? []
  const questionHtml = questions.length === 0
    ? `<p class="muted">${escapeHtml(t('没有待回答的问题。', 'No open questions.'))}</p>`
    : `<div class="list">${questions.map((question) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(question.question || t('团队提问', 'Team question'))}</strong>${question.options.length === 0 ? '' : `<small>${question.options.map((option) => escapeHtml(option)).join(' · ')}</small>`}</div></div>`).join('')}</div>`
  const stateErrorHtml = stateError === undefined ? '' : renderState({ kind: 'error', title: t('读取团队状态失败。', 'Could not read the team state.'), body: stateError, action: { href: `/repos/${escapeHtml(repo.id)}/team`, label: t('重试', 'Try again') } })
  const instanceActions = config.flybot.instanceImage === ''
    ? ''
    : instance === undefined || instance.status === 'failed' || instance.status === 'stopped'
      ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(t('启动 FlyBot', 'Start FlyBot'))}</button></form>`
      : instance.status === 'ready'
        ? ''
        : `<form method="post" action="/repos/${escapeHtml(repo.id)}/instance" data-confirm="${escapeHtml(t('重新初始化 FlyBot 会重建实例，正在运行的工作可能中断。继续？', 'Reinitializing FlyBot rebuilds the instance and may interrupt running work. Continue?'))}">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('重新初始化 FlyBot', 'Reinitialize FlyBot'))}</button></form>`
  const guidanceForm = ready
    ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/team/guidance" class="form">
        ${csrf(viewer)}
        <label>${escapeHtml(t('发送给', 'Send to'))}
          <select name="target">
            ${roles.filter((role) => !role.disabled).map((role) => `<option value="${escapeHtml(role.role)}"${role.role === 'lead' ? ' selected' : ''}>${escapeHtml(role.label)}</option>`).join('')}
          </select>
        </label>
        <label>${escapeHtml(t('新的指导意见', 'New guidance'))}<textarea name="text" rows="4" required placeholder="${escapeHtml(t('例如：先不要改代码，汇报当前实现和风险。', 'For example: do not change code yet; report the current implementation and risks.'))}"></textarea></label>
        <button class="btn" type="submit">${escapeHtml(t('发送给团队', 'Send to team'))}</button>
      </form>`
    : `<p class="muted">${escapeHtml(t('实例就绪后可以给团队发送指导意见。', 'Guidance can be sent after the instance is ready.'))}</p>`
  const body = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('团队', 'TEAM'))}</div>
        <h1>${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}</h1>
        <p class="muted">${instance === undefined ? escapeHtml(t('未创建实例', 'No instance')) : `${badge(t, instance.status)} <span class="muted">${escapeHtml(instance.container)}</span>`} · <a href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('返回仓库', 'Back to repository'))}</a></p>
      </div>
      <div class="row">
        ${instanceActions}
        ${ready ? `<button class="btn btn-ghost" type="button" data-team-stop>${escapeHtml(t('请求暂停', 'Request stop'))}</button>` : ''}
        <button class="btn btn-ghost" type="button" data-reload>${escapeHtml(t('刷新', 'Refresh'))}</button>
      </div>
    </div>
  </section>
  ${stateErrorHtml}
  <p class="fine" data-team-control role="status" aria-live="polite"></p>
  <div class="banner bad" data-team-stale role="alert" hidden></div>
  <section class="card" id="team-live" data-team-api="${ready ? `/api/repos/${escapeHtml(repo.id)}/team` : ''}" data-team-events="${ready ? `/api/repos/${escapeHtml(repo.id)}/team/events` : ''}" data-team-answer="/api/repos/${escapeHtml(repo.id)}/team/answer" data-team-stop-url="/api/repos/${escapeHtml(repo.id)}/team/stop" data-team-csrf="${escapeHtml(viewer.csrfToken)}" data-team-locale="${escapeHtml(locale)}">
    <div class="row between"><h2>${escapeHtml(t('团队状态', 'Team status'))}</h2><span class="fine">${escapeHtml(t('实时更新', 'Live'))} · <span data-team-updated>—</span></span></div>
    <div class="team-grid">${roleCards}</div>
    ${sessionDetails}
  </section>
  <section class="card">
    <h2>${escapeHtml(t('最近活动', 'Recent activity'))}</h2>
    <div data-team-timeline>${teamTimeline(t, state?.timeline)}</div>
  </section>
  <section class="cols">
    <div class="card"><h2>${escapeHtml(t('待回答的问题', 'Open questions'))}</h2><div id="team-questions">${questionHtml}</div></div>
    <div class="card"><h2>${escapeHtml(t('发送指导意见', 'Send guidance'))}</h2>${guidanceForm}</div>
  </section>
  <section class="card" id="jobs">
    <h2>${escapeHtml(t('最近任务', 'Recent jobs'))}</h2>
    ${jobTable(locale, jobs, { body: t('去这个仓库的页面运行第一个任务；每次运行最多开一个 PR。', 'Run the first job from this repository page; each run opens at most one pull request.'), action: { href: `/repos/${escapeHtml(repo.id)}`, label: t('去仓库运行', 'Run from the repository') } }, { id: 'team-jobs-table', ranks })}
    ${pager(`/repos/${repo.id}`, 'jobsPage', jobsPage, jobsTotal, 10, t, {}, '#jobs')}
  </section>
  <script src="/assets/team.js" defer></script>`
  return layout({ title: t('团队工作台', 'Team console'), viewer, body, config, locale, path: `/repos/${repo.id}/team`, active: 'dashboard', notice, error })
}

export function settingsPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  tokens: ApiTokenRow[]
  sessions: SessionRow[]
  currentSessionHash: string
  providers: Array<ModelProviderRow & { models: ProviderModelRow[] }>
  discoveredProvider?: string
  discovered?: string[]
  newToken?: string
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, tokens, sessions, currentSessionHash, providers, discoveredProvider, discovered = [], newToken, notice, error } = input
  const t = translator(locale)
  const user = viewer.user
  const quota = quotaView(user, config)
  const canPrivate = config.allowPrivateModelUrls || viewer.user.allow_private_models === 1 || viewer.user.role === 'superadmin'
  const customEmail = (user.notify_email ?? '').trim()
  const resolvedEmail = customEmail !== '' ? customEmail : (user.email ?? '')
  const maskedEmail = resolvedEmail === '' ? '' : maskEmail(resolvedEmail)
  const hasEmail = resolvedEmail !== ''
  const tokenRows = tokens.length === 0
    ? stateCell(6, { kind: 'empty', title: t('还没有 API token。', 'No API tokens yet.'), body: t('外部控制室读取指标需要一枚 token；在同一页下面创建一个。', 'An external control room needs one token to read metrics; create one lower on this page.'), action: { href: '#tokens', label: t('创建 token', 'Create a token') } })
    : tokens
        .map((token) => {
          // #355: the expiry is visible as a date, and an expired row says so
          // instead of looking live; the scope is shown because it decides what
          // the token may reach.
          const expired = token.expires_at !== null && Date.parse(token.expires_at) <= Date.now()
          const expires = token.expires_at === null
            ? t('永不过期', 'Never')
            : `${token.expires_at.slice(0, 10)}${expired ? ` · ${t('已过期', 'expired')}` : ''}`
          return `<tr><td><code>${escapeHtml(token.prefix)}…</code></td><td>${escapeHtml(token.name)}</td><td><code>${escapeHtml(token.scope)}</code></td><td>${escapeHtml(expires)}</td><td>${escapeHtml(humanTimeShort(token.last_used_at))}</td><td><form method="post" action="/settings/tokens/${escapeHtml(token.id)}/revoke">${csrf(viewer)}<button class="link" type="submit">${escapeHtml(t('撤销', 'Revoke'))}</button></form></td></tr>`
        })
        .join('')
  const sessionRows = sessions.length === 0
    ? stateCell(4, { kind: 'empty', title: t('只有当前这一个会话。', 'Only this session.'), body: t('在另一台设备登录后会在这里出现。', 'Another device appears here after it signs in.'), action: { href: '/settings', label: t('刷新', 'Refresh') } })
    : sessions
        .map((session) => {
          const current = session.id_hash === currentSessionHash
          const agent = (session.user_agent ?? '').trim()
          const agentLabel = agent === '' ? t('未知客户端', 'Unknown client') : agent.length > 60 ? `${agent.slice(0, 60)}…` : agent
          const marker = current ? `<span class="badge good">${escapeHtml(t('当前', 'Current'))}</span>` : ''
          const action = current
            ? marker
            : `<form method="post" action="/settings/sessions/${escapeHtml(session.id_hash)}/revoke">${csrf(viewer)}<button class="link bad" type="submit">${escapeHtml(t('撤销', 'Revoke'))}</button></form>`
          return `<tr><td>${escapeHtml(maskIp(session.ip))}</td><td>${escapeHtml(agentLabel)}</td><td>${escapeHtml(humanTimeShort(session.created_at))}</td><td>${marker}${current ? '' : action}</td></tr>`
        })
        .join('')

  // The chips are a horizontal strip that scrolls under the thumb on a phone, so
  // at 360px the last chip sits past the viewport edge on purpose: the document
  // itself still never scrolls sideways (the matrix's document rule), and the
  // strip is the scroller the reader swipes. `data-allow-overflow` says so to the
  // matrix, which otherwise reads a deliberate scroller as clipped content.
  const body = `<nav class="section-nav" aria-label="${escapeHtml(t('页面导航', 'Section navigation'))}">
    <a href="#account" data-allow-overflow>${escapeHtml(t('账户', 'Account'))}</a>
    <a href="#model-providers" data-allow-overflow>${escapeHtml(t('模型', 'Models'))}</a>
    <a href="#notifications" data-allow-overflow>${escapeHtml(t('通知', 'Notifications'))}</a>
    <a href="#tokens" data-allow-overflow>${escapeHtml(t('API token', 'API tokens'))}</a>
    <a href="#sessions" data-allow-overflow>${escapeHtml(t('登录设备', 'Sessions'))}</a>
  </nav>
  <section class="card" id="account">
    <div class="eyebrow">${escapeHtml(t('账户', 'ACCOUNT'))}</div>
    <h1>@${escapeHtml(user.login)}</h1>
    <p class="muted">${escapeHtml(user.email === null || user.email === '' ? t('未公开邮箱', 'No public email') : maskEmail(user.email))} · ${escapeHtml(t('加入于', 'Joined'))} ${escapeHtml(humanTimeShort(user.created_at))} · ${escapeHtml(t('平台额度', 'Platform quota'))} ${quota.unlimited ? escapeHtml(t('不限额', 'Unlimited')) : `${quotaMoney(quota.remainingCny)} / ${money(quota.initialCny)}`}</p>
    ${user.github_token_enc !== null ? `<p class="fine">${escapeHtml(t('登录时保存了一个默认 GitHub token；添加仓库时仍以仓库表单里的 token 为准。', 'A default GitHub token was saved at sign-in; the token in the repository form still takes precedence.'))}</p>` : ''}
  </section>

  <section class="card" id="model-providers">
    <h2>${escapeHtml(t('模型提供方', 'Model providers'))}</h2>
    <p class="muted">${escapeHtml(t('先添加提供方（Base URL + API Key），再在它下面添加模型。添加模型时 Fledge 会发起 1-token 测试；测试失败不会保存。', 'Add a provider (Base URL + API key), then add models under it. Adding a model sends a 1-token test from Fledge; a failed test is not saved.'))}</p>
    ${providers.length === 0
      ? `${renderState({ kind: 'empty', title: t('还没有模型提供方。', 'No model providers yet.'), body: t('添加提供方（Base URL + API Key）后，任务才能用你自己的模型。', 'Add a provider (Base URL and API key) so jobs can use your own model.'), action: { href: '#add-provider', label: t('添加提供方', 'Add provider') } })}
      <span id="add-provider"></span>`
      : providers.map((provider) => {
          const pending = (discoveredProvider === provider.id ? discovered : []).filter((id) => !provider.models.some((model) => model.model === id))
          return `<div class="card provider-card">
          <div class="row between">
            <div><strong>${escapeHtml(provider.label)}</strong>${provider.allow_private === 1 ? ' · private' : ''} · ${escapeHtml(provider.region === '' ? t('区域未标注', 'no region') : provider.region)} · ${provider.allowed === 1 ? escapeHtml(t('允许', 'allowed')) : escapeHtml(t('已停用', 'disabled'))}<br /><code>${escapeHtml(provider.base_url)}</code>${provider.data_policy_url === '' ? '' : `<br /><a class="link" href="${escapeHtml(provider.data_policy_url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(t('数据政策', 'Data policy'))}</a>`}</div>
            <form method="post" action="/settings/providers/${escapeHtml(provider.id)}/delete">${csrf(viewer)}<button class="link bad" type="submit">${escapeHtml(t('删除提供方', 'Delete provider'))}</button></form>
          </div>
          ${provider.models.length === 0
            ? `<p class="muted">${escapeHtml(t('还没有模型。', 'No models yet.'))}</p>`
            : `<ul>${provider.models.map((model) => `<li><strong>${escapeHtml(model.label)}</strong> <code>${escapeHtml(model.model)}</code> <form method="post" action="/settings/providers/${escapeHtml(provider.id)}/models/${escapeHtml(model.id)}/delete">${csrf(viewer)}<button class="link bad" type="submit">${escapeHtml(t('删除', 'Delete'))}</button></form></li>`).join('')}</ul>`}
          <form method="post" action="/settings/providers/${escapeHtml(provider.id)}/models" class="form">
            ${csrf(viewer)}
            <div class="row">
              <label class="grow">Model ID <input name="model" required maxlength="120" placeholder="deepseek-chat" /></label>
              <label class="grow">${escapeHtml(t('显示名', 'Label'))} <input name="label" maxlength="120" placeholder="${escapeHtml(t('可选', 'optional'))}" /></label>
            </div>
            <button class="btn" type="submit">${escapeHtml(t('添加模型并测试', 'Add model and test'))}</button>
          </form>
          <div class="row">
            <form method="post" action="/settings/providers/${escapeHtml(provider.id)}/discover">${csrf(viewer)}<button class="btn btn-ghost btn-small" type="submit">${escapeHtml(t('读取模型列表', 'Discover models'))}</button></form>
          </div>
          ${discoveredProvider === provider.id && discovered.length > 0 ? `<div class="banner">${escapeHtml(t(`发现 ${discovered.length} 个模型。`, `${discovered.length} models found.`))}</div>${pending.length === 0 ? `<p class="fine">${escapeHtml(t('这些模型已经全部添加。', 'All of these models are already added.'))}</p>` : `<form method="post" action="/settings/providers/${escapeHtml(provider.id)}/models/bulk" class="form">${csrf(viewer)}${pending.map((id) => `<label class="check"><input type="checkbox" name="models" value="${escapeHtml(id)}" checked /> ${escapeHtml(id)}</label>`).join('')}<button class="btn" type="submit">${escapeHtml(t('添加选中并测试', 'Add selected and test'))}</button></form>`}` : ''}
          <details class="fine"><summary>${escapeHtml(t('编辑提供方', 'Edit provider'))}</summary>
            <form method="post" action="/settings/providers/${escapeHtml(provider.id)}/update" class="form">
              ${csrf(viewer)}
              <div class="row">
                <label class="grow">${escapeHtml(t('名称', 'Label'))} <input name="label" value="${escapeHtml(provider.label)}" maxlength="80" /></label>
                <label class="grow">Base URL <input name="baseUrl" value="${escapeHtml(provider.base_url)}" /></label>
              </div>
              <label>API Key <input name="apiKey" type="password" placeholder="${escapeHtml(t('留空不修改', 'Leave blank to keep'))}" autocomplete="off" /></label>
              <div class="row">
                <label class="grow">${escapeHtml(t('区域 / 司法辖区', 'Region / jurisdiction'))} <input name="region" value="${escapeHtml(provider.region)}" maxlength="80" placeholder="eu" /></label>
                <label class="grow">${escapeHtml(t('数据政策 URL', 'Data-policy URL'))} <input name="dataPolicyUrl" value="${escapeHtml(provider.data_policy_url)}" maxlength="2048" placeholder="https://…" /></label>
              </div>
              <label>${escapeHtml(t('提供方状态', 'Provider status'))} <select name="allowed"><option value="1"${provider.allowed === 1 ? ' selected' : ''}>${escapeHtml(t('允许使用', 'Allowed'))}</option><option value="0"${provider.allowed === 0 ? ' selected' : ''}>${escapeHtml(t('停用', 'Disabled'))}</option></select></label>
              ${canPrivate ? `<label class="check"><input type="checkbox" name="allowPrivate" value="1"${provider.allow_private === 1 ? ' checked' : ''} /> ${escapeHtml(t('允许 HTTP / 内网地址', 'Allow HTTP / private address'))}</label>` : ''}
              <button class="btn btn-ghost" type="submit">${escapeHtml(t('保存提供方', 'Save provider'))}</button>
            </form>
          </details>
        </div>`
        }).join('')}
    <form method="post" action="/settings/providers" class="form">
      ${csrf(viewer)}
      <div class="row">
        <label class="grow">${escapeHtml(t('名称', 'Label'))} <input name="label" required maxlength="80" placeholder="DeepSeek / local" /></label>
        <label class="grow">Base URL <input name="baseUrl" required placeholder="https://api.example.com/v1" autocomplete="off" /></label>
      </div>
      <label>API Key <input name="apiKey" required type="password" placeholder="sk-…" autocomplete="off" /></label>
      <div class="row">
        <label class="grow">${escapeHtml(t('区域 / 司法辖区', 'Region / jurisdiction'))} <input name="region" maxlength="80" placeholder="eu" /></label>
        <label class="grow">${escapeHtml(t('数据政策 URL', 'Data-policy URL'))} <input name="dataPolicyUrl" maxlength="2048" placeholder="https://…" /></label>
        <label>${escapeHtml(t('提供方状态', 'Provider status'))} <select name="allowed"><option value="1">${escapeHtml(t('允许使用', 'Allowed'))}</option><option value="0">${escapeHtml(t('停用', 'Disabled'))}</option></select></label>
      </div>
      ${config.allowPrivateModelUrls || viewer.user.allow_private_models === 1 || viewer.user.role === 'superadmin' ? `<label class="check"><input type="checkbox" name="allowPrivate" value="1" /> ${escapeHtml(t('允许 HTTP / 内网地址（Fledge 必须能访问）', 'Allow HTTP / private address (Fledge must be able to reach it)'))}</label>` : `<p class="fine">${escapeHtml(t('需要管理员在 Admin 中为你的账号开启“内网模型”权限，或由运维设置 ALLOW_PRIVATE_MODEL_URLS=true。', 'An admin must enable private models for your account in Admin, or the operator must set ALLOW_PRIVATE_MODEL_URLS=true.'))}</p>`}
      <button class="btn" type="submit">${escapeHtml(t('添加提供方', 'Add provider'))}</button>
    </form>
  </section>

  <section class="card" id="notifications">
    <h2>${escapeHtml(t('邮件通知', 'Email notifications'))}</h2>
    <p class="muted">${escapeHtml(t(`任务需要你回答、完成或失败时，发送到 ${maskedEmail || '（未配置）'}；发件人是 ${config.mail.from}。`, `Send to ${maskedEmail || '(not configured)'} when a job needs an answer, finishes or fails; the sender is ${config.mail.from}.`))}</p>
    ${hasEmail ? '' : `<div class="banner bad">${escapeHtml(t('还没有可用的通知邮箱，请填写一个邮箱后再开启通知。', 'There is no notification email yet; add one before enabling notifications.'))}</div>`}
    <form method="post" action="/settings/notifications" class="form">
      ${csrf(viewer)}
      <label>${escapeHtml(t('通知邮箱', 'Notification email'))} <input name="email" type="email" value="" placeholder="${escapeHtml(maskedEmail || 'you@example.com')}" autocomplete="email" /></label>
      <p class="fine">${escapeHtml(t('留空保持不变；勾选下方“清除”则改回 GitHub 邮箱（界面只显示掩码）。', 'Leave blank to keep the current address; tick "Clear" to use the GitHub email (the UI shows a mask only).'))}</p>
      ${customEmail === '' ? '' : `<label class="check"><input type="checkbox" name="clear" value="1" /> ${escapeHtml(t('清除自定义邮箱，使用 GitHub 邮箱', 'Clear the custom email and use the GitHub email'))}</label>`}
      <label class="check"><input type="checkbox" name="jobUpdates" value="1" ${user.email_job_updates === 1 ? 'checked' : ''} /> ${escapeHtml(t('任务需要回答、完成或失败时发邮件', 'Email me when a job needs an answer, finishes or fails'))}</label>
      <label class="check"><input type="checkbox" name="dailyDigest" value="1" ${user.email_daily_digest === 1 ? 'checked' : ''} /> ${escapeHtml(t('每天发送一封今日摘要', 'Send a daily summary email'))}</label>
      <label class="check"><input type="checkbox" name="jobSuccess" value="1" ${user.email_job_success === 1 ? 'checked' : ''} /> ${escapeHtml(t('计划任务成功时也单独发邮件（默认关闭，成功会汇总进每日摘要）', 'Also email me when a scheduled job succeeds (off by default; successes are summarized in the daily summary)'))}</label>
      <p class="fine">${escapeHtml(t(`计划任务成功不再单独发邮件，而是汇总进每日摘要；失败按仓库合并，同一仓库 ${config.mail.jobEmailCooldownMinutes} 分钟内最多一封。你手动运行的任务，结果总是发邮件。`, `A scheduled success is summarized in the daily summary instead of its own mail; failures are coalesced so one repository sends at most one mail per ${config.mail.jobEmailCooldownMinutes} minutes. A run you started by hand always mails its result.`))}</p>
      <div class="row">
        <button class="btn" name="action" value="save" type="submit">${escapeHtml(t('保存通知设置', 'Save notification settings'))}</button>
        <button class="btn btn-ghost" name="action" value="test" type="submit">${escapeHtml(t('发送测试邮件', 'Send test email'))}</button>
      </div>
    </form>
    <p class="fine">${escapeHtml(t(`审批和额度邮件不受这个开关影响。每日摘要默认在 ${config.digest.hour}:00（${config.digest.timeZone}）发送。`, `Approval and quota mail are not affected by these switches. The daily summary is sent at ${config.digest.hour}:00 (${config.digest.timeZone}).`))}</p>
  </section>

  <section class="card" id="tokens">
    <h2>${escapeHtml(t('API token', 'API tokens'))}</h2>
    <p class="muted">${escapeHtml(t('给脚本或 FlyBot 调用的网关 token（flg_…）。它不是你的 GitHub token，也不是模型 key。', 'Gateway tokens (flg_…) for scripts or FlyBot. They are neither your GitHub token nor a model key.'))}</p>
    ${newToken === undefined ? '' : `<div class="banner ok">${escapeHtml(t('新 token（只显示一次）：', 'New token (shown once):'))}<code class="token" id="new-token">${escapeHtml(newToken)}</code> <button class="link" type="button" data-copy="#new-token">${escapeHtml(t('复制', 'Copy'))}</button></div>`}
    <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('前缀', 'Prefix'))}</th><th>${escapeHtml(t('名称', 'Name'))}</th><th>${escapeHtml(t('范围', 'Scope'))}</th><th>${escapeHtml(t('有效期', 'Expires'))}</th><th>${escapeHtml(t('最近使用', 'Last used'))}</th><th></th></tr></thead><tbody>${tokenRows}</tbody></table></div>
    <form method="post" action="/settings/tokens" class="row">${csrf(viewer)}<input name="name" placeholder="${escapeHtml(t('用途，例如 laptop-cli', 'Purpose, e.g. laptop-cli'))}" required />
      <input type="hidden" name="scope" value="gateway" />
      <label>${escapeHtml(t('有效期', 'Expires'))}{infoTip(t('个人 token 必须有期限；到期后网关直接拒绝。永不过期只对管理员创建的运维 token 开放。', 'A personal token must expire; the gateway refuses it afterwards. A token without an expiry is only for an operator token created by an admin.'))}
        <select name="expiryDays">
          ${PAT_EXPIRY_CHOICES.map((days) => `<option value="${days}"${days === config.tokens.patExpiryDays ? ' selected' : ''}>${escapeHtml(t(`${days} 天`, `${days} days`))}</option>`).join('')}
          ${viewer.user.role === 'admin' || viewer.user.role === 'superadmin' ? `<option value="never">${escapeHtml(t('永不过期（运维）', 'Never (operator)'))}</option>` : ''}
        </select>
      </label>
      <button class="btn" type="submit">${escapeHtml(t('创建 token', 'Create token'))}</button></form>
    <p class="fine">${escapeHtml(t('范围固定为 gateway：这是目前唯一会校验 token 的能力边界，暂时不提供单选项以外的选择。', 'The scope is fixed to gateway: it is the only capability boundary that checks a token today, so there is no choice to make yet.'))}</p>
  </section>

  <section class="card" id="sessions">
    <h2>${escapeHtml(t('登录设备', 'Sessions'))}</h2>
    <p class="muted">${escapeHtml(t('这些是当前有效的登录会话。撤销后那个 cookie 立即失效；退出其他会话不会退出当前这个。', 'These are the live sign-ins. Revoking one ends that cookie immediately; signing out the others keeps this one.'))}</p>
    <div class="table-scroll"><table><thead><tr><th>IP</th><th>${escapeHtml(t('客户端', 'Client'))}</th><th>${escapeHtml(t('登录时间', 'Signed in'))}</th><th></th></tr></thead><tbody>${sessionRows}</tbody></table></div>
    <div class="row">
      <form method="post" action="/settings/sessions/revoke-others">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('退出其他会话', 'Sign out other sessions'))}</button></form>
      <form method="post" action="/settings/sessions/rotate">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('轮换当前会话', 'Rotate this session'))}</button></form>
    </div>
  </section>`
  return layout({ title: t('设置', 'Settings'), viewer, body, config, locale, path: '/settings', active: 'settings', notice, error })
}

const AUDIT_ACTIONS: Record<string, [string, string]> = {
  'login.github': ['GitHub 登录', 'GitHub sign-in'],
  'login.github-token': ['GitHub token 登录', 'GitHub token sign-in'],
  'login.dev': ['Dev 登录', 'Dev sign-in'],
  logout: ['退出登录', 'Sign out'],
  'application.submitted': ['提交申请', 'Application submitted'],
  'approval.requested': ['发送审批邮件', 'Approval mail sent'],
  'admin.approved': ['批准用户', 'User approved'],
  'admin.rejected': ['拒绝用户', 'User rejected'],
  'admin.quota': ['调整额度', 'Quota changed'],
  'repo.added': ['添加仓库', 'Repository added'],
  'repo.settings': ['仓库设置', 'Repository settings'],
  'repo.deleted': ['删除仓库', 'Repository deleted'],
  'repo.refreshed': ['刷新仓库', 'Repository refreshed'],
  'job.enqueued': ['任务入队', 'Job queued'],
  'job.succeeded': ['任务成功', 'Job succeeded'],
  'job.failed': ['任务失败', 'Job failed'],
  'job.retried': ['重试任务', 'Job retried'],
  'review.enqueued': ['审核入队', 'Review queued'],
  'team.guidance': ['发送团队指导', 'Team guidance'],
  'team.answer': ['回答团队问题', 'Team question answered'],
  'team.stop': ['暂停团队', 'Team stop requested'],
  'flybot.instance.ready': ['FlyBot 实例就绪', 'FlyBot instance ready'],
  'flybot.instance.failed': ['FlyBot 实例失败', 'FlyBot instance failed'],
  'flybot.instance.stopped': ['FlyBot 实例停止', 'FlyBot instance stopped'],
  'token.created': ['创建 token', 'Token created'],
  'token.revoked': ['撤销 token', 'Token revoked'],
  'model.saved': ['保存模型', 'Model saved'],
  'model.cleared': ['清除模型', 'Model cleared'],
  'settings.email': ['邮件通知设置', 'Email notification settings'],
  'settings.email.test': ['测试通知邮件', 'Test notification email'],
  'admin.role': ['调整平台角色', 'Platform role changed'],
  'approval.approved': ['批准申请', 'Application approved'],
  'approval.rejected': ['拒绝申请', 'Application rejected'],
  'repo.role': ['调整仓库角色', 'Repository role changed'],
  'repo.goal_updated': ['更新仓库目标', 'Repository goal updated'],
  'plan.enqueued': ['计划入队', 'Plan queued'],
  'job.executed': ['执行计划', 'Plan executed'],
  'job.quota_exhausted': ['任务额度用完', 'Job quota exhausted'],
  'job.auto_merged': ['自动合并', 'Auto-merged'],
  'job.auto_merge_skipped': ['跳过自动合并', 'Auto-merge skipped'],
  'job.auto_merge_failed': ['自动合并失败', 'Auto-merge failed'],
  'team.chief_message': ['发送 Chief 消息', 'Chief message'],
  'team.email_reply': ['邮件回复', 'Email reply'],
  'github_app.installed': ['安装 GitHub App', 'GitHub App installed'],
  'flybot.bridge.restarted': ['重启 bridge', 'Bridge restarted'],
}

function auditLabel(t: Translate, action: string): string {
  const label = AUDIT_ACTIONS[action]
  return label === undefined ? action : t(label[0], label[1])
}

function auditTone(action: string): string {
  if (/failed|rejected|revoked|deleted/.test(action)) return 'bad'
  if (/approved|succeeded|created|added|saved/.test(action)) return 'good'
  if (/enqueued|quota|settings|refreshed/.test(action)) return 'busy'
  return ''
}

function auditRows(locale: Locale, audit: AuditRow[], usersById: Map<string, string>, hideActor = false): string {
  const t = translator(locale)
  if (audit.length === 0) return stateCell(4, { kind: 'empty', title: t('暂无记录。', 'No records yet.'), body: t('审批、任务和设置变更都会写进审计；现在还没有任何一条。', 'Approvals, jobs and setting changes are audited; there is nothing yet.'), action: { href: '/dashboard', label: t('回到仓库', 'Back to repositories') } })
  return audit
    .map((row) => {
      const rawDetail = row.detail ?? ''
      const by = hideActor ? undefined : /\bby @([A-Za-z0-9-]+)\b/.exec(rawDetail)?.[1]
      const targetLogin = row.user_id === null ? undefined : usersById.get(row.user_id)
      const actor = by ?? targetLogin
      const target = by !== undefined && targetLogin !== undefined && by.toLowerCase() !== targetLogin.toLowerCase() ? targetLogin : undefined
      let detail = rawDetail.replace(/^by @[A-Za-z0-9-]+\s*/, '').trim()
      if (detail === `@${actor}`) detail = ''
      if (hideActor) detail = detail.replace(/\bby @[A-Za-z0-9-]+\b/g, t('由管理员操作', 'by an administrator'))
      const tone = auditTone(row.action)
      const rawAction = AUDIT_ACTIONS[row.action] === undefined ? '' : row.action
      const actorHtml = hideActor
        ? escapeHtml(t('管理员 / 系统', 'Admin / System'))
        : actor === undefined
          ? escapeHtml(t('系统', 'System'))
          : `@${escapeHtml(actor)}${target === undefined ? '' : ` <span class="muted">→ @${escapeHtml(target)}</span>`}`
      return `<tr>
        <td class="nowrap" data-label="${escapeHtml(t('时间', 'Time'))}"><span title="${escapeHtml(row.at)}">${escapeHtml(humanTimeShort(row.at))}</span></td>
        <td data-label="${escapeHtml(t('动作', 'Action'))}"><span class="badge ${tone}">${escapeHtml(auditLabel(t, row.action))}</span>${rawAction === '' ? '' : `<br /><small class="muted">${escapeHtml(rawAction)}</small>`}</td>
        <td class="nowrap" data-label="${escapeHtml(t('操作者', 'Actor'))}">${actorHtml}</td>
        <td data-priority="low" data-label="${escapeHtml(t('详情', 'Detail'))}">${detail === '' ? '—' : `<span title="${escapeHtml(hideActor ? detail : rawDetail)}">${escapeHtml(detail.slice(0, 160))}</span>`}</td>
      </tr>`
    })
    .join('')
}

function pager(path: string, pageParam: string, page: number, total: number, perPage: number, t: Translate, other: Record<string, string | number> = {}, hash = ''): string {
  const pages = Math.max(1, Math.ceil(total / perPage))
  if (pages <= 1) return ''
  const href = (target: number): string => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(other)) if (String(value) !== '') params.set(key, String(value))
    params.set(pageParam, String(target))
    return `${path}?${params.toString()}${hash}`
  }
  const prev = page > 1
    ? `<a class="btn btn-ghost btn-small" href="${escapeHtml(href(page - 1))}">${escapeHtml(t('上一页', 'Previous'))}</a>`
    : `<span class="btn btn-ghost btn-small disabled" aria-disabled="true">${escapeHtml(t('上一页', 'Previous'))}</span>`
  const next = page < pages
    ? `<a class="btn btn-ghost btn-small" href="${escapeHtml(href(page + 1))}">${escapeHtml(t('下一页', 'Next'))}</a>`
    : `<span class="btn btn-ghost btn-small disabled" aria-disabled="true">${escapeHtml(t('下一页', 'Next'))}</span>`
  return `<div class="pager">${prev}<span class="pager-info">${page} / ${pages} · ${total}</span>${next}</div>`
}

export function adminPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  users: UserRow[]
  jobs: JobRow[]
  jobsPage: number
  jobsTotal: number
  audit: AuditRow[]
  auditPage: number
  auditTotal: number
  perPage: number
  activity?: Map<string, { repos: number; jobs: number; lastJobAt: string | null }>
  mailFailedUsers?: Set<string>
  superadmin?: boolean
  preview?: boolean
  showAudit?: boolean
  hideActor?: boolean
  notice?: string
  error?: string
  /** Defaults to the running process's surface; a test passes a fixture root. */
  release?: ReleaseSurface
  /** The release chain recorded by `node scripts/verify-release.mjs`; null when none is recorded. */
  releaseStatus?: ReleaseStatusSnapshot | null
  /** Defaults to reading `config.backup.dir`; a test passes a fixture directory. */
  backup?: BackupStatus
  /**
   * `jobs.platformStop()` read fresh for this request. Null means the platform is
   * running; `{at:'', by:'', reason:''}` means the row exists but cannot be parsed,
   * which is still a stop.
   */
  platformStop?: PlatformStopRecord | null
}): string {
  const { config, locale, viewer, users, jobs, jobsPage, jobsTotal, audit, auditPage, auditTotal, perPage, activity, notice, error } = input
  const release = input.release ?? releaseSurface()
  const backup = input.backup ?? readBackupStatus({ dir: config.backup.dir, expectedHours: config.backup.expectedIntervalHours })
  const mailFailedUsers = input.mailFailedUsers ?? new Set<string>()
  const superadmin = input.superadmin === true
  const preview = input.preview === true
  const showAudit = input.showAudit !== false
  const hideActor = input.hideActor === true
  const t = translator(locale)
  const usersById = new Map(users.map((user) => [user.id, user.login]))
  const pending = users
    .filter((user) => user.status === 'pending')
    .sort((a, b) => String(a.application_submitted_at ?? a.created_at).localeCompare(String(b.application_submitted_at ?? b.created_at)))
  const pendingRows = pending.length === 0
    ? stateCell(4, { kind: 'empty', title: t('没有待审批申请。', 'No pending applications.'), body: t('新申请会出现在这里；审批会发邮件并写审计。', 'New applications land here; approving one sends mail and writes an audit entry.'), action: { href: '/admin/users', label: t('查看用户', 'View users') } })
    : pending
        .map(
          (user, index) => `<tr>
            <td>@${escapeHtml(user.login)}<br /><small class="muted">${escapeHtml(user.email ?? '')}</small></td>
            <td><b>#${index + 1}</b><br /><small class="muted">${escapeHtml(humanTimeShort(user.application_submitted_at ?? user.created_at))}</small></td>
            <td>${badge(t, user.status)}<br /><small class="muted">${escapeHtml(t('签署：', 'Signed: '))}${escapeHtml(user.disclaimer_name ?? '—')}<br />${escapeHtml(t('免责', 'Disclaimer'))} ${escapeHtml(humanTimeShort(user.disclaimer_accepted_at))}<br />${escapeHtml(t('信息安全', 'Security'))} ${escapeHtml(humanTimeShort(user.security_accepted_at))}<br />IP ${escapeHtml(user.application_ip ?? '—')}</small></td>
            <td class="row">
              ${mailFailedUsers.has(user.id) ? `<span class="badge bad">${escapeHtml(t('审批邮件发送失败', 'Approval mail not delivered'))}</span><form method="post" action="/admin/users/${escapeHtml(user.id)}/resend-approval">${csrf(viewer)}<button class="link" type="submit">${escapeHtml(t('重新发送审批邮件', 'Resend approval mail'))}</button></form>` : ''}
              <form method="post" action="/admin/users/${escapeHtml(user.id)}/approve">${csrf(viewer)}<button class="link good" type="submit">${escapeHtml(t('批准', 'Approve'))}</button></form>
              <form method="post" action="/admin/users/${escapeHtml(user.id)}/reject">${csrf(viewer)}<button class="link bad" type="submit">${escapeHtml(t('拒绝', 'Reject'))}</button></form>
            </td>
          </tr>`,
        )
        .join('')
  const userRows = users
    .map(
      (user) => `<tr>
        <td data-label="${escapeHtml(t('登录名', 'Login'))}">@${escapeHtml(user.login)}<br /><small class="muted">${escapeHtml(user.email ?? '')}</small><br /><a class="link" href="/admin/users/${escapeHtml(user.id)}">${escapeHtml(t('支持视图', 'Support view'))}</a></td>
        <td data-label="${escapeHtml(t('状态', 'Status'))}">${badge(t, user.status)}</td>
        <td data-label="${escapeHtml(t('角色', 'Role'))}">${escapeHtml(roleLabel(t, user.role))}</td>
        <td data-label="${escapeHtml(t('额度', 'Quota'))}">${user.quota_unlimited === 1 ? escapeHtml(t('不限额', 'Unlimited')) : money(user.quota_cny)}</td>
        <td data-priority="low" data-label="${escapeHtml(t('已用', 'Used'))}">${quotaMoney(quotaView(user, config).usedCny)}</td>
        <td data-priority="low" data-label="${escapeHtml(t('活动', 'Activity'))}"><small class="muted">${escapeHtml(t('最近登录', 'Last sign-in'))} ${escapeHtml(humanTimeShort(user.last_login_at))}<br />${escapeHtml(t('仓库', 'Repos'))} ${activity?.get(user.id)?.repos ?? 0} · ${escapeHtml(t('任务', 'Jobs'))} ${activity?.get(user.id)?.jobs ?? 0}<br />${escapeHtml(t('最近任务', 'Last job'))} ${escapeHtml(humanTimeShort(activity?.get(user.id)?.lastJobAt))}</small></td>
        <td class="admin-adjust" data-label="${escapeHtml(t('调整', 'Adjust'))}">
          <div class="admin-control-row">
            <form method="post" action="/admin/users/${escapeHtml(user.id)}/quota" class="admin-inline-form">${csrf(viewer)}<input class="admin-quota" name="quota" type="number" step="0.1" min="0" value="${user.quota_cny}" aria-label="${escapeHtml(t('额度', 'Quota'))}" />${superadmin ? `<label class="check admin-check"><input type="checkbox" name="unlimited" value="1"${user.quota_unlimited === 1 ? ' checked' : ''} /> ${escapeHtml(t('不限额', 'Unlimited'))}</label>` : ''}<button class="link" type="submit">${escapeHtml(t('改额度', 'Set quota'))}</button></form>
          </div>
          ${superadmin && user.role !== 'superadmin' && user.id !== viewer.user.id ? `<div class="admin-control-row"><form method="post" action="/admin/users/${escapeHtml(user.id)}/role" class="admin-inline-form">${csrf(viewer)}<select class="admin-role" name="role" aria-label="${escapeHtml(t('角色', 'Role'))}"><option value="user"${user.role === 'user' ? ' selected' : ''}>${escapeHtml(t('用户', 'User'))}</option><option value="admin"${user.role === 'admin' ? ' selected' : ''}>${escapeHtml(t('管理员', 'Admin'))}</option></select><button class="link" type="submit">${escapeHtml(t('改角色', 'Set role'))}</button></form></div>` : ''}
          ${superadmin && user.role !== 'superadmin' ? `<div class="admin-control-row"><form method="post" action="/admin/users/${escapeHtml(user.id)}/private-models" class="admin-inline-form">${csrf(viewer)}<input type="hidden" name="allow" value="${user.allow_private_models === 1 ? '0' : '1'}" /><button class="link" type="submit">${escapeHtml(user.allow_private_models === 1 ? t('禁止内网模型', 'Disable private models') : t('允许内网模型', 'Allow private models'))}</button><span class="fine">${escapeHtml(user.allow_private_models === 1 ? t('内网模型：允许', 'Private models: allowed') : t('内网模型：禁止', 'Private models: disabled'))}</span></form></div>` : ''}
          <div class="admin-control-row admin-actions">
            ${user.role !== 'superadmin' && user.id !== viewer.user.id && user.status === 'rejected' ? `<form method="post" action="/admin/users/${escapeHtml(user.id)}/approve">${csrf(viewer)}<button class="link good" type="submit">${escapeHtml(t('重新批准', 'Re-approve'))}</button></form>` : ''}
            ${user.role !== 'superadmin' && user.id !== viewer.user.id && user.status === 'approved' ? `<form method="post" action="/admin/users/${escapeHtml(user.id)}/reject" data-confirm="${escapeHtml(t('停用这个用户并停止其所有 FlyBot 实例？', 'Disable this user and stop all their FlyBot instances?'))}">${csrf(viewer)}<button class="link bad" type="submit">${escapeHtml(t('停用', 'Disable'))}</button></form>` : ''}
          </div>
        </td>
      </tr>`,
    )
    .join('')
  // Local files only: package.json is what the release routine keeps in step, so
  // the card names it as the running version and never claims a commit. A file
  // that is not in this build says so; a zero fragment count is a real fact.
  const absent = t('此构建中不可用', 'not available in this build')
  const releaseCard = `<section class="card" id="release">
    <h2>${escapeHtml(t('发布', 'Release'))}</h2>
    <div class="list">
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('运行版本', 'Running'))}</strong><small>${release.version === null ? escapeHtml(absent) : `v${escapeHtml(release.version)} · ${escapeHtml(t('来自 package.json', 'from package.json'))}`}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('最新 CHANGELOG 段落', 'Newest CHANGELOG section'))}</strong><small>${release.changelogVersion === null || release.releasedAt === null ? escapeHtml(absent) : `${escapeHtml(release.changelogVersion)} · ${escapeHtml(release.releasedAt)}`}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('待发布片段', 'Pending fragments'))}</strong><small>${release.fragments === null ? escapeHtml(absent) : release.fragments === 0 ? escapeHtml(t('没有待发布片段', 'nothing pending')) : escapeHtml(t(`${release.fragments} 个待发布片段`, `${release.fragments} pending fragment${release.fragments === 1 ? '' : 's'}`))}</small></div></div>
    </div>
  </section>`
  // Issue #280: the chain is assembled by `node scripts/verify-release.mjs` and
  // read from `${DATA_DIR}/release-status.json`; the page renders what that run
  // recorded and never calls GitHub itself. The running row is the only live
  // fact — this process knows the version and the commit stamp it booted with.
  const releaseStatus = input.releaseStatus ?? null
  const stateBadge = (state: string) => {
    if (state === 'ok') return `<span class="badge good">${escapeHtml(t('正常', 'ok'))}</span>`
    if (state === 'missing') return `<span class="badge bad">${escapeHtml(t('缺失', 'missing'))}</span>`
    if (state === 'mismatch') return `<span class="badge bad">${escapeHtml(t('不一致', 'mismatch'))}</span>`
    return `<span class="badge busy">${escapeHtml(t('跳过', 'skipped'))}</span>`
  }
  const linkLabel = (id: string) => {
    const labels: Record<string, [string, string]> = {
      version: ['版本', 'Version'],
      plan: ['发布计划', 'Plan'],
      branch: ['发布分支', 'Release branch'],
      pull: ['发布 PR', 'Release PR'],
      tag: ['标签', 'Tag'],
      image: ['镜像', 'Image'],
      sbom: ['SBOM', 'SBOM'],
      attestation: ['来源证明', 'Provenance'],
      release: ['GitHub Release', 'GitHub Release'],
      healthz: ['运行实例', 'Running instance'],
    }
    const pair = labels[id] ?? [id, id]
    return t(pair[0]!, pair[1]!)
  }
  const chainRows = releaseStatus === null
    ? `<p class="muted">${escapeHtml(t('这台实例还没有记录发布链。', 'No release chain is recorded on this instance.'))} <code>node scripts/verify-release.mjs --version X.Y.Z --write ${escapeHtml(config.dataDir)}/release-status.json</code></p>`
    : `${releaseStatus.links
        .map(
          (entry) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(linkLabel(entry.id))}</strong><small>${escapeHtml(entry.detail)}</small></div><div class="row">${stateBadge(entry.state)}</div></div>`,
        )
        .join('')}${(() => {
        const running = compareRunning(releaseStatus, { version: release.version ?? '', commit: config.build.commit })
        return `<div class="list-row"><div class="list-main"><strong>${escapeHtml(t('这个进程', 'This process'))}</strong><small>${escapeHtml(running.detail)}</small></div><div class="row">${stateBadge(running.state)}</div></div>`
      })()}`
  const chainCard = `<section class="card" id="release-chain">
    <h2>${escapeHtml(t('发布链', 'Release chain'))}${releaseStatus === null ? '' : ` <small class="count">v${escapeHtml(releaseStatus.version)} · ${escapeHtml(releaseStatus.ok ? t('已发布', 'released') : t('未完成', 'not released'))}${releaseStatus.checkedAt === '' ? '' : ` · ${escapeHtml(t(`检查于 ${releaseStatus.checkedAt}`, `checked ${releaseStatus.checkedAt}`))}`}${releaseStatus.releaseUrl === '' ? '' : ` · <a class="link" href="${escapeHtml(releaseStatus.releaseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t('GitHub Release', 'GitHub Release'))}</a>`}</small>`}</h2>
    <div class="list">${chainRows}</div>
  </section>`

  // The console can only show what the writer leaves on disk: a copy and its
  // manifest. A run that fails writes nothing, so "the night was good" is never
  // claimed here - the card reports staleness and a manifest that no longer
  // matches instead (the drill records no verdict yet, so that row says so).
  const backupSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
    return `${bytes} B`
  }
  const backupHours = (hours: number): string => `${Math.round(hours)} ${t('小时', 'hours')}`
  const manifestText = (copy: BackupCopyStatus): string => {
    switch (copy.manifest) {
      case 'matches':
        return t('相符（大小与 sha256 一致）', 'matches (size and sha256)')
      case 'differs':
        return copy.manifestDetail === 'size' ? t('不符（大小）', 'differs (size)') : t('不符（sha256）', 'differs (sha256)')
      case 'not-checked':
        return t(`未检查（副本大于 ${Math.round(SHA256_MAX_BYTES / (1024 * 1024))} MiB）`, `not checked (copy above ${Math.round(SHA256_MAX_BYTES / (1024 * 1024))} MiB)`)
      case 'size-only':
        return t('大小相符，未核对 sha256（只核对最新副本）', 'size matches, sha256 not checked (only the newest copy is hashed)')
      case 'missing':
        return t('缺失', 'missing')
      default:
        return t('无法读取', 'unreadable')
    }
  }
  const newest = backup.newest
  const freshness = newest === null || newest.ageHours === null
    ? t('无从判断', 'nothing to judge')
    : backup.stale
      ? t(`${backupHours(newest.ageHours)}，超过预期的 ${backup.expectedHours} 小时`, `${backupHours(newest.ageHours)}, older than the expected ${backup.expectedHours} hours`)
      : t(`${backupHours(newest.ageHours)}，在预期的 ${backup.expectedHours} 小时以内`, `${backupHours(newest.ageHours)}, within the expected ${backup.expectedHours} hours`)
  const copyCount = backup.copies.length === 1 ? t('1 个副本', '1 copy') : t(`${backup.copies.length} 个副本`, `${backup.copies.length} copies`)
  // One sentence per kind of fact, so a copy that was never compared is never
  // summed into "does not match": only `differs` counts a contradiction, and
  // copies without a manifest and copies whose sha256 was not read say so in
  // their own words.
  const differingText = backup.differing === 1
    ? t('1 个与清单不符', '1 differs from its manifest')
    : t(`${backup.differing} 个与清单不符`, `${backup.differing} differ from their manifest`)
  const unmanifested = backup.copies.filter((copy) => copy.manifest === 'missing' || copy.manifest === 'unreadable').length
  const unhashed = backup.copies.filter((copy) => copy.manifest === 'not-checked' || copy.manifest === 'size-only').length
  const copyAgreement = backup.copies.length === 0
    ? t('没有副本可核对', 'nothing to check')
    : [
        backup.differing === 0 ? t('没有副本与清单不符', 'no copy differs from its manifest') : differingText,
        unmanifested === 0 ? null : t(`${unmanifested} 个没有清单`, `${unmanifested} without a manifest`),
        unhashed === 0 ? null : t(`${unhashed} 个未核对 sha256`, `${unhashed} with sha256 not checked`),
      ].filter((part): part is string => part !== null).join(' · ')
  const mismatchRows = backup.copies
    .filter((copy) => copy.manifest !== 'matches')
    .map((copy) => `<div class="list-row"><div class="list-main"><strong>${escapeHtml(copy.name)}</strong><small>${escapeHtml(manifestText(copy))} · ${escapeHtml(backupSize(copy.sizeBytes))} · ${escapeHtml(humanTimeShort(copy.createdAt))}</small></div></div>`)
    .join('')
  const backupCard = `<section class="card" id="backups">
    <h2>${escapeHtml(t('备份', 'Backups'))}</h2>
    <div class="list">
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('最新副本', 'Newest copy'))}</strong><small>${newest === null ? escapeHtml(t('还没有记录备份副本', 'No backup copy recorded yet')) : `${escapeHtml(newest.name)} · ${escapeHtml(backupSize(newest.sizeBytes))} · ${escapeHtml(humanTimeShort(newest.createdAt))}`}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('新鲜度', 'Freshness'))}</strong><small>${escapeHtml(freshness)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('副本数', 'Copies'))}</strong><small>${escapeHtml(copyCount)} · ${escapeHtml(copyAgreement)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('最新副本的清单', 'Newest manifest'))}</strong><small>${newest === null ? escapeHtml('—') : escapeHtml(manifestText(newest))}</small></div></div>
      ${mismatchRows}
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('恢复演练', 'Restore drill'))}</strong><small>${escapeHtml(t('没有记录', 'none recorded'))}</small></div></div>
    </div>
    <p class="muted">${escapeHtml(t('只读：本卡片列出备份目录并核对清单，不会打开正在备份的数据库，也没有备份、恢复或删除按钮。', 'Read-only: this card lists the backup directory and checks the manifests. It never opens the database being backed up, and carries no backup, restore or delete control.'))} ${escapeHtml(t('大小与每个副本核对；sha256 只核对最新副本。', 'Size is compared on every copy; sha256 only on the newest.'))}${newest === null ? ` ${escapeHtml(t('在主机上运行', 'Run'))} <code>npm run db:backup</code> ${escapeHtml(t('后，下一份副本会出现在这里。', 'on the host; the next copy appears here.'))}` : ''}</p>
  </section>`
  // #317: the stop route reports its result once in a redirect notice, and a
  // reload drops that line.
  // The record is read fresh per request, so the banner states who stopped the
  // platform, when and why on every render. A corrupt row parses to three empty
  // strings: it is still a stop, so it says so and never shows a blank operator
  // as if it were a fact.
  const stop = input.platformStop ?? null
  const stopBanner = stop === null
    ? ''
    : (() => {
        const unreadable = stop.at === '' && stop.by === '' && stop.reason === ''
        const facts = unreadable
          ? `<li>${escapeHtml(t('停机记录无法读取，平台仍按停止处理。', 'The stop record cannot be read; the platform stays stopped.'))}</li>`
          : [
              `<li>${escapeHtml(t('操作者：', 'Operator: '))}<b>@${escapeHtml(stop.by === '' ? '—' : stop.by)}</b></li>`,
              `<li>${escapeHtml(t('时间：', 'Time: '))}${stop.at === '' ? escapeHtml('—') : `<time datetime="${escapeHtml(stop.at)}">${escapeHtml(humanTimeShort(stop.at))}</time>`}</li>`,
              `<li>${escapeHtml(t('原因：', 'Reason: '))}${stop.reason === '' ? escapeHtml(t('未给出原因', 'no reason given')) : escapeHtml(stop.reason)}</li>`,
            ].join('')
        return `<div class="banner bad" data-platform-stopped role="status">
    <strong>${escapeHtml(t('平台已停止。', 'Platform is stopped.'))}</strong>
    <ul>${facts}</ul>
    <form method="post" action="/admin/platform/resume" class="row">${csrf(viewer)}<button class="btn btn-danger" type="submit">${escapeHtml(t('恢复平台', 'Resume platform'))}</button></form>
  </div>`
      })()
  const body = `${stopBanner}<section class="card">
    <div class="eyebrow">${escapeHtml(t('管理', 'ADMIN'))}</div>
    <h1>${escapeHtml(t('审批与额度', 'Approvals & quota'))}</h1>
    <p class="muted">${escapeHtml(t(`申请邮件发往 ${config.mail.adminEmail}；这里的操作会写审计日志。`, `Applications are mailed to ${config.mail.adminEmail}; actions here are written to the audit log.`))} · ${escapeHtml(t('当前身份：', 'Role: '))}${escapeHtml(roleLabel(t, viewer.user.role))}${superadmin ? ` · <a class="link" href="/admin/metrics">${escapeHtml(t('产品指标', 'Product metrics'))}</a> · <a class="link" href="/admin/webhooks">${escapeHtml(t('Webhook deliveries', 'Webhook deliveries'))}</a>` : ''} · <a class="link" href="/admin/deployments">${escapeHtml(t('部署', 'Deployments'))}</a> · <a class="link" href="/admin/search">${escapeHtml(t('审计与任务', 'Audit and jobs'))}</a> · <a class="link" href="/admin/trials">${escapeHtml(t('试用预览', 'Preview trials'))}</a></p>
    ${superadmin ? `<form method="post" action="/admin/simulation" class="row">${csrf(viewer)}<input type="hidden" name="enable" value="${preview ? '0' : '1'}" /><input type="hidden" name="returnTo" value="/admin" /><button class="link" type="submit">${escapeHtml(preview ? t('退出用户视图预览', 'Exit user preview') : t('预览用户视图', 'Preview the user view'))}</button></form>` : ''}
  </section>
  <nav class="section-nav" aria-label="${escapeHtml(t('页面导航', 'Section navigation'))}">
    <a href="#release" data-allow-overflow>${escapeHtml(t('发布', 'Release'))}</a>
    <a href="#release-chain" data-allow-overflow>${escapeHtml(t('发布链', 'Release chain'))}</a>
    <a href="#backups" data-allow-overflow>${escapeHtml(t('备份', 'Backups'))}</a>
    <a href="#pending" data-allow-overflow>${escapeHtml(t('待审批', 'Pending'))}</a>
    <a href="#users" data-allow-overflow>${escapeHtml(t('用户', 'Users'))}</a>
    <a href="#jobs" data-allow-overflow>${escapeHtml(t('任务', 'Jobs'))}</a>
    ${showAudit ? `<a href="#audit" data-allow-overflow>${escapeHtml(t('审计', 'Audit'))}</a>` : ''}
  </nav>
  ${releaseCard}
  ${chainCard}
  ${backupCard}
  <section class="card" id="pending">
    <h2>${escapeHtml(t('待审批', 'Pending'))} <small class="count">${pending.length}</small></h2>
    <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('用户', 'User'))}</th><th>${escapeHtml(t('申请时间', 'Applied'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th></th></tr></thead><tbody>${pendingRows}</tbody></table></div>
  </section>
  <section class="card" id="users">
    <h2>${escapeHtml(t('用户', 'Users'))} <small class="count">${users.length}</small></h2>
    <div class="table-scroll"><table class="admin-users-table table-cards table-priority" id="admin-users-table" aria-label="${escapeHtml(t('用户', 'Users'))}"><thead><tr><th>${escapeHtml(t('登录名', 'Login'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('角色', 'Role'))}</th><th>${escapeHtml(t('额度', 'Quota'))}</th><th data-priority="low">${escapeHtml(t('已用', 'Used'))}</th><th data-priority="low">${escapeHtml(t('活动', 'Activity'))}</th><th>${escapeHtml(t('调整', 'Adjust'))}</th></tr></thead><tbody>${userRows}</tbody></table></div>
  </section>
  <section class="card" id="jobs">
    <div class="row between"><h2>${escapeHtml(t('最近任务', 'Recent jobs'))} <small class="count">${jobsTotal}</small></h2><span class="fine">${escapeHtml(t('每页 10 条', '10 per page'))}</span></div>
    ${jobTable(locale, jobs, { body: t('这里汇总所有用户的任务；还没有任何一条。', 'Jobs from every user are collected here; there are none yet.'), action: { href: '/admin/users', label: t('查看用户', 'View users') } }, { id: 'admin-jobs-table', name: t('最近任务', 'Recent jobs') })}
    ${pager('/admin', 'jobsPage', jobsPage, jobsTotal, perPage, t, showAudit ? { auditPage } : {})}
  </section>
  ${showAudit ? `<section class="card" id="audit">
    <div class="row between"><h2>${escapeHtml(t('审计', 'Audit'))} <small class="count">${auditTotal}</small></h2><span class="fine">${escapeHtml(t('每页 10 条', '10 per page'))}</span></div>
    <div class="table-scroll"><table class="table-cards table-priority" id="audit-table" aria-label="${escapeHtml(t('审计', 'Audit'))}"><thead><tr><th>${escapeHtml(t('时间', 'Time'))}</th><th>${escapeHtml(t('动作', 'Action'))}</th><th>${escapeHtml(t('操作者', 'Actor'))}</th><th data-priority="low">${escapeHtml(t('详情', 'Detail'))}</th></tr></thead><tbody>${auditRows(locale, audit, usersById, hideActor)}</tbody></table></div>
    ${pager('/admin', 'auditPage', auditPage, auditTotal, perPage, t, { jobsPage })}
  </section>` : ''}`
  return layout({ title: t('管理', 'Admin'), viewer, body, config, locale, path: '/admin', active: 'admin', notice, error, release })
}

export function approvalPage(input: { config: Config; locale: Locale; user: UserRow; action: 'approve' | 'reject'; token: string; error?: string }): string {
  const { config, locale, user, action, token, error } = input
  const t = translator(locale)
  const verb = action === 'approve' ? t('批准', 'Approve') : t('拒绝', 'Reject')
  const body = `<section class="card narrow">
    <div class="eyebrow">${escapeHtml(t('申请审批', 'APPLICATION REVIEW'))}</div>
    <h1>${escapeHtml(t(`${verb} @${user.login} 的申请？`, `${verb} @${user.login}'s application?`))}</h1>
    <p>${escapeHtml(user.name ?? '')} · ${escapeHtml(user.email ?? t('未公开邮箱', 'No public email'))} · <a href="https://github.com/${escapeHtml(user.login)}" target="_blank" rel="noreferrer">GitHub</a></p>
    <p class="muted">${escapeHtml(t(`申请时间 ${humanTimeShort(user.created_at)}。这个链接只能使用一次。`, `Applied ${humanTimeShort(user.created_at)}. This link can be used once.`))}</p>
    <form method="post" action="/approve/${escapeHtml(token)}">
      <button class="btn ${action === 'reject' ? 'btn-danger' : ''}" type="submit">${escapeHtml(verb)}</button>
      <a class="btn btn-ghost" href="/admin">${escapeHtml(t('去 Admin', 'Open Admin'))}</a>
    </form>
  </section>`
  return layout({ title: `${verb}`, body, config, locale, path: `/approve/${token}`, error })
}

export function errorPage(
  config: Config,
  viewer: Viewer | null,
  title: string,
  message: string,
  locale: Locale = 'zh',
  action?: { href: string; label: string },
): string {
  const t = translator(locale)
  const localizedTitle = localizeMessage(locale, title) ?? title
  const localizedMessage = localizeMessage(locale, message) ?? message
  const actionHtml = action === undefined ? '' : `<a class="btn" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
  return layout({
    title: localizedTitle,
    viewer,
    config,
    locale,
    path: '/',
    body: `<section class="card narrow"><h1>${escapeHtml(localizedTitle)}</h1><p>${escapeHtml(localizedMessage)}</p><div class="actions">${actionHtml}<a class="btn btn-ghost" href="/">${escapeHtml(t('回首页', 'Back home'))}</a></div></section>`,
  })
}

export function applyPage(input: { config: Config; locale: Locale; viewer: Viewer; notice?: string; error?: string }): string {
  const { config, locale, viewer, notice, error } = input
  const t = translator(locale)
  const agreements = agreementContent(locale)
  const body = `<section class="card narrow">
    <div class="eyebrow">${escapeHtml(t('访问申请', 'ACCESS REQUEST'))}</div>
    <h1>${escapeHtml(t('申请访问', 'Request access'))}</h1>
    <p>${escapeHtml(t(`@${viewer.user.login}，你的 GitHub 身份已确认。提交前请阅读并签署下面的两份文件；提交后不能重复提交，可以在状态页查看排队位置和审批结果。`, `@${viewer.user.login}, your GitHub identity is confirmed. Read and sign the two documents below before submitting. After submitting you cannot apply again; the status page shows your queue position and the decision.`))}</p>
    <p class="fine">${escapeHtml(t('此申请只覆盖 Fledge；FlyBot、Bot Social 和 ScienceDiscovery 需要各自授权。', 'This application covers Fledge only; FlyBot, Bot Social and ScienceDiscovery each require their own authorization.'))}</p>
    <div class="flow">
      <div class="flow-step"><span>01 / GitHub</span><b>${escapeHtml(t('登录', 'Sign in'))}</b><small>${escapeHtml(t('已完成', 'Done'))}</small></div>
      <div class="flow-step"><span>02 / Agreements</span><b>${escapeHtml(t('签署', 'Sign'))}</b><small>${escapeHtml(t('免责声明 + 信息安全', 'Disclaimer + security'))}</small></div>
      <div class="flow-step"><span>03 / Queue</span><b>${escapeHtml(t('排队', 'Queue'))}</b><small>${escapeHtml(t('管理员审批', 'Admin review'))}</small></div>
      <div class="flow-step"><span>04 / Service</span><b>${escapeHtml(t('进入', 'Enter'))}</b><small>${escapeHtml(t('获得访问', 'Access granted'))}</small></div>
    </div>
    <div class="agreement">
      <h2>${escapeHtml(agreements.disclaimerTitle)}</h2>
      ${agreementHtml(agreements.disclaimerText)}
      <h2>${escapeHtml(agreements.securityTitle)}</h2>
      ${agreementHtml(agreements.securityText)}
    </div>
    <form method="post" action="/apply" class="form">
      ${csrf(viewer)}
      <label>${escapeHtml(t('签署：输入你的 GitHub 登录名', 'Signature: enter your GitHub username'))} <code>${escapeHtml(viewer.user.login)}</code>
        <input name="signature" placeholder="${escapeHtml(viewer.user.login)}" required autocomplete="off" />
      </label>
      <label class="check"><input type="checkbox" name="disclaimer" value="1" required /> ${escapeHtml(t(`我已阅读并同意《${agreements.disclaimerTitle}》`, `I have read and agree to the ${agreements.disclaimerTitle}.`))}</label>
      <label class="check"><input type="checkbox" name="security" value="1" required /> ${escapeHtml(t(`我已阅读并同意《${agreements.securityTitle}》`, `I have read and agree to the ${agreements.securityTitle}.`))}</label>
      <button class="btn" type="submit">${escapeHtml(t('签署并提交申请', 'Sign and submit'))}</button>
      <p class="fine">${escapeHtml(t('提交即表示以上签名与勾选对应当前 GitHub 身份；平台会记录签署时间、IP 和 User-Agent。', 'Submitting confirms that the signature and checkboxes apply to this GitHub identity; the platform records the signing time, IP and User-Agent.'))}</p>
    </form>
  </section>`
  return layout({ title: t('申请访问', 'Request access'), viewer, body, config, locale, path: '/apply', notice, error })
}

export function applicationStatusPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  position: number | null
  total: number
  notice?: string
  error?: string
  mailFailed?: boolean
}): string {
  const { config, locale, viewer, position, total, notice, error } = input
  const t = translator(locale)
  const rejected = viewer.user.status === 'rejected'
  const submitted = viewer.user.application_submitted_at
  const queue = position === null ? '—' : `#${position}`
  const body = `<section class="card narrow">
    <div class="eyebrow">${escapeHtml(rejected ? t('申请已结束', 'APPLICATION CLOSED') : t('等待审批', 'WAITING FOR APPROVAL'))}</div>
    <h1>${escapeHtml(rejected ? t('申请未通过', 'Application not approved') : t('申请已提交，正在排队', 'Application submitted; you are in the queue'))}</h1>
    <p>${escapeHtml(t(`@${viewer.user.login}，${rejected ? '这次申请没有通过。如果情况有变化，请联系管理员；不要重复提交。' : '管理员审批后会发邮件通知，本页每 10 秒自动刷新。不要重复提交申请。'}`, `@${viewer.user.login}, ${rejected ? 'this application was not approved. If your situation changes, contact the administrator; do not submit again.' : 'you will receive email after the administrator reviews it. This page refreshes every 10 seconds. Do not submit again.'}`))}</p>
    ${input.mailFailed === true && !rejected ? `<div class="banner bad" role="status">${escapeHtml(t('审批邮件未送达管理员：SMTP 发送失败。管理员可以在 /admin 的待审批列表里重新发送，你的排队位置不受影响。', 'The approval mail did not reach the administrator: the SMTP send failed. An admin can resend it from the pending list on /admin; your queue position is unchanged.'))}</div>` : ''}
    <p class="fine">${escapeHtml(t('Fledge 的审批只覆盖 Fledge；FlyBot、Bot Social 和 ScienceDiscovery 需要各自的授权。', 'Fledge approval covers Fledge only; FlyBot, Bot Social and ScienceDiscovery each require their own authorization.'))}</p>
    <div class="flow">
      <div class="flow-step"><span>01 / GitHub</span><b>${escapeHtml(t('登录', 'Sign in'))}</b><small>${escapeHtml(t('已完成', 'Done'))}</small></div>
      <div class="flow-step"><span>02 / Agreements</span><b>${escapeHtml(t('签署', 'Sign'))}</b><small>${escapeHtml(viewer.user.disclaimer_name ?? t('已签署', 'Signed'))}</small></div>
      <div class="flow-step"><span>03 / Queue</span><b>${escapeHtml(rejected ? t('已结束', 'Closed') : t('排队中', 'In queue'))}</b><small>${escapeHtml(rejected ? t('未通过', 'Not approved') : t(`位置 ${queue} / ${total}`, `Position ${queue} / ${total}`))}</small></div>
      <div class="flow-step"><span>04 / Service</span><b>${escapeHtml(t('进入', 'Enter'))}</b><small>${escapeHtml(rejected ? t('需要管理员重新开启', 'The administrator must reopen it') : t('审批通过后', 'After approval'))}</small></div>
    </div>
    <div class="quota-card card">
      <div>
        <div class="eyebrow">${escapeHtml(t('排队位置', 'QUEUE POSITION'))}</div>
        <div class="quota-big"><span data-queue-position>${escapeHtml(queue)}</span><small> / ${total} ${escapeHtml(t('待审批', 'pending'))}</small></div>
        <p class="muted">${escapeHtml(t('提交时间', 'Submitted'))} ${escapeHtml(humanTimeShort(submitted))} · ${escapeHtml(t('签署', 'Signed'))} ${escapeHtml(viewer.user.disclaimer_name ?? '—')}</p>
      </div>
    </div>
    ${rejected ? '' : `<p class="fine">${escapeHtml(t('管理员通常在一个工作日内处理。邮件可能进入垃圾箱；也可以回到本页查看状态。', 'The administrator usually reviews within one business day. Check your spam folder or return to this page for the status.'))}</p>`}
    <form method="post" action="/auth/logout">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('退出登录', 'Sign out'))}</button></form>
  </section>
  <script src="/assets/application.js" defer></script>`
  return layout({ title: rejected ? t('申请未通过', 'Application not approved') : t('申请状态', 'Application status'), viewer, body, config, locale, path: '/apply/status', notice, error })
}

export function workspacePage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repos: RepoRow[]
  jobs: JobRow[]
  jobsTotal?: number
  activeJobs?: number
  questions?: InboxQuestion[]
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repos, jobs, notice, error } = input
  const jobsTotal = input.jobsTotal ?? jobs.length
  const questions = input.questions ?? []
  const t = translator(locale)
  const quota = quotaView(viewer.user, config)
  const active = input.activeJobs ?? jobs.filter((job) => job.status === 'queued' || job.status === 'running').length
  const recent = jobs.slice(0, 10)
  const reposById = new Map(repos.map((repo) => [repo.id, `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`]))
  const repoBlock = repos.length === 0
    ? `<div class="empty">
        <p><strong>${escapeHtml(t('还没有仓库。', 'No repositories yet.'))}</strong> ${escapeHtml(t('添加第一个仓库后，FlyBot 才会开始迭代。', 'Add your first repository and FlyBot can start iterating.'))}</p>
        <a class="btn" href="/dashboard#add-repo">${escapeHtml(t('添加仓库', 'Add repository'))}</a>
      </div>`
    : `<div class="list">${repos
        .slice(0, 4)
        .map(
          (repo) => `<a class="list-row" href="/repos/${escapeHtml(repo.id)}">
            <div class="list-main">
              <strong>${escapeHtml(repo.upstream_owner || repo.owner)}/${escapeHtml(repo.upstream_name || repo.name)}</strong>
              <small>${repo.auto_iterate === 1 ? `${escapeHtml(t('自动工作', 'Auto work'))}` : escapeHtml(t('手动', 'Manual'))} · ${escapeHtml(t('上次运行', 'Last run'))} ${escapeHtml(humanTimeShort(repo.last_run_at))}${repo.is_fork === 1 ? ` · ${escapeHtml(t('fork', 'fork'))} ${escapeHtml(repo.fork_owner)}/${escapeHtml(repo.fork_name)}` : ''}</small>
            </div>
            <div class="list-meta">${badge(t, repo.last_status ?? 'idle')}${repo.reviewer_enabled === 1 ? ' <span class="badge">reviewer</span>' : ''}</div>
          </a>`,
        )
        .join('')}</div>
      ${repos.length > 4 ? `<p class="fine more-note"><a class="link fine-link" href="/dashboard">${escapeHtml(t(`查看其余 ${repos.length - 4} 个仓库`, `View the other ${repos.length - 4} repositories`))}</a></p>` : ''}`
  const initial = viewer.user.login.slice(0, 1).toUpperCase()
  const avatar = viewer.user.avatar_url === null || viewer.user.avatar_url === ''
    ? `<span class="workspace-avatar workspace-avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`
    : `<img class="workspace-avatar" src="${escapeHtml(viewer.user.avatar_url)}" alt="" width="56" height="56" />`
  const body = `<section class="workspace-hero">
    <div class="workspace-intro">
      <div class="workspace-user">
        ${avatar}
        <div>
          <div class="eyebrow">${escapeHtml(t('工作区', 'WORKSPACE'))}</div>
          <h1>@${escapeHtml(viewer.user.login)}</h1>
          <p class="workspace-meta">${badge(t, viewer.user.status)} <span class="dot-sep">·</span> ${escapeHtml(t('加入于', 'Joined'))} ${escapeHtml(humanTimeShort(viewer.user.created_at))}</p>
        </div>
      </div>
      <p class="muted">${escapeHtml(t('管理仓库、任务和模型额度；需要完整列表时进入仓库页。', 'Manage repositories, jobs and model quota; open Repositories for the full list.'))}</p>
    </div>
    <div class="workspace-actions">
      <a class="btn" href="/dashboard#add-repo">${escapeHtml(t('添加仓库', 'Add repository'))}</a>
      <a class="btn btn-ghost" href="/search">${escapeHtml(t('搜索', 'Search'))}</a>
      <a class="btn btn-ghost" href="/settings">${escapeHtml(t('设置', 'Settings'))}</a>
      <a class="btn btn-ghost" href="${escapeHtml(config.services.docs)}" target="_blank" rel="noreferrer">${escapeHtml(t('文档', 'Docs'))}</a>
    </div>
  </section>
  ${quota.exhausted ? `<div class="banner bad">${escapeHtml(t('平台额度已用完。请到 Settings → Model 配置你自己的模型 API，任务才能继续。', 'Platform quota is used up. Add your own model API in Settings → Model to keep jobs running.'))}</div>` : ''}
  ${inboxSection(locale, viewer, questions, '/console')}
  <section class="stats">
    <a class="stat" href="/dashboard"><span>${escapeHtml(t('仓库', 'Repositories'))}</span><strong>${repos.length}</strong><small>${escapeHtml(t('已接入', 'Connected'))}</small></a>
    <a class="stat" href="/dashboard"><span>${escapeHtml(t('进行中', 'In progress'))}</span><strong>${active}</strong><small>${escapeHtml(t('排队或运行', 'Queued or running'))}</small></a>
    <a class="stat" href="${questions.length === 0 ? '/dashboard' : '#inbox'}"><span>${escapeHtml(t('需要你处理', 'Needs your input'))}</span><strong>${questions.length}</strong><small>${escapeHtml(questions.length === 0 ? t('没有待回答问题', 'No open questions') : t('FlyBot 正在等你', 'FlyBot is waiting'))}</small></a>
    <a class="stat" href="/settings#model"><span>${escapeHtml(t('平台额度', 'Platform quota'))}</span><strong>${quota.unlimited ? escapeHtml(t('不限额', 'Unlimited')) : quotaMoney(quota.remainingCny)}</strong><small>${escapeHtml(quota.unlimited ? t('用量仍会记录', 'usage is still recorded') : t(`剩余 / ${money(quota.initialCny)}`, `left of ${money(quota.initialCny)}`))}</small></a>
  </section>
  <section class="card">
    <div class="row between"><h2>${escapeHtml(t('仓库', 'Repositories'))}</h2><a class="link" href="/dashboard">${escapeHtml(t('管理全部', 'Manage all'))}</a></div>
    ${repoBlock}
  </section>
  <section class="card">
    <div class="row between"><h2>${escapeHtml(t('最近任务', 'Recent jobs'))}</h2><a class="link" href="/dashboard">${escapeHtml(t('查看全部', 'View all'))}</a></div>
    ${jobList(locale, recent, reposById, { body: t('在仓库页点“立即运行”创建第一个任务；每个任务只开一个 PR。', 'Run the first job from a repository page; each job opens at most one pull request.'), action: { href: '/dashboard', label: t('打开仓库', 'Open a repository') } })}
    ${jobsTotal > recent.length ? `<p class="fine more-note"><a class="link fine-link" href="/dashboard#jobs">${escapeHtml(t(`查看其余 ${jobsTotal - recent.length} 个任务`, `View the other ${jobsTotal - recent.length} jobs`))}</a></p>` : ''}
  </section>`
  return layout({ title: t('工作区', 'Workspace'), viewer, body, config, locale, path: '/console', active: 'console', notice, error })
}

export function messagePage(config: Config, title: string, message: string, viewer?: Viewer | null, locale: Locale = 'zh'): string {
  const t = translator(locale)
  const localizedTitle = localizeMessage(locale, title) ?? title
  const localizedMessage = localizeMessage(locale, message) ?? message
  return layout({
    title: localizedTitle,
    viewer,
    config,
    locale,
    path: '/',
    body: `<section class="card narrow"><h1>${escapeHtml(localizedTitle)}</h1><p>${escapeHtml(localizedMessage)}</p><a class="btn btn-ghost" href="/">${escapeHtml(t('回首页', 'Back home'))}</a></section>`,
  })
}

export function jobPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repo: RepoRow
  job: JobRow
  // #565: position and total are instance-wide counts, so the route hands over
  // the queue rather than a bare index. The ahead-list is the viewer's own
  // queued jobs only; a job owned by anybody else stays a count.
  queued?: JobRow[]
  viewerActive?: JobRow[]
  repoLabels?: Map<string, string>
  events?: JobEventRow[]
  postmortem?: PostmortemRow | null
  supportMode?: boolean
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repo, job, notice, error } = input
  const events = input.events ?? []
  const postmortem = input.postmortem ?? null
  const supportMode = input.supportMode === true
  const t = translator(locale)
  const advanced = advancedViewer(viewer)
  const evidence = parseEvidenceJson(job.evidence_json)
  const failure = classifyFailure(job)
  const failureLink = failure === null ? '' : failureHref(failure.action, repo.id)
  const verification = parseVerification(job.verification_json)
  const pathGuard = parsePathGuard(job.path_guard_json)
  // #382: the independent pass records one event per attempt. The page shows what
  // it decided, including the case where its answer was not a review at all.
  // Callers hand over `Store.listJobEvents`, which is newest-first (`ORDER BY id
  // DESC`), so the first adversarial event is the newest verdict. Reversing the
  // list would show the first tip's answer forever: a job whose later tip cleared
  // the risk would keep claiming its merge was blocked.
  const adversarial = parseAdversarialRecord(events.find((event) => event.kind === 'job.adversarial')?.meta)
  const adversarialText = (record: AdversarialRecord): string => record.status === 'risk'
    ? t(`具体风险 ${record.target ?? ''} — 自动合并已阻止`, `concrete risk ${record.target ?? ''} — the automatic merge was blocked`)
    : record.status === 'incomplete'
      ? t(`审核未能读完整改动，自动合并已阻止：${record.reason ?? ''}`, `the review could not read the whole change, so the automatic merge was blocked: ${record.reason ?? ''}`)
      : record.status === 'none'
        ? t(`未发现具体风险${record.checks.length === 0 ? '' : `（检查：${record.checks.join('、')}）`}`, `no concrete risk${record.checks.length === 0 ? '' : ` (checks: ${record.checks.join(', ')})`}`)
        : record.status === 'invalid'
          ? t(`回答被拒绝，不算一次审核：${record.reason ?? ''}`, `answer rejected as not a review: ${record.reason ?? ''}`)
          : t(`未运行：${record.reason ?? ''}`, `not run: ${record.reason ?? ''}`)
  const readiness = mergeReadiness(job)
  // The badge above combines the path guard with the PR evidence; the evidence
  // row used to read verification.ok alone, so a PR the guard blocked still
  // claimed its evidence had passed. The row carries the combined verdict now:
  // it lowers its own claim only when the guard is what blocks the merge.
  const guardBlocks = pathGuard !== null && !pathGuard.ok
  const evidenceVerdict = verification === null
    ? ''
    : verification.ok
      ? guardBlocks
        ? t('证据已核实，合并被路径守卫阻止', 'Evidence verified; the merge is blocked by the path guard')
        : t('证据通过', 'Evidence passed')
      : t('证据未通过', 'Evidence failed')
  // #251: a follow-up stores the reviewer's words in the goal (one field, no
  // column), so the console reads that same line back. Without this row the
  // maintainer cannot tell what the agent was told, which was the second half of
  // the defect: the fixed reason was not visible as a reason either.
  const reviewerInstruction = job.trigger === 'followup' ? reviewInstructionFromGoal(job.goal) : ''
  // #357: a budget stop is not a failure category — the job stopped on purpose
  // and the only useful next step is the budget. The reason string carries the
  // observed cost, so the page says both without a second lookup.
  const budgetStop = (job.error ?? '').startsWith('JOB_BUDGET_') ? redact((job.error ?? '').replace(/^JOB_BUDGET_(PAUSED|CANCELLED):\s*/, '')) : ''
  const attribution = jobAttribution(t, job)
  // #358: which model actually answered, and what it fell through. A job whose
  // primary was rate-limited finished on another model, so the page must name the
  // one that replied instead of the one the instance was configured with.
  const modelRun = parseModelRun(job.model_json)
  const triedText = (run: typeof modelRun): string => (run === null ? '' : run.attempts.map((entry) => `${entry.label} (${entry.status})`).join(', '))
  // #407: a fallback an earlier call made is its own clause. The rule: it is stated
  // unless the `tried` clause of this same line already names the model it ended
  // on — only then would two clauses repeat one model. So the skip needs the tried
  // clause to exist (`attempts` non-empty) and a model to compare against; a last
  // call with no attempt or no winner keeps the pair visible. A row whose status is
  // not a real HTTP code states the pair without inventing a number for it.
  const fellBackText = (run: typeof modelRun): string => {
    if (run === null || run.fallback === null) return ''
    if (run.attempts.length > 0 && run.model !== null && run.fallback.to.label === run.model.label) return ''
    const status = Number.isInteger(run.fallback.status) && run.fallback.status > 0 ? run.fallback.status : null
    return ` · ${status === null
      ? t(`此前调用回退至 ${run.fallback.to.label}`, `earlier call fell back to ${run.fallback.to.label}`)
      : t(`此前调用回退（${status}）至 ${run.fallback.to.label}`, `earlier call fell back (${status}) to ${run.fallback.to.label}`)}`
  }
  const modelLine = modelRun === null
    ? ''
    : `<p class="fine" data-model><strong>${escapeHtml(t('模型', 'Model'))}:</strong> ${escapeHtml(modelRun.model === null ? t('没有完成的调用', 'no completed call') : modelRun.model.label)}${modelRun.attempts.length === 0 ? '' : escapeHtml(` · ${t(`此前尝试 ${triedText(modelRun)}`, `tried ${triedText(modelRun)}`)}`)}${escapeHtml(fellBackText(modelRun))}</p>`
  const providerParts = [
    job.provider_label === null ? '' : job.provider_label,
    job.provider_region === null ? '' : job.provider_region,
    job.provider_model === null ? '' : job.provider_model,
  ].filter((part) => part !== '')
  const providerLine = providerParts.length === 0
    ? ''
    : `<p class="fine" data-provider><strong>${escapeHtml(t('提供方', 'Provider'))}:</strong> ${escapeHtml(providerParts.join(' · '))}</p>`
  const cost = quotaMoney(job.cost_usd * config.quota.usdCny)
  const riskLabel = evidence?.risk === 'low' ? t('低', 'Low') : evidence?.risk === 'high' ? t('高', 'High') : evidence?.risk === 'medium' ? t('中', 'Medium') : '—'
  const teamStats = jobTeamStats(job)
  const teamRows = teamStats === null
    ? `<p class="muted">${escapeHtml(t('还没有团队调用统计。', 'No team call stats yet.'))}</p>`
    : `<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('角色', 'Role'))}</th><th>${escapeHtml(t('调用', 'Calls'))}</th><th>${escapeHtml(t('当前/最后工具', 'Current/last tool'))}</th><th>${escapeHtml(t('最后活动', 'Last activity'))}</th></tr></thead><tbody>${teamStats.map((entry) => `<tr><td>${escapeHtml(teamRoleLabel(t, entry.role) === entry.role ? entry.label : teamRoleLabel(t, entry.role))}</td><td>${entry.calls}</td><td>${escapeHtml([entry.tool, entry.step].filter(Boolean).join(' · ') || '—')}</td><td>${escapeHtml(entry.lastActivityAt === null ? '—' : humanTimeShort(new Date(entry.lastActivityAt).toISOString()))}</td></tr>`).join('')}</tbody></table></div>`
  const evidenceRows = evidence === null
    ? `<p class="muted">${escapeHtml(t('团队还没有回报结构化证据。', 'The team has not reported structured evidence yet.'))}</p>`
    : `<div class="list">
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('范围', 'Scope'))}</strong><small>${escapeHtml(evidence.scope ?? '—')}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('验收标准', 'Acceptance'))}</strong><small>${escapeHtml(evidence.acceptance ?? '—')}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('测试计划', 'Test plan'))}</strong><small>${escapeHtml(evidence.testPlan ?? '—')}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('失败测试', 'Red test'))}</strong><small>${escapeHtml(evidence.testRed ?? '—')}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('通过测试', 'Green test'))}</strong><small>${escapeHtml(evidence.testGreen ?? '—')}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('测试', 'Tests'))}</strong><small>${escapeHtml(evidence.tests ?? '—')}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('CI / checks', 'CI / checks'))}</strong><small>${escapeHtml(evidence.checks ?? '—')}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('改动文件', 'Files changed'))}</strong><small>${evidence.files ?? '—'}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('风险', 'Risk'))}</strong><small>${escapeHtml(riskLabel)}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('回滚', 'Rollback'))}</strong><small>${escapeHtml(evidence.rollback ?? '—')}</small></div></div>
      </div>`
  const retry = job.status === 'failed'
    ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/retry">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(job.checkpoint === null || job.checkpoint === '' ? t('重试这个任务', 'Retry this job') : t('从断点继续', 'Resume from checkpoint'))}</button></form>`
    : ''
  const recheck = job.pr_url === null || supportMode ? '' : `<form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/recheck">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('重新核实 PR', 'Re-check PR'))}</button></form>`
  const execute = job.kind === 'plan' && job.status === 'succeeded' && job.plan_approved_at !== null
    ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/execute">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(t('执行这个计划', 'Execute this plan'))}</button></form>`
    : ''
  const control = job.status === 'queued' || job.status === 'running'
    ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/pause">${csrf(viewer)}<button class="btn btn-ghost" type="submit">${escapeHtml(t('暂停', 'Pause'))}</button></form><form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/cancel" data-confirm="${escapeHtml(t('取消这个任务？', 'Cancel this job?'))}">${csrf(viewer)}<button class="btn btn-danger" type="submit">${escapeHtml(t('取消', 'Cancel'))}</button></form>`
    : job.status === 'paused'
      ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/resume">${csrf(viewer)}<button class="btn" type="submit">${escapeHtml(t('恢复', 'Resume'))}</button></form>`
      : ''
  const planCard = job.kind === 'plan' && job.status === 'succeeded'
    ? `<section class="card">
        <div class="row between"><div><h2>${escapeHtml(t('计划审批', 'Plan approval'))}</h2><p class="muted">${job.plan_rejected_at !== null ? escapeHtml(t('计划已被拒绝。', 'This plan was rejected.')) : job.plan_approved_at !== null ? escapeHtml(t('计划已批准；可以执行。', 'This plan is approved and can be executed.')) : escapeHtml(t('等待 maintainer 批准计划。', 'Waiting for a maintainer to approve the plan.'))}</p></div><span class="badge ${job.plan_approved_at !== null ? 'good' : job.plan_rejected_at !== null ? 'bad' : 'busy'}">${job.plan_approved_at !== null ? escapeHtml(t('已批准', 'Approved')) : job.plan_rejected_at !== null ? escapeHtml(t('已拒绝', 'Rejected')) : escapeHtml(t('待批准', 'Pending'))}</span></div>
        ${repo.repo_role === 'maintainer' && job.plan_approved_at === null && job.plan_rejected_at === null ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/approve-plan" class="form">${csrf(viewer)}
          <div class="row"><label class="grow">${escapeHtml(t('允许修改路径', 'Allowed paths'))} <input name="allowPaths" value="${escapeHtml(job.plan_allow_paths ?? repo.allow_paths)}" placeholder="src/, docs/" /></label><label class="grow">${escapeHtml(t('禁止修改路径', 'Forbidden paths'))} <input name="denyPaths" value="${escapeHtml(job.plan_deny_paths ?? repo.deny_paths)}" placeholder=".github/, deploy/" /></label></div>
          <div class="row"><button class="btn" type="submit">${escapeHtml(t('批准计划', 'Approve plan'))}</button><button class="btn btn-danger" type="submit" formaction="/repos/${escapeHtml(repo.id)}/jobs/${escapeHtml(job.id)}/reject-plan" data-confirm="${escapeHtml(t('拒绝这个计划？', 'Reject this plan?'))}">${escapeHtml(t('拒绝', 'Reject'))}</button></div>
        </form>` : job.plan_approved_at !== null ? `<p class="fine">${escapeHtml(t('批准人', 'Approved by'))} ${escapeHtml(job.plan_approved_by ?? '—')} · ${escapeHtml(t('允许路径', 'Allowed'))} ${escapeHtml(job.plan_allow_paths ?? '—')} · ${escapeHtml(t('禁止路径', 'Forbidden'))} ${escapeHtml(job.plan_deny_paths ?? '—')}</p>` : ''}
      </section>`
    : ''
  // #390: the work type is data, so the page reads it back from the registry
  // instead of restating it. An unknown or missing type renders as iterate, which
  // is what every row written before the column means.
  const workType = resolveWorkType(job.work_type) ?? contractOf('iterate')
  const workTypeCard = `<section class="card" data-work-type="${escapeHtml(workType.type)}">
    <h2>${escapeHtml(t('工作类型', 'Work type'))}</h2>
    <p><strong>${escapeHtml(workTypeLabel(t, workType.type))}</strong> — ${escapeHtml(workTypePurpose(t, workType.type))}</p>
    <div class="list">
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('可用阶段', 'Stages'))}</strong><small>${escapeHtml(workType.stages.length === 0 ? t('无（只读）', 'none (read-only)') : workType.stages.join(', '))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('必需证据', 'Required evidence'))}</strong><small>${escapeHtml(workType.evidence.length === 0 ? t('无', 'none') : workType.evidence.map((key) => `evidence.${key}`).join(', '))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('风险等级', 'Risk tier'))}</strong><small>${escapeHtml(workType.risk)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('可创建分支/PR', 'May open a branch/PR'))}</strong><small>${escapeHtml(workType.branch ? t('是', 'yes') : t('否', 'no'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('可自动合并', 'May auto-merge'))}</strong><small>${escapeHtml(workType.autoMerge ? t('是', 'yes') : t('否', 'no'))}</small></div></div>
    </div>
  </section>`
  const triageReport = parseTriageJson(job.triage_json)
  const triageRows = triageReport === null
    ? ''
    : triageReport.items.length === 0
      ? `<p class="muted">${escapeHtml(t('看板上没有待办 issue。', 'No open issue is waiting on the board.'))}</p>`
      : `<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('排名', 'Rank'))}</th><th>issue</th><th>${escapeHtml(t('优先级', 'Priority'))}</th><th>${escapeHtml(t('重复于', 'Duplicate of'))}</th></tr></thead><tbody>${triageReport.items.map((item, index) => `<tr><td>${index + 1}</td><td><a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">#${item.issue}</a> ${escapeHtml(item.title)}${triageReport.next !== null && triageReport.next.issue === item.issue ? ` · <strong>${escapeHtml(t('下一项', 'next'))}</strong>` : ''}</td><td>${item.priority}</td><td>${item.duplicateOf === null ? '—' : `#${item.duplicateOf}`}</td></tr>`).join('')}</tbody></table></div>`
  const triageCard = job.kind !== 'triage'
    ? ''
    : `<section class="card" data-triage>
    <h2>${escapeHtml(t('分诊结果', 'Triage result'))}</h2>
    ${triageReport === null
      ? `<p class="muted">${escapeHtml(t('还没有分诊结果。', 'No triage result yet.'))}</p>`
      : `<p class="fine">${escapeHtml(triageSummaryLine(triageReport))}</p>${triageRows}`}
  </section>`
  const jobLoading = job.status === 'queued' || job.status === 'running'
    ? renderState({ kind: 'loading', title: job.status === 'queued' ? t('任务已排队。', 'This job is queued.') : t('任务正在运行。', 'This job is running.'), body: job.status === 'queued' ? t('前面的任务结束后自动开始；这个页面会自己更新。', 'It starts as soon as the jobs ahead finish; this page updates by itself.') : t('团队进度会写进下面的时间线，不需要手动刷新。', 'Team progress lands in the timeline below; no manual refresh needed.'), skeletonLines: 2 })
    : ''
  const postmortemCard = postmortem === null ? '' : `<section class="card" id="postmortem">
    <div class="row between">
      <div><div class="eyebrow">${escapeHtml(t('故障复盘', 'INCIDENT'))}</div><h2>${escapeHtml(t('复盘', 'Postmortem'))}</h2><p class="muted">${escapeHtml(postmortem.evidence_state === 'verified' ? t('证据来自这个任务的错误、心跳、阶段和实例状态。', 'Evidence comes from this job’s error, heartbeat, stage and instance state.') : t('没有可用的证据：原因保持未核实，不做猜测。', 'No usable evidence: the cause stays unverified and is not guessed.'))}</p></div>
      <span class="badge ${postmortem.status === 'closed' ? 'good' : 'busy'}">${escapeHtml(postmortem.status === 'closed' ? t('已关闭', 'Closed') : t('未关闭', 'Open'))}</span>
    </div>
    <div class="list">
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('分类', 'Category'))}</strong><small>${escapeHtml(postmortem.category)} · ${escapeHtml(postmortem.evidence_state)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('疑似原因', 'Suspected cause'))}</strong><small>${escapeHtml(postmortem.suspected_cause ?? t('未核实', 'Unverified'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('复发键', 'Recurrence key'))}</strong><small><code>${escapeHtml(postmortem.recurrence_key)}</code></small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('负责人', 'Owner'))}</strong><small>${escapeHtml(postmortem.owner)}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('预防措施', 'Preventive action'))}</strong><small>${preventiveActionHtml(postmortem.preventive_action)}${postmortem.preventive_action === null ? '' : ` · ${escapeHtml(postmortem.preventive_verified === 1 ? t('已核实', 'Verified') : t('待核实', 'Awaiting verification'))}`}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('首次 / 最近', 'First / last'))}</strong><small>${escapeHtml(humanTimeShort(postmortem.first_seen_at))} / ${escapeHtml(humanTimeShort(postmortem.last_seen_at))}</small></div></div>
    </div>
    <p class="fine"><a class="link" href="/repos/${escapeHtml(repo.id)}#postmortems">${escapeHtml(postmortem.status === 'closed' ? t('查看已关闭的复盘', 'View the closed postmortem') : t('打开复盘记录', 'Open postmortem'))}</a></p>
  </section>`
  // #565: a queued job shows its place in the real (instance-wide) line as a
  // count, the priority it competes on, the viewer's own jobs ahead of it, and —
  // when other accounts are ahead — only how many. No identifier of another
  // tenant's job is interpolated here; the order is the claimer's two keys.
  const rank = job.status === 'queued' ? rankQueued(input.queued ?? [], job.id) : null
  const queueBlock = rank === null ? '' : (() => {
    const ahead = aheadOfViewer({ queued: input.queued ?? [], viewerActive: input.viewerActive ?? [], viewerId: viewer.user.id, jobId: job.id })
    const labels = input.repoLabels ?? new Map<string, string>()
    const ownedRows = ahead.owned.map((entry) => `<div class="list-row" data-queue-owned-job="${escapeHtml(entry.id)}">
        <div class="list-main"><a href="/repos/${escapeHtml(entry.repo_id)}/jobs/${escapeHtml(entry.id)}">${escapeHtml(labels.get(entry.repo_id) ?? entry.repo_id)}</a>
          <small>${escapeHtml(t(`优先级 ${entry.priority}（${triggerLabel(t, entry.trigger)}）`, `priority ${entry.priority} (${triggerLabel(t, entry.trigger).toLowerCase()})`))} · ${escapeHtml(humanTimeShort(entry.created_at))}</small></div>
      </div>`).join('')
    const others = ahead.othersAhead === 0
      ? ''
      : `<p class="fine" data-queue-others>${escapeHtml(ahead.othersAhead === 1
        ? t('另有 1 个排队任务在前，不显示详情。', '1 other queued job is ahead; its details are not shown.')
        : t(`另有 ${ahead.othersAhead} 个排队任务在前，不显示详情。`, `${ahead.othersAhead} other queued jobs are ahead; their details are not shown.`))}</p>`
    return `<div data-queue>
      <p class="fine" data-job-queue-position>${escapeHtml(t(`队列位置 ${rank.position} / 共 ${rank.total} · 优先级 ${job.priority}（${triggerLabel(t, job.trigger)}）`, `Queue position ${rank.position} of ${rank.total} · priority ${job.priority} (${triggerLabel(t, job.trigger).toLowerCase()})`))}</p>
      <p class="fine" data-queue-rule>${escapeHtml(t('按优先级、再按进入顺序排队；同一位置可能有多个任务。仓库里已有运行中或更早的排队任务时，这个位置不会立即开始。', 'Position is by priority, then arrival; jobs equal on both share a position. A repository with a running or earlier queued job delays its own next job, so this is the order, not a promise that it starts next.'))}</p>
      ${ahead.owned.length === 0 ? '' : `<p class="fine">${escapeHtml(t('你的排队任务，按优先级、再按进入顺序：', 'Your queued jobs, by priority, then arrival:'))}</p><div class="list" data-queue-owned>${ownedRows}</div>`}
      ${others}
    </div>`
  })()
  const body = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('任务', 'JOB'))}</div>
        <h1><code>${escapeHtml(job.id)}</code></h1>
        <p class="muted">${escapeHtml(repo.upstream_owner || repo.owner)}/${escapeHtml(repo.upstream_name || repo.name)} · ${badge(t, job.status)} · ${escapeHtml(jobKindLabel(t, job))} · ${escapeHtml(triggerLabel(t, job.trigger))} · ${escapeHtml(t('目标分支', 'Base branch'))} <code>${escapeHtml(job.base_branch ?? (repo.target_branch !== '' ? repo.target_branch : (repo.upstream_default_branch || repo.default_branch)))}</code>${job.base_sha === null ? '' : ` · ${escapeHtml(t('基于', 'Based on'))} <code>${escapeHtml(job.base_sha.slice(0, 12))}</code>`}${job.last_callback_at === null ? '' : ` · ${escapeHtml(t('最后心跳', 'Last heartbeat'))} ${escapeHtml(humanTimeShort(job.last_callback_at))}`}</p>
      </div>
      <div class="row">
        <a class="btn btn-ghost" href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('返回仓库', 'Back to repository'))}</a>
        ${supportMode ? '' : `<a class="btn btn-ghost" href="/repos/${escapeHtml(repo.id)}/workspace">${escapeHtml(t('工作区', 'Workspace'))}</a>`}
        ${advanced && !supportMode ? `<a class="btn btn-ghost" href="/repos/${escapeHtml(repo.id)}/team">${escapeHtml(t('团队工作台', 'Team console'))}</a>` : ''}
        ${supportMode ? '' : control}
        ${supportMode ? '' : execute}
        ${supportMode ? '' : recheck}
        ${supportMode ? '' : retry}
      </div>
    </div>
    ${queueBlock}
  </section>
  ${jobLoading}
  ${supportMode ? '' : planCard}
  ${postmortemCard}
  ${supportMode ? '' : workTypeCard}
  ${supportMode ? '' : triageCard}
  <section class="cols">
    <div class="card">
      <h2>${escapeHtml(t('结果', 'Result'))}</h2>
      <p class="${job.kind === 'research' ? 'job-report' : ''}">${escapeHtml(jobSummary(locale, t, job))}</p>
      ${reviewerInstruction === '' ? '' : `<p class="fine" data-reviewer-instruction><strong>${escapeHtml(t('审核者要求', REVIEW_INSTRUCTION_LABEL))}:</strong> ${escapeHtml(reviewerInstruction)}</p>`}
      ${failure === null ? '' : renderState({ kind: 'error', title: failureLabel(t, failure.kind), body: t(failure.hint[0], failure.hint[1]), action: failureLink === '' ? { label: t('按上面的动作处理后再重试。', 'Fix the cause above, then retry.') } : { href: failureLink, label: failureActionLabel(t, failure.action) } })}
      ${budgetStop === '' ? '' : renderState({ kind: 'error', title: t('已达单任务预算', 'Per-job budget reached'), body: budgetStop, action: { href: `/repos/${repo.id}#repo-settings`, label: t('提高单任务预算', 'Raise the per-job budget') } })}
      ${job.error === null || job.error === '' ? '' : `<details class="fine"><summary>${escapeHtml(t('技术详情', 'Technical detail'))}</summary><p>${escapeHtml(redact(job.error))}</p></details>`}
      <p class="fine">${escapeHtml(t('成本', 'Cost'))} ${escapeHtml(cost)} · ${escapeHtml(t('创建', 'Created'))} ${escapeHtml(humanTimeShort(job.created_at))} · ${escapeHtml(t('结束', 'Finished'))} ${escapeHtml(humanTimeShort(job.finished_at))}</p>
      ${attribution === '' ? '' : `<p class="fine">${escapeHtml(attribution)}</p>`}
      ${modelLine}
      ${providerLine}
      ${job.checkpoint === null || job.checkpoint === '' ? '' : `<p class="fine"><strong>${escapeHtml(t('断点', 'Checkpoint'))}:</strong> ${escapeHtml(job.checkpoint)}</p>`}
      <p class="fine">${jobLinks(job)}</p>
    </div>
    <div class="card">
      <h2>${escapeHtml(t('证据', 'Evidence'))}</h2>
      ${evidenceRows}
    </div>
  </section>
  ${supportMode ? '' : `<section class="card">
    <h2>${escapeHtml(t('PR 核实', 'PR verification'))}</h2>
    <div class="row between">
      <div>${readinessBadge(t, readiness.state)}${readiness.reasons.length === 0 ? '' : `<p class="fine">${escapeHtml(readiness.reasons.slice(0, 6).join(' · '))}</p>`}</div>
      ${recheck}
    </div>
    ${verification === null
      ? `<p class="muted">${escapeHtml(t('还没有核实记录。任务回调后会自动核实；也可以现在重新检查。', 'No verification yet. It runs after a job callback; you can also re-check now.'))}</p>`
      : `<div class="list">
          <div class="list-row"><div class="list-main"><strong>${escapeHtml(evidenceVerdict)}</strong><small>${escapeHtml(t('核实时间', 'Checked'))} ${escapeHtml(humanTimeShort(verification.checkedAt))} · ${escapeHtml(t('基于', 'At'))} <code>${escapeHtml(verification.sha.slice(0, 12))}</code></small></div></div>
          <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('检查', 'Checks'))}</strong><small>${verification.checks.green}/${verification.checks.total} ${escapeHtml(t('通过', 'green'))}${verification.checks.failing.length === 0 ? '' : ` · ${escapeHtml(t('失败', 'failing'))}: ${escapeHtml(verification.checks.failing.join(', '))}`}${verification.checks.pending.length === 0 ? '' : ` · ${escapeHtml(t('等待', 'pending'))}: ${escapeHtml(verification.checks.pending.join(', '))}`}</small></div></div>
          <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('测试证据', 'Test evidence'))}</strong><small>${escapeHtml(verification.testEvidence.state === 'verified' ? t('已核实', 'Verified') : verification.testEvidence.state === 'contradicted' ? t('与 checks 不一致', 'Contradicted by checks') : t('未核实', 'Unverified'))}${verification.testEvidence.greenChecks.length === 0 ? '' : ` · ${escapeHtml(t('通过', 'green'))}: ${escapeHtml(verification.testEvidence.greenChecks.join(', '))}`}${verification.testEvidence.failingChecks.length === 0 ? '' : ` · ${escapeHtml(t('失败', 'failing'))}: ${escapeHtml(verification.testEvidence.failingChecks.join(', '))}`}</small></div></div>
          <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('审核', 'Reviews'))}</strong><small>${escapeHtml(t(`批准 ${verification.reviews.approvals} 个`, `${verification.reviews.approvals} approval(s)`))}${verification.reviews.changesRequested ? ` · ${escapeHtml(t('有 changes requested', 'changes requested'))}` : ''}</small></div></div>
          <div class="list-row"><div class="list-main"><strong>${escapeHtml(t('PR 状态', 'PR state'))}</strong><small>${escapeHtml(verification.prState)} · ${escapeHtml(verification.mergeableState)} · ${escapeHtml(verification.combinedStatus)}</small></div></div>
        </div>`}
    ${pathGuard === null
      ? ''
      : `<h3 class="mt-16">${escapeHtml(t('路径守卫', 'Path guard'))}</h3>
        <p class="fine">${pathGuard.ok
          ? escapeHtml(t('改动文件都在允许范围内。', 'All changed files are within the allowed paths.'))
          : pathGuard.truncated === true
            ? escapeHtml(t(`已检查 ${formatCount(pathGuard.checkedFiles)} / 报告 ${formatCount(pathGuard.reportedFiles)} 个文件`, `Checked ${formatCount(pathGuard.checkedFiles)} / ${formatCount(pathGuard.reportedFiles)} reported files`))
            : escapeHtml(t(`${pathGuard.violations.length} 个文件违反路径约束。`, `${pathGuard.violations.length} file(s) violate the path constraints.`))}${pathGuard.allow.length === 0 && pathGuard.deny.length === 0 ? ` · ${escapeHtml(t('未设置约束', 'no constraints set'))}` : ''}</p>
        ${pathGuard.violations.length === 0 ? '' : `<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('文件', 'File'))}</th><th>${escapeHtml(t('原因', 'Reason'))}</th></tr></thead><tbody>${pathGuard.violations.map((violation) => `<tr><td><code>${escapeHtml(violation.file)}</code></td><td>${escapeHtml(violation.reason === 'denied' ? t('命中禁止路径', 'Denied path') : t('不在允许路径', 'Not allowed'))}</td></tr>`).join('')}</tbody></table></div>`}`}
    ${adversarial === null ? '' : `<h3 class="mt-16">${escapeHtml(t('独立对抗式审核', 'Independent adversarial review'))}</h3>
      <p class="fine" data-adversarial>${escapeHtml(adversarialText(adversarial))}${adversarial.model === null ? '' : ` · ${escapeHtml(t('模型', 'Model'))} ${escapeHtml(adversarial.model)}`}${adversarial.promptHash === null ? '' : ` · ${escapeHtml(t('提示哈希', 'Prompt hash'))} <code>${escapeHtml(adversarial.promptHash.slice(0, 12))}</code>`}</p>`}
  </section>`}
  <section class="card">
    <h2>${escapeHtml(t('时间线', 'Timeline'))}</h2>
    <p class="fine" data-trace-token="${escapeHtml(job.id)}">${escapeHtml(t('日志检索令牌', 'Log search token'))}: <code>${escapeHtml(job.id)}</code> — ${escapeHtml(t('这个任务的每条日志都用 trace 记着它；在日志里检索这个值，就能一次拿到整个任务的全部行。', 'every line this job writes carries it under trace; search the logs for it and the whole job comes back in one pass.'))}</p>
    ${events.length === 0
      ? renderState({ kind: 'empty', title: t('还没有任务事件。', 'No job events yet.'), body: t('任务开始后，每一次状态变化都会记录在这里。', 'Every state change is recorded here once the job starts.'), action: job.status === 'failed' ? { formAction: `/repos/${repo.id}/jobs/${job.id}/retry`, label: t('重试这个任务', 'Retry this job'), csrf: csrf(viewer) } : { href: `/repos/${repo.id}`, label: t('返回仓库', 'Back to repository') } })
      : `<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('时间', 'Time'))}</th><th>${escapeHtml(t('事件', 'Event'))}</th><th>${escapeHtml(t('角色/步骤', 'Role/step'))}</th><th>${escapeHtml(t('详情', 'Detail'))}</th></tr></thead><tbody>${events.map((entry) => `<tr><td>${escapeHtml(humanTimeShort(entry.at))}</td><td><code>${escapeHtml(entry.kind)}</code></td><td>${escapeHtml([entry.role, entry.step].filter((value) => value !== null && value !== '').join(' · ') || '—')}</td><td>${escapeHtml(jobEventDetail(t, entry))}</td></tr>`).join('')}</tbody></table></div>`}
  </section>
  ${advanced ? `<section class="card">
    <h2>${escapeHtml(t('团队参与', 'Team participation'))}</h2>
    ${teamRows}
  </section>` : ''}`
  return layout({ title: `${t('任务', 'Job')} ${job.id}`, viewer, body, config, locale, path: `/repos/${repo.id}/jobs/${job.id}`, active: 'dashboard', notice, error })
}

export function metricsPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  metrics: {
    users: number
    approved: number
    repos: number
    jobs: number
    succeeded: number
    failed: number
    usersWithJobs: number
    usersWithPr: number
    costUsd: number
    events: Array<{ name: string; n: number }>
  }
  team: { jobs: number; avgRoles: number; leadOnly: number; roles: Array<{ role: string; calls: number; jobs: number }> }
  workItems: { total: number; open: number; merged: number; closed: number }
  attribution: { unattributedCount: number; unattributedUsd: number; attributedUsd: number }
  stages: { scope: number; verify: number; iterate: number; review: number; leadOnly: number; grounded: number }
  delivery: {
    jobs: number
    succeeded: number
    failed: number
    successRate: number
    prs: number
    merged: number
    mergeRate: number
    changesRequested: number
    reviewAverage: number | null
    reviewCount: number
    medianJobMs: number | null
    medianMergeMs: number | null
    medianReviewMs: number | null
  }
  daily: Array<{ day: string; jobs: number; succeeded: number; failed: number; merged: number }>
  repoCosts: Array<{ repoId: string; label: string; costUsd: number; calls: number }>
  modelCosts: Array<{ model: string; costUsd: number; calls: number }>
  alerts: AlertView[]
  windowDays?: number
  failures: Array<{ kind: FailureKind; count: number }>
  since: string
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, metrics, team, workItems, attribution, stages, delivery, daily, repoCosts, modelCosts, alerts, failures, since, notice, error } = input
  const windowDays = input.windowDays ?? 30
  const t = translator(locale)
  const successRate = metrics.jobs === 0 ? null : Math.round((metrics.succeeded / metrics.jobs) * 1000) / 10
  const cost = quotaMoney(metrics.costUsd * config.quota.usdCny)
  const eventRows = metrics.events.length === 0
    ? stateCell(2, { kind: 'empty', title: t('还没有事件。', 'No events yet.'), body: t('任务开始后会记录每一次状态变化。', 'Every state change is recorded once the job starts.'), action: { href: '#', label: t('等第一个任务运行后回来看。', 'Come back after the first job runs.') } })
    : metrics.events.map((event) => `<tr><td><code>${escapeHtml(event.name)}</code></td><td>${event.n}</td></tr>`).join('')
  const body = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('产品指标', 'PRODUCT METRICS'))}</div>
        <h1>${escapeHtml(t('漏斗与留存', 'Funnel & retention'))}</h1>
        <p class="muted">${escapeHtml(t(`最近 ${windowDays} 天，从 ${since} 开始；只读，不会修改数据。`, `Last ${windowDays} days starting ${since}; read-only.`))}</p>
      </div>
      <div class="row">
        <a class="btn ${windowDays === 7 ? '' : 'btn-ghost'}" href="/admin/metrics?window=7">${escapeHtml(t('7 天', '7 days'))}</a>
        <a class="btn ${windowDays === 30 ? '' : 'btn-ghost'}" href="/admin/metrics?window=30">${escapeHtml(t('30 天', '30 days'))}</a>
        <a class="btn btn-ghost" href="/admin">${escapeHtml(t('返回管理', 'Back to admin'))}</a>
      </div>
    </div>
  </section>
  <section class="cols">
    <div class="card">
      <h2>${escapeHtml(t('漏斗', 'Funnel'))}</h2>
      <div class="list">
        <div class="list-row"><div class="list-main"><strong>${metrics.users}</strong><small>${escapeHtml(t('注册用户', 'Users'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${metrics.approved}</strong><small>${escapeHtml(t('已批准', 'Approved'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${metrics.repos}</strong><small>${escapeHtml(t('已接入仓库', 'Repositories'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${metrics.usersWithJobs}</strong><small>${escapeHtml(t('跑过任务的用户', 'Users with jobs'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${metrics.usersWithPr}</strong><small>${escapeHtml(t('产出过 PR 的用户', 'Users with a PR'))}</small></div></div>
      </div>
    </div>
    <div class="card">
      <h2>${escapeHtml(t('质量与成本', 'Quality & cost'))}</h2>
      <div class="list">
        <div class="list-row"><div class="list-main"><strong>${metrics.jobs}</strong><small>${escapeHtml(t('任务总数', 'Jobs'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${successRate === null ? '—' : `${successRate}%`}</strong><small>${escapeHtml(t('成功率', 'Success rate'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${metrics.failed}</strong><small>${escapeHtml(t('失败任务', 'Failed jobs'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${escapeHtml(cost)}</strong><small>${escapeHtml(t('窗口内任务成本', 'Job cost in window'))}</small></div></div>
      </div>
    </div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('团队参与', 'Team participation'))}</h2>
    <div class="list">
      <div class="list-row"><div class="list-main"><strong>${team.jobs}</strong><small>${escapeHtml(t('有统计的任务', 'Jobs with stats'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${team.avgRoles}</strong><small>${escapeHtml(t('平均参与角色数', 'Average roles per job'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${team.leadOnly}</strong><small>${escapeHtml(t('只有 Lead 干活的任务', 'Lead-only jobs'))}</small></div></div>
    </div>
    <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('角色', 'Role'))}</th><th>${escapeHtml(t('调用', 'Calls'))}</th><th>${escapeHtml(t('参与任务', 'Jobs'))}</th></tr></thead><tbody>${team.roles.length === 0 ? stateCell(3, { kind: 'empty', title: t('还没有团队统计。', 'No team stats yet.'), body: t('团队跑过一个任务后这里才有调用数。', 'Calls appear once the team has run a job.'), action: { href: '/dashboard#jobs', label: t('查看任务', 'View jobs') } }) : team.roles.map((entry) => `<tr><td>${escapeHtml(teamRoleLabel(t, entry.role))}</td><td>${entry.calls}</td><td>${entry.jobs}</td></tr>`).join('')}</tbody></table></div>
  </section>
  <section class="cols">
    <div class="card">
      <h2>${escapeHtml(t('交付效率', 'Delivery efficiency'))}</h2>
      <div class="list">
        <div class="list-row"><div class="list-main"><strong>${delivery.jobs === 0 ? '—' : `${delivery.successRate}%`}</strong><small>${escapeHtml(t(`成功率（${delivery.jobs} 个任务）`, `Success rate (${delivery.jobs} jobs)`))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${delivery.prs === 0 ? '—' : `${delivery.mergeRate}%`}</strong><small>${escapeHtml(t(`PR 合并率（${delivery.merged}/${delivery.prs}）`, `PR merge rate (${delivery.merged}/${delivery.prs})`))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${durationText(delivery.medianJobMs)}</strong><small>${escapeHtml(t('任务耗时中位数', 'Median job duration'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${durationText(delivery.medianMergeMs)}</strong><small>${escapeHtml(t('工作项创建到合并', 'Work item created to merged'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${durationText(delivery.medianReviewMs)}</strong><small>${escapeHtml(t('审核耗时中位数', 'Median review duration'))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${delivery.reviewAverage === null ? '—' : delivery.reviewAverage}</strong><small>${escapeHtml(t(`平均审核分（${delivery.reviewCount} 次）`, `Average review score (${delivery.reviewCount})`))}</small></div></div>
        <div class="list-row"><div class="list-main"><strong>${delivery.changesRequested}</strong><small>${escapeHtml(t('被要求修改', 'Changes requested'))}</small></div></div>
      </div>
    </div>
    <div class="card">
      <h2>${escapeHtml(t('告警', 'Alerts'))}</h2>
      ${alerts.length === 0
        ? `<p class="muted">${escapeHtml(t('当前没有需要处理的告警。', 'No alerts need attention.'))}</p>`
        : `<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('级别', 'Level'))}</th><th>${escapeHtml(t('类型', 'Kind'))}</th><th>${escapeHtml(t('详情', 'Detail'))}</th><th></th></tr></thead><tbody>${alertRows(t, alerts)}</tbody></table></div>`}
    </div>
  </section>
  <section class="cols">
    <div class="card">
      <h2>${escapeHtml(t('仓库成本', 'Cost by repository'))}</h2>
      <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('仓库', 'Repository'))}</th><th>${escapeHtml(t('调用', 'Calls'))}</th><th>${escapeHtml(t('成本', 'Cost'))}</th></tr></thead><tbody>${repoCosts.length === 0 ? stateCell(3, { kind: 'empty', title: t('还没有仓库成本数据。', 'No repository cost data yet.'), body: t('窗口内没有产生计费调用。', 'No billed calls in this window.'), action: { href: '/dashboard', label: t('回到仓库', 'Back to repositories') } }) : repoCosts.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.calls}</td><td>${escapeHtml(quotaMoney(row.costUsd * config.quota.usdCny))}</td></tr>`).join('')}</tbody></table></div>
    </div>
    <div class="card">
      <h2>${escapeHtml(t('模型成本', 'Cost by model'))}</h2>
      <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('模型', 'Model'))}</th><th>${escapeHtml(t('调用', 'Calls'))}</th><th>${escapeHtml(t('成本', 'Cost'))}</th></tr></thead><tbody>${modelCosts.length === 0 ? stateCell(3, { kind: 'empty', title: t('还没有模型成本数据。', 'No model cost data yet.'), body: t('窗口内没有模型调用。', 'No model calls in this window.'), action: { href: '/settings', label: t('检查模型配置', 'Check the model setup') } }) : modelCosts.map((row) => `<tr><td><code>${escapeHtml(row.model)}</code></td><td>${row.calls}</td><td>${escapeHtml(quotaMoney(row.costUsd * config.quota.usdCny))}</td></tr>`).join('')}</tbody></table></div>
    </div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('每日趋势', 'Daily trend'))}</h2>
    <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('日期', 'Day'))}</th><th>${escapeHtml(t('任务', 'Jobs'))}</th><th>${escapeHtml(t('成功', 'Succeeded'))}</th><th>${escapeHtml(t('失败', 'Failed'))}</th><th>${escapeHtml(t('已合并 PR', 'Merged PRs'))}</th></tr></thead><tbody>${daily.length === 0 ? stateCell(5, { kind: 'empty', title: t('还没有每日数据。', 'No daily data yet.'), body: t('窗口内没有任务。', 'No jobs in this window.'), action: { href: '/dashboard#jobs', label: t('查看任务', 'View jobs') } }) : daily.map((row) => `<tr><td>${escapeHtml(row.day)}</td><td>${row.jobs}</td><td>${row.succeeded}</td><td>${row.failed}</td><td>${row.merged}</td></tr>`).join('')}</tbody></table></div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('失败分类', 'Failure breakdown'))}</h2>
    ${failures.length === 0
      ? `<p class="muted">${escapeHtml(t('这个窗口没有失败任务。', 'No failed jobs in this window.'))}</p>`
      : `<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('类型', 'Kind'))}</th><th>${escapeHtml(t('次数', 'Count'))}</th></tr></thead><tbody>${failures.map((row) => `<tr><td>${escapeHtml(failureLabel(t, row.kind))}</td><td>${row.count}</td></tr>`).join('')}</tbody></table></div>`}
  </section>
  <section class="card">
    <h2>${escapeHtml(t('工作项结果', 'Work item outcomes'))}</h2>
    <div class="list">
      <div class="list-row"><div class="list-main"><strong>${workItems.total}</strong><small>${escapeHtml(t('工作项总数', 'Work items'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${workItems.open}</strong><small>${escapeHtml(t('仍在进行', 'Still open'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${workItems.merged}</strong><small>${escapeHtml(t('已合并', 'Merged'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${workItems.closed}</strong><small>${escapeHtml(t('已关闭未合并', 'Closed unmerged'))}</small></div></div>
    </div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('归因与阶段', 'Attribution & stages'))}</h2>
    <div class="list">
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(quotaMoney(attribution.unattributedUsd * config.quota.usdCny))}</strong><small>${escapeHtml(t(`未归因成本（${attribution.unattributedCount} 行）`, `Unattributed cost (${attribution.unattributedCount} rows)`))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${escapeHtml(quotaMoney(attribution.attributedUsd * config.quota.usdCny))}</strong><small>${escapeHtml(t('已归因成本', 'Attributed cost'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${stages.scope} / ${stages.verify} / ${stages.iterate} / ${stages.review}</strong><small>${escapeHtml(t('Scope / Verify / Iterate / Review 任务', 'Scope / Verify / Iterate / Review jobs'))}</small></div></div>
      <div class="list-row"><div class="list-main"><strong>${stages.leadOnly} / ${stages.grounded}</strong><small>${escapeHtml(t('Lead-only / 已落地归因事件', 'Lead-only / grounded attribution events'))}</small></div></div>
    </div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('事件', 'Events'))}</h2>
    <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('事件', 'Event'))}</th><th>${escapeHtml(t('次数', 'Count'))}</th></tr></thead><tbody>${eventRows}</tbody></table></div>
  </section>`
  return layout({ title: t('产品指标', 'Product metrics'), viewer, body, config, locale, path: '/admin/metrics', active: 'admin', notice, error })
}

export function appReposPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  installations: Array<{ installation_id: number; account_login: string; account_type: string }>
  installationId?: number
  repos?: InstallationRepo[]
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, installations, installationId, repos, notice, error } = input
  const t = translator(locale)
  const installUrl = config.githubApp.slug === '' ? '' : `https://github.com/apps/${encodeURIComponent(config.githubApp.slug)}/installations/new`
  const installationList = installations.length === 0
    ? `<p class="muted">${escapeHtml(t('还没有安装 GitHub App。安装并选择仓库后，可以直接在这里接入。', 'The GitHub App is not installed yet. Install it, choose repositories, then connect them here.'))}</p>`
    : `<div class="list">${installations.map((installation) => `<div class="list-row"><div class="list-main"><strong>@${escapeHtml(installation.account_login)}</strong><small>${escapeHtml(installation.account_type)} · installation ${installation.installation_id}</small></div><a class="link" href="/repos/new?installation=${installation.installation_id}">${escapeHtml(t('选择仓库', 'Choose repositories'))}</a></div>`).join('')}</div>`
  const commonFields = `
    <div class="card"><h3>${escapeHtml(t('仓库设置', 'Repository settings'))}</h3>
      ${goalTemplateSelect(t, 'goal-app')}
      <label>${escapeHtml(t('迭代目标（可选）', 'Iteration goal (optional)'))}${infoTip(t('目标越具体，产出越稳定。模板会填入一个可执行的目标。', 'The more concrete the goal, the more stable the output. A template fills in a ready prompt.'))} <textarea id="goal-app" name="goal" rows="3" placeholder="${escapeHtml(t('例如：持续修复 issue 里的可复现 bug，只改最小范围。', 'For example: fix reproducible bugs from issues with the smallest safe change.'))}"></textarea></label>
      <div class="row">
        <label class="check"><input type="checkbox" name="auto" value="1" /> ${escapeHtml(t('自动迭代', 'Auto-iterate'))}</label>
        <label>${escapeHtml(t('发现间隔', 'Discovery interval'))}${infoTip(t('没有工作项时按这个间隔做一次发现（最少 60 分钟）；最多提出一个具体 issue，不会直接开 PR。有工作项时按全局最短工作间隔推进。', 'With no work this interval runs one discovery session (minimum 60 minutes) that may open at most one concrete issue, never a PR. Open work uses the global short work cooldown.'))} <select name="interval">${intervalOptions(t, 1440, DISCOVERY_INTERVALS)}</select></label>
      </div>
      <div class="row">
        <label class="check"><input type="checkbox" name="review" value="1" /> ${escapeHtml(t('启用 PR 审核角色', 'Enable PR reviewer role'))}${infoTip(t('只有 maintainer 角色且 GitHub admin/maintain 权限时才可启用。', 'Available only with the maintainer role and GitHub admin/maintain permission.'))}</label>
        <label>${escapeHtml(t('审核间隔', 'Review interval'))} <select name="reviewInterval">${reviewIntervalOptions(t)}</select></label>
      </div>
      <p class="fine">${escapeHtml(t('添加后请为每个仓库选择 maintainer 或 developer；角色来自你的 GitHub 权限，Fledge 不会自动选择。', 'After adding, choose maintainer or developer for each repository. The role comes from your GitHub permission; Fledge will not choose it for you.'))}</p>
    </div>`
  const repoRows = (repos ?? []).map((repo) => `<tr>
    <td><label class="check"><input type="checkbox" name="repo" value="${escapeHtml(repo.fullName)}" /> <strong>${escapeHtml(repo.fullName)}</strong></label></td>
    <td>${repo.private ? escapeHtml(t('私有', 'Private')) : escapeHtml(t('公开', 'Public'))}</td>
    <td><code>${escapeHtml(repo.defaultBranch)}</code></td>
  </tr>`).join('')
  const picker = installationId === undefined
    ? ''
    : `<section class="card">
        <h2>${escapeHtml(t('选择要接入的仓库', 'Choose repositories'))}</h2>
        ${repoRows === '' ? `<p class="muted">${escapeHtml(t('这个安装没有可访问的仓库。', 'This installation has no accessible repositories.'))}</p>` : `<form method="post" action="/repos/app" class="form">${csrf(viewer)}<input type="hidden" name="installation" value="${installationId}" /><div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('仓库', 'Repository'))}</th><th>${escapeHtml(t('可见性', 'Visibility'))}</th><th>${escapeHtml(t('默认分支', 'Default branch'))}</th></tr></thead><tbody>${repoRows}</tbody></table></div>${commonFields}<button class="btn" type="submit">${escapeHtml(t('接入选中的仓库', 'Connect selected repositories'))}</button></form>`}
      </section>`
  const body = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('GITHUB APP', 'GITHUB APP'))}</div>
        <h1>${escapeHtml(t('通过 GitHub App 接入', 'Connect with GitHub App'))}</h1>
        <p class="muted">${escapeHtml(t('安装 App、选择仓库后，Fledge 使用短时 installation token，不需要你创建 PAT。', 'After installing the App and choosing repositories, Fledge uses short-lived installation tokens instead of a PAT.'))}</p>
      </div>
      <a class="btn btn-ghost" href="/dashboard">${escapeHtml(t('返回工作区', 'Back to dashboard'))}</a>
    </div>
  </section>
  <section class="card">
    <h2>${escapeHtml(t('已安装', 'Installed'))}</h2>
    ${installationList}
    ${installUrl === '' ? '' : `<p><a class="btn" href="${escapeHtml(installUrl)}" target="_blank" rel="noreferrer">${escapeHtml(t('安装 / 调整 GitHub App', 'Install / manage GitHub App'))}</a></p>`}
  </section>
  ${picker}`
  return layout({ title: t('GitHub App 接入', 'GitHub App'), viewer, body, config, locale, path: '/repos/new', active: 'dashboard', notice, error })
}

export function agentWorkspacePage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repo: RepoRow
  instance?: RepoInstanceRow
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repo, instance, notice, error } = input
  const t = translator(locale)
  const advanced = advancedViewer(viewer)
  const ready = instance?.status === 'ready'
  const body = `<section class="card">
    <div class="row between">
      <div>
        <div class="eyebrow">${escapeHtml(t('工作区', 'WORKSPACE'))}</div>
        <h1>${escapeHtml(repo.upstream_owner || repo.owner)}/${escapeHtml(repo.upstream_name || repo.name)}</h1>
        <p class="muted">${instance === undefined ? escapeHtml(t('实例未创建', 'Instance not created')) : `${badge(t, instance.status)} · ${escapeHtml(instance.container)}`} · <a href="/repos/${escapeHtml(repo.id)}">${escapeHtml(t('返回仓库', 'Back to repository'))}</a>${advanced ? ` · <a href="/repos/${escapeHtml(repo.id)}/team">${escapeHtml(t('团队工作台', 'Team console'))}</a>` : ''}</p>
      </div>
      <div class="row workspace-toolbar">
        ${ready ? `<a class="btn btn-ghost" href="/repos/${escapeHtml(repo.id)}/workspace/app/" target="_blank" rel="noreferrer">${escapeHtml(t('新窗口打开', 'Open in new window'))}</a>` : ''}
        <button class="btn btn-ghost" type="button" data-reload>${escapeHtml(t('刷新', 'Refresh'))}</button>
        ${ready && advanced ? `<form method="post" action="/repos/${escapeHtml(repo.id)}/team/stop">${csrf(viewer)}<input type="hidden" name="returnTo" value="/repos/${escapeHtml(repo.id)}/workspace" /><button class="btn btn-ghost" type="submit">${escapeHtml(t('请求暂停', 'Request stop'))}</button></form>` : ''}
      </div>
    </div>
  </section>
  ${ready
    ? `<section class="card">
        <p class="fine">${escapeHtml(t('这是你的仓库工作区。Fledge 负责认证、隔离和审计；底层界面由 FlyBot 提供。', 'This is your repository workspace. Fledge handles auth, isolation and audit; the underlying UI is provided by FlyBot.'))}</p>
        <iframe class="workspace-frame" src="/repos/${escapeHtml(repo.id)}/workspace/app/" title="${escapeHtml(t('Fledge 工作区', 'Fledge workspace'))}" allow="clipboard-read; clipboard-write"></iframe>
      </section>`
    : `<section class="card"><p class="muted">${escapeHtml(t('实例就绪后才能打开工作区。', 'The workspace opens after the instance is ready.'))}</p></section>`}
  <p class="fine text-right">Fledge · powered by FlyBot</p>`
  return layout({ title: `${t('工作区', 'Workspace')} · ${repo.upstream_name || repo.name}`, viewer, body, config, locale, path: `/repos/${repo.id}/workspace`, active: 'dashboard', notice, error })
}

// #279: read-only. An operator can see who is approaching expiry, who is exempt
// and who the sweep revoked, without an email address on screen and without a
// control that could mail or change a status - #265 owns both.
export function adminTrialsPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  rows: TrialCandidateSource[]
  filter: TrialFilter
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, rows, filter, notice, error } = input
  const t = translator(locale)
  const now = Date.now()
  const views = rows.map((row) => trialStateOf(row, now))
  const counts = trialCounts(views)
  const visible = filterTrials(views, filter)
  const filterLabels: Array<[TrialFilter, string, string]> = [
    ['all', '全部', 'All'],
    ['eligible', '可到期', 'For expiry'],
    ['expiring', '即将到期', 'Expiring soon'],
    ['expired', '已过期', 'Expired'],
  ]
  const stateLabel = (state: string): string => {
    switch (state) {
      case 'eligible': return t('可到期', 'For expiry')
      case 'expiring': return t('即将到期', 'Expiring soon')
      case 'expired': return t('已过期', 'Expired')
      case 'exempt_used': return t('豁免：已用', 'Exempt: used')
      case 'exempt_admin': return t('豁免：管理员', 'Exempt: admin')
      case 'inactive': return t('不适用', 'Not in flight')
      default: return t('试用中', 'Running')
    }
  }
  const stateBadge = (state: string): string => {
    if (state === 'eligible') return `<span class="badge busy">${escapeHtml(stateLabel(state))}</span>`
    if (state === 'expiring') return `<span class="badge busy">${escapeHtml(stateLabel(state))}</span>`
    if (state === 'expired') return `<span class="badge bad">${escapeHtml(stateLabel(state))}</span>`
    if (state === 'exempt_used' || state === 'exempt_admin') return `<span class="badge good">${escapeHtml(stateLabel(state))}</span>`
    return `<span class="badge">${escapeHtml(stateLabel(state))}</span>`
  }
  const rowsHtml = visible.length === 0
    ? stateCell(8, { kind: 'empty', title: t('这个筛选下没有用户。', 'No users in this filter.'), body: t('换一个筛选，或查看全部。', 'Switch the filter, or view all.'), action: { href: '/admin/trials', label: t('查看全部', 'View all') } })
    : visible
        .map(
          (row) => `<tr data-trial-user="${escapeHtml(row.id)}">
            <td><a href="/admin/users/${escapeHtml(row.id)}">@${escapeHtml(row.login)}</a></td>
            <td><small class="muted">${escapeHtml(humanTimeShort(row.registeredAt))}</small></td>
            <td>${row.days}</td>
            <td><small class="muted">${escapeHtml(humanTimeShort(row.lastLoginAt))}</small></td>
            <td>${badge(t, row.status)}</td>
            <td>${row.repos === 0 ? '0' : row.repos}</td>
            <td>${stateBadge(row.state)}</td>
            <td><small class="muted">${row.expiredAt === null ? '—' : escapeHtml(humanTimeShort(row.expiredAt))}</small></td>
          </tr>`,
        )
        .join('')
  const filters = filterLabels
    .map(([value, zh, en]) => `<a class="btn ${filter === value ? '' : 'btn-ghost'}" href="/admin/trials?trial=${value}">${escapeHtml(t(zh, en))} <span class="fine">${counts[value]}</span></a>`)
    .join(' ')
  const body = `<section class="workspace-hero">
    <div class="workspace-intro">
      <div class="eyebrow">${escapeHtml(t('预览试用', 'PREVIEW TRIALS'))}</div>
      <h1>${escapeHtml(t('预览试用', 'Preview trials'))}</h1>
      <p class="muted">${escapeHtml(t('只读：显示注册天数、是否已用、豁免和到期。发信和停用由 #265 的清扫负责。', 'Read-only: registration age, use, exemptions and expiry. The sweep in #265 owns mail and revoking.'))}</p>
    </div>
    <div class="workspace-actions"><a class="btn btn-ghost" href="/admin">${escapeHtml(t('返回管理', 'Back to admin'))}</a></div>
  </section>
  <div class="row mb-12">${filters}</div>
  <section class="card">
    <div class="row between"><h2>${escapeHtml(t('试用概览', 'Trial overview'))}</h2><span class="fine">${escapeHtml(t(`共 ${counts.all} 个账号；第 ${TRIAL_DAYS - 2} 天起提醒。`, `${counts.all} accounts; reminders start on day ${TRIAL_DAYS - 2}.`))}</span></div>
    <div class="table-scroll"><table><thead><tr>
      <th>${escapeHtml(t('用户', 'User'))}</th>
      <th>${escapeHtml(t('注册', 'Registered'))}</th>
      <th>${escapeHtml(t('天数', 'Days'))}</th>
      <th>${escapeHtml(t('最近登录', 'Last sign-in'))}</th>
      <th>${escapeHtml(t('状态', 'Status'))}</th>
      <th>${escapeHtml(t('仓库', 'Repos'))}</th>
      <th>${escapeHtml(t('判定', 'Verdict'))}</th>
      <th>${escapeHtml(t('试用到期审计', 'Trial expired at'))}</th>
    </tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <p class="fine">${escapeHtml(t('用户列只显示登录名；账号操作在支持视图里。', 'The user column shows the login only; account actions live in the support view.'))}</p>
  </section>`
  return layout({ title: t('预览试用', 'Preview trials'), viewer, body, config, locale, path: '/admin/trials', active: 'admin', notice, error })
}

export function adminDeploymentsPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  release: ReleaseSnapshot | null
  environments: Array<{ environment: string; latest: DeploymentRow | null; current: EnvironmentCurrent; drift: DriftAssessment }>
  deployments: DeploymentRow[]
  rollbacks: DeploymentRollbackRow[]
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, release, environments, deployments, rollbacks, notice, error } = input
  const t = translator(locale)
  const stateBadge = (state: string): string => {
    if (state === 'ok') return `<span class="badge good">${escapeHtml(t('正常', 'ok'))}</span>`
    if (state === 'behind') return `<span class="badge bad">${escapeHtml(t('落后', 'behind'))}</span>`
    if (state === 'mismatch') return `<span class="badge bad">${escapeHtml(t('不一致', 'mismatch'))}</span>`
    return `<span class="badge busy">${escapeHtml(t('未知', 'unknown'))}</span>`
  }
  const external = (url: string | null | undefined, label: string): string => {
    const value = String(url ?? '')
    if (!/^https?:\/\//.test(value)) return escapeHtml('—')
    return `<a class="link" href="${escapeHtml(value)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`
  }
  const commit = (sha: string): string => escapeHtml(sha.slice(0, 12))
  const alerts = environments.filter((entry) => entry.drift.alert)
  const alertBanner = alerts.length === 0
    ? ''
    : `<div class="banner bad" role="alert"><strong>${escapeHtml(t('部署漂移', 'Deployment drift'))}</strong><ul>${alerts.map((entry) => `<li><b>${escapeHtml(entry.environment)}</b> · ${escapeHtml(entry.drift.summary)}</li>`).join('')}</ul></div>`
  const releaseLine = release === null
    ? `<p class="muted">${escapeHtml(t('这台实例还没有发布链快照，因此漂移只能按已记录的部署判断。', 'No release snapshot is recorded on this instance, so drift cannot name a released version.'))}</p>`
    : `<p class="muted">${escapeHtml(t('最新发布', 'Latest release'))}: <b>v${escapeHtml(String(release.version ?? ''))}</b>${String(release.commit ?? '') === '' ? '' : ` · ${escapeHtml(t('标签提交', 'tag commit'))} <code>${commit(String(release.commit ?? ''))}</code>`}${String(release.url ?? '') === '' ? '' : ` · ${external(release.url, t('GitHub Release', 'GitHub Release'))}`}</p>`
  const environmentRows = environments.length === 0
    ? stateCell(4, { kind: 'empty', title: t('还没有部署记录。', 'No deployment is recorded.'), body: t('在下方记录一次通过 canary 的部署后，漂移视图会开始比较。', 'Record a deployment after its canary gate passes; drift compares from then on.'), action: { href: '/admin', label: t('返回管理', 'Back to admin') } })
    : environments.map((entry) => {
        const row = entry.latest
        const current = entry.current
        const healthzBadge = current.healthz === null
          ? escapeHtml('—')
          : `<span class="badge ${current.healthz ? 'good' : 'bad'}">/healthz ${current.healthz ? 'ok' : 'fail'}</span>`
        const readyzBadge = current.readyz === null
          ? ''
          : `<br /><span class="badge ${current.readyz ? 'good' : 'bad'}">/readyz ${current.readyz ? 'ok' : 'fail'}</span>`
        return `<tr data-deployment-source="${escapeHtml(current.source)}">
          <td data-label="${escapeHtml(t('环境', 'Environment'))}"><strong>${escapeHtml(entry.environment)}</strong><br /><small class="muted">${escapeHtml(entry.drift.summary)}</small></td>
          <td data-label="${escapeHtml(t('版本', 'Version'))}">${current.source === 'none' ? escapeHtml('—') : `${current.version === null ? escapeHtml(t('未知版本', 'version unknown')) : `v${escapeHtml(current.version)}`}<br /><code>${commit(current.commit)}</code>${current.source === 'rollback' ? `<br /><small class="muted">${escapeHtml(t('回滚后', 'after a rollback'))}</small>` : ''}`}</td>
          <td data-label="${escapeHtml(t('镜像', 'Image'))}">${current.source === 'none' ? escapeHtml('—') : `<code>${escapeHtml(current.digest)}</code>`}</td>
          <td data-label="${escapeHtml(t('记录', 'Recorded'))}">${current.source === 'none' ? escapeHtml('—') : `${escapeHtml(humanTimeShort(current.recordedAt))}<br /><small class="muted">@${escapeHtml(current.operator)}</small>`}</td>
          <td data-label="${escapeHtml(t('健康', 'Health'))}">${healthzBadge}${readyzBadge}</td>
          <td data-label="${escapeHtml(t('漂移', 'Drift'))}">${stateBadge(entry.drift.state)}</td>
          <td data-label="${escapeHtml(t('发布', 'Release'))}">${row === null ? escapeHtml('—') : external(row.release_url, t('发布链接', 'release'))}</td>
        </tr>`
      }).join('')
  const deploymentRows = deployments.length === 0
    ? stateCell(7, { kind: 'empty', title: t('没有部署记录。', 'No deployment records.'), body: t('一条记录包含版本、提交、镜像摘要、时间和操作者。', 'A record carries the version, commit, image digest, time and operator.'), action: { href: '/admin', label: t('返回管理', 'Back to admin') } })
    : deployments.map((row) => `<tr>
        <td>${escapeHtml(humanTimeShort(row.created_at))}</td>
        <td>${escapeHtml(row.environment)}</td>
        <td>v${escapeHtml(row.version)}<br /><code>${commit(row.commit_sha)}</code></td>
        <td><code>${escapeHtml(row.image_digest)}</code></td>
        <td>@${escapeHtml(row.operator)}</td>
        <td><span class="badge ${row.healthz_ok === 1 ? 'good' : 'bad'}">/healthz</span> <span class="badge ${row.readyz_ok === 1 ? 'good' : 'bad'}">/readyz</span></td>
        <td>${external(row.release_url, t('链接', 'link'))}</td>
      </tr>`).join('')
  const rollbackRows = rollbacks.length === 0
    ? stateCell(6, { kind: 'empty', title: t('没有回滚记录。', 'No rollback records.'), body: t('回滚计划记录之前的摘要、提交、负责人和命令；Fledge 不会执行它。', 'A rollback plan records the previous digest, commit, owner and command; Fledge never runs it.'), action: { href: '/admin', label: t('返回管理', 'Back to admin') } })
    : rollbacks.map((row) => `<tr>
        <td>${escapeHtml(humanTimeShort(row.created_at))}</td>
        <td>${escapeHtml(row.environment)}<br /><small class="muted">${escapeHtml(row.decision)}</small></td>
        <td><code>${escapeHtml(row.previous_digest)}</code><br /><code>${commit(row.previous_commit)}</code></td>
        <td>@${escapeHtml(row.owner)}</td>
        <td><code>${escapeHtml(redactCommand(row.command))}</code></td>
        <td><span class="badge ${row.verified === 1 ? 'good' : 'busy'}">${escapeHtml(row.verified === 1 ? t('/healthz 已验证', '/healthz verified') : t('待验证', 'unverified'))}</span></td>
      </tr>`).join('')
  const body = `<a class="back" href="/admin">← ${escapeHtml(t('返回管理', 'Back to admin'))}</a>
    ${alertBanner}
    <section class="card">
      <div class="eyebrow">${escapeHtml(t('部署', 'DEPLOYMENTS'))}</div>
      <h1>${escapeHtml(t('部署与漂移', 'Deployments and drift'))}</h1>
      <p class="muted">${escapeHtml(t('只读记录：Fledge 比较已记录的部署与发布标签，记录 canary 结果和回滚决定，但从不执行主机部署、回滚或 SSH。', 'Records only: Fledge compares recorded deployments with the released tag and records canary results and rollback decisions, but never runs a host deploy, rollback or SSH.'))}</p>
      ${releaseLine}
    </section>
    <section class="card">
      <h2>${escapeHtml(t('环境', 'Environments'))}</h2>
      <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('环境', 'Environment'))}</th><th>${escapeHtml(t('版本', 'Version'))}</th><th>${escapeHtml(t('镜像', 'Image'))}</th><th>${escapeHtml(t('记录', 'Recorded'))}</th><th>${escapeHtml(t('健康', 'Health'))}</th><th>${escapeHtml(t('漂移', 'Drift'))}</th><th>${escapeHtml(t('发布', 'Release'))}</th></tr></thead><tbody>${environmentRows}</tbody></table></div>
    </section>
    <section class="card">
      <h2>${escapeHtml(t('记录一次通过 canary 的部署', 'Record a deployment after the canary gate'))}</h2>
      <p class="muted">${escapeHtml(t('所有项都必须通过；缺一项就阻止写入部署记录。两个窗口都填上限，只填数字无法判定，同样阻止写入。', 'Every canary item must pass; a missing item blocks the deployment record. Both windows need the limit they are judged against: a number with no limit cannot be judged and blocks it too.'))}</p>
      <form method="post" action="/admin/deployments/promote" class="form">
        ${csrf(viewer)}
        <div class="row">
          <label>${escapeHtml(t('环境', 'Environment'))} <input name="environment" value="production" required pattern="[a-z0-9][a-z0-9-]{0,31}" /></label>
          <label>${escapeHtml(t('版本', 'Version'))} <input name="version" placeholder="0.3.2" required /></label>
          <label>${escapeHtml(t('提交', 'Commit'))} <input name="commit" placeholder="40-hex sha" required /></label>
          <label>${escapeHtml(t('镜像摘要', 'Image digest'))} <input name="image_digest" placeholder="sha256:..." required /></label>
        </div>
        <div class="row">
          <label>${escapeHtml(t('部署时间', 'Deployed at'))} <input name="deployed_at" placeholder="2026-11-13T10:00:00Z" required /></label>
          <label>${escapeHtml(t('操作者', 'Operator'))} <input name="operator" value="${escapeHtml(viewer.user.login)}" required /></label>
          <label>${escapeHtml(t('发布链接', 'Release URL'))} <input name="release_url" placeholder="https://github.com/.../releases/tag/v0.3.2" /></label>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" name="healthz_ok" value="1" /> /healthz</label>
          <label>${escapeHtml(t('状态码', 'Status'))} <input name="healthz_status" value="200" /></label>
          <label>${escapeHtml(t('健康版本', 'Health version'))} <input name="healthz_version" placeholder="0.3.2" /></label>
          <label>${escapeHtml(t('健康提交', 'Health commit'))} <input name="healthz_commit" placeholder="sha" /></label>
          <label class="check"><input type="checkbox" name="readyz_ok" value="1" /> /readyz</label>
          <label>${escapeHtml(t('状态码', 'Status'))} <input name="readyz_status" value="200" /></label>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" name="smoke_ok" value="1" /> ${escapeHtml(t('冒烟任务', 'Smoke job'))}</label>
          <label>${escapeHtml(t('任务 ID', 'Job ID'))} <input name="smoke_job" placeholder="job_..." /></label>
          <label class="check"><input type="checkbox" name="error_ok" value="1" /> ${escapeHtml(t('错误窗口', 'Error window'))}</label>
          <label>${escapeHtml(t('分钟', 'Minutes'))} <input name="error_window_minutes" placeholder="30" /></label>
          <label>${escapeHtml(t('错误数', 'Errors'))} <input name="error_count" placeholder="0" /></label>
          <label>${escapeHtml(t('错误上限', 'Error limit'))} <input name="error_threshold" placeholder="5" /></label>
        </div>
        <div class="row">
          <label class="check"><input type="checkbox" name="latency_ok" value="1" /> ${escapeHtml(t('延迟窗口', 'Latency window'))}</label>
          <label>${escapeHtml(t('分钟', 'Minutes'))} <input name="latency_window_minutes" placeholder="30" /></label>
          <label>${escapeHtml(t('p95 毫秒', 'p95 ms'))} <input name="latency_p95_ms" placeholder="120" /></label>
          <label>${escapeHtml(t('p95 上限（毫秒）', 'p95 limit (ms)'))} <input name="latency_threshold_ms" placeholder="300" /></label>
          <button class="btn" type="submit">${escapeHtml(t('记录部署', 'Record deployment'))}</button>
        </div>
      </form>
    </section>
    <section class="card">
      <h2>${escapeHtml(t('最近部署', 'Recent deployments'))}</h2>
      <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('记录时间', 'Recorded'))}</th><th>${escapeHtml(t('环境', 'Environment'))}</th><th>${escapeHtml(t('版本 / 提交', 'Version / commit'))}</th><th>${escapeHtml(t('镜像', 'Image'))}</th><th>${escapeHtml(t('操作者', 'Operator'))}</th><th>${escapeHtml(t('健康', 'Health'))}</th><th>${escapeHtml(t('发布', 'Release'))}</th></tr></thead><tbody>${deploymentRows}</tbody></table></div>
    </section>
    <section class="card">
      <h2>${escapeHtml(t('记录回滚计划', 'Record a rollback plan'))}</h2>
      <p class="muted">${escapeHtml(t('计划必须命名已记录的上一份摘要和提交、负责人和命令。Fledge 只记录决定并核对 /healthz；命令由主机负责人执行，页面不运行它，也不暴露主机路径或令牌。', 'The plan must name a recorded previous digest and commit, an owner and a command. Fledge records the decision and checks /healthz; the host owner runs the command, and this page never runs it or exposes host paths or tokens.'))}</p>
      <form method="post" action="/admin/deployments/rollback" class="form">
        ${csrf(viewer)}
        <div class="row">
          <label>${escapeHtml(t('环境', 'Environment'))} <input name="environment" value="production" required pattern="[a-z0-9][a-z0-9-]{0,31}" /></label>
          <label>${escapeHtml(t('上一份摘要', 'Previous digest'))} <input name="previous_digest" placeholder="sha256:..." required /></label>
          <label>${escapeHtml(t('上一份提交', 'Previous commit'))} <input name="previous_commit" placeholder="sha" required /></label>
          <label>${escapeHtml(t('负责人', 'Owner'))} <input name="owner" value="${escapeHtml(viewer.user.login)}" required /></label>
        </div>
        <div class="row">
          <label>${escapeHtml(t('决定', 'Decision'))} <input name="decision" value="rollback" /></label>
          <label>${escapeHtml(t('命令', 'Command'))} <input name="command" placeholder="docker pull ghcr.io/...@sha256:..." required /></label>
          <label class="check"><input type="checkbox" name="healthz_ok" value="1" /> ${escapeHtml(t('/healthz 已验证', '/healthz verified'))}</label>
          <label>${escapeHtml(t('状态码', 'Status'))} <input name="healthz_status" value="200" /></label>
          <label>${escapeHtml(t('健康提交', 'Health commit'))} <input name="healthz_commit" placeholder="sha" /></label>
          <button class="btn" type="submit">${escapeHtml(t('记录决定', 'Record decision'))}</button>
        </div>
      </form>
      <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('记录时间', 'Recorded'))}</th><th>${escapeHtml(t('环境 / 决定', 'Environment / decision'))}</th><th>${escapeHtml(t('上一份摘要 / 提交', 'Previous digest / commit'))}</th><th>${escapeHtml(t('负责人', 'Owner'))}</th><th>${escapeHtml(t('命令', 'Command'))}</th><th>${escapeHtml(t('核对', 'Check'))}</th></tr></thead><tbody>${rollbackRows}</tbody></table></div>
    </section>`
  return layout({ title: t('部署与漂移', 'Deployments and drift'), viewer, body, config, locale, path: '/admin/deployments', active: 'admin', notice, error })
}

export function adminWebhooksPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  deliveries: Array<{ delivery_id: string; event: string; action: string | null; received_at: string; processed_at: string | null; status: string; error: string | null; repository_full_name: string | null }>
  filters: { status: string; event: string }
  page: number
  pages: number
  total: number
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, deliveries, filters, page, pages, total, notice, error } = input
  const t = translator(locale)
  const query = (extra: Record<string, string | number>): string => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries({ ...filters, ...extra })) if (String(value) !== '') params.set(key, String(value))
    return params.toString()
  }
  const statusBadge = (status: string): string => {
    const cls = status === 'processed' ? 'good' : status === 'failed' ? 'bad' : 'busy'
    return `<span class="badge ${cls}">${escapeHtml(deliveryStatusLabel(t, status))}</span>`
  }
  const rows = deliveries.length === 0
    ? stateCell(6, { kind: 'empty', title: t('没有 webhook delivery。', 'No webhook deliveries.'), body: t('GitHub 推送事件后会出现在这里。', 'GitHub events appear here after delivery.'), action: { href: '/admin', label: t('返回管理', 'Back to admin') } })
    : deliveries.map((delivery) => `<tr>
        <td>${escapeHtml(humanTimeShort(delivery.received_at))}</td>
        <td><code>${escapeHtml(delivery.event)}</code>${delivery.action === null || delivery.action === '' ? '' : `<br /><small class="muted">${escapeHtml(delivery.action)}</small>`}</td>
        <td>${escapeHtml(delivery.repository_full_name ?? '—')}</td>
        <td>${statusBadge(delivery.status)}</td>
        <td>${delivery.error === null ? '—' : `<span title="${escapeHtml(delivery.error)}">${escapeHtml(delivery.error.slice(0, 160))}</span>`}</td>
        <td>${delivery.status !== 'failed' ? '' : `<form method="post" action="/admin/webhooks/${escapeHtml(delivery.delivery_id)}/retry">${csrf(viewer)}<button class="btn btn-ghost btn-small" type="submit">${escapeHtml(t('重试', 'Retry'))}</button></form>`}</td>
      </tr>`).join('')
  const body = `<a class="back" href="/admin">← ${escapeHtml(t('返回管理', 'Back to admin'))}</a>
  <section class="card">
    <div class="row between"><div><div class="eyebrow">${escapeHtml(t('WEBHOOK', 'WEBHOOK'))}</div><h1>${escapeHtml(t('Webhook deliveries', 'Webhook deliveries'))}</h1><p class="muted">${escapeHtml(t(`最近 ${total} 条；只显示元数据，不显示 payload。`, `Latest ${total}; metadata only, payload is not shown.`))}</p></div></div>
    <form method="get" action="/admin/webhooks" class="form">
      <div class="row">
        <label>${escapeHtml(t('状态', 'Status'))} <select name="status"><option value="">${escapeHtml(t('全部', 'All'))}</option>${['processing', 'processed', 'failed'].map((value) => `<option value="${value}"${filters.status === value ? ' selected' : ''}>${escapeHtml(deliveryStatusLabel(t, value))}</option>`).join('')}</select></label>
        <label>${escapeHtml(t('事件', 'Event'))} <input name="event" value="${escapeHtml(filters.event)}" placeholder="check_suite" /></label>
        <button class="btn" type="submit">${escapeHtml(t('筛选', 'Filter'))}</button>
      </div>
    </form>
    <div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('收到', 'Received'))}</th><th>${escapeHtml(t('事件', 'Event'))}</th><th>${escapeHtml(t('仓库', 'Repository'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('错误', 'Error'))}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    ${pages <= 1 ? '' : `<div class="row between mt-12"><span class="fine">${escapeHtml(t(`第 ${page} / ${pages} 页`, `Page ${page} of ${pages}`))}</span><div class="row"><a class="btn btn-ghost btn-small" href="/admin/webhooks?${query({ page: Math.max(1, page - 1) })}">${escapeHtml(t('上一页', 'Previous'))}</a><a class="btn btn-ghost btn-small" href="/admin/webhooks?${query({ page: Math.min(pages, page + 1) })}">${escapeHtml(t('下一页', 'Next'))}</a></div></div>`}
  </section>`
  return layout({ title: t('Webhook deliveries', 'Webhook deliveries'), viewer, body, config, locale, path: '/admin/webhooks', active: 'admin', notice, error })
}

export function adminSupportPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  user: UserRow
  repos: RepoRow[]
  jobs: JobRow[]
  audit: AuditRow[]
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, user, repos, jobs, audit, notice, error } = input
  const t = translator(locale)
  const usersById = new Map([[user.id, user.login]])
  const repoRows = repos.length === 0
    ? stateCell(4, { kind: 'empty', title: t('没有仓库。', 'No repositories.'), body: t('这个用户还没有接入仓库。', 'This user has not connected a repository.'), action: { href: '/admin/users', label: t('查看用户', 'View users') } })
    : repos.map((repo) => `<tr><td data-label="${escapeHtml(t('仓库', 'Repository'))}"><strong>${escapeHtml(repo.upstream_owner || repo.owner)}/${escapeHtml(repo.upstream_name || repo.name)}</strong></td><td data-label="${escapeHtml(t('角色', 'Role'))}"><span class="badge kind">${escapeHtml(repoRoleLabel(t, repo.repo_role))}</span></td><td data-label="${escapeHtml(t('状态', 'Status'))}">${badge(t, repo.last_status ?? 'idle')}</td><td data-label="${escapeHtml(t('上次运行', 'Last run'))}">${escapeHtml(humanTimeShort(repo.last_run_at))}</td></tr>`).join('')
  const jobRows = jobs.length === 0
    ? stateCell(4, { kind: 'empty', title: t('没有任务。', 'No jobs.'), body: t('这个仓库还没有跑过任务。', 'This repository has not run a job yet.'), action: { href: '/dashboard#jobs', label: t('查看任务', 'View jobs') } })
    : jobs.map((job) => `<tr><td data-label="${escapeHtml(t('任务', 'Job'))}"><a href="/admin/jobs/${escapeHtml(job.id)}"><code>${escapeHtml(job.id)}</code></a></td><td data-label="${escapeHtml(t('状态', 'Status'))}">${badge(t, job.status)} <span class="badge kind">${escapeHtml(jobKindLabel(t, job))}</span></td><td data-label="PR">${escapeHtml(job.pr_url ?? '—')}</td><td data-label="${escapeHtml(t('创建', 'Created'))}">${escapeHtml(humanTimeShort(job.created_at))}</td></tr>`).join('')
  const body = `<a class="back" href="/admin">← ${escapeHtml(t('返回管理', 'Back to admin'))}</a>
    <section class="card"><div class="eyebrow">${escapeHtml(t('支持视图', 'SUPPORT VIEW'))}</div><h1>@${escapeHtml(user.login)}</h1><p class="muted">${badge(t, user.status)} · ${escapeHtml(roleLabel(t, user.role))} · ${escapeHtml(t('加入于', 'Joined'))} ${escapeHtml(humanTimeShort(user.created_at))}</p><p class="fine">${escapeHtml(t('只读；不会修改用户数据或触发任务。', 'Read-only; no user data or jobs are changed.'))}</p></section>
    <section class="card"><h2>${escapeHtml(t('仓库', 'Repositories'))}</h2><div class="table-scroll"><table class="table-cards"><thead><tr><th>${escapeHtml(t('仓库', 'Repository'))}</th><th>${escapeHtml(t('角色', 'Role'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('上次运行', 'Last run'))}</th></tr></thead><tbody>${repoRows}</tbody></table></div></section>
    <section class="card"><h2>${escapeHtml(t('最近任务', 'Recent jobs'))}</h2><div class="table-scroll"><table class="table-cards"><thead><tr><th>${escapeHtml(t('任务', 'Job'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>PR</th><th>${escapeHtml(t('创建', 'Created'))}</th></tr></thead><tbody>${jobRows}</tbody></table></div></section>
    <section class="card"><h2>${escapeHtml(t('审计', 'Audit'))}</h2>${auditRows(locale, audit, usersById, true)}</section>`
  return layout({ title: `${t('支持视图', 'Support view')} @${user.login}`, viewer, body, config, locale, path: `/admin/users/${user.id}`, active: 'admin', notice, error })
}

// #362: the owner's own search. The route has already scoped the query to
// `viewer.user.id` and validated every filter, so this only renders; a section
// that matches nothing says so and offers the next step instead of going blank.
export function searchPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  repos: RepoRow[]
  filters: { q: string; repo: string; status: string; kind: string; from: string; to: string }
  results: OwnedSearch | null
  cap: number
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, repos, filters, results, cap, notice, error } = input
  const t = translator(locale)
  // A goal or an audit detail can quote a support conversation, so a full address
  // is masked on the way out even when the row itself carries one.
  const text = (value: string | null | undefined): string => escapeHtml(String(value ?? '').replace(/[\w.+-]+@[\w.-]+/g, '***@***'))
  const labels = new Map(repos.map((repo) => [repo.id, `${repo.upstream_owner || repo.owner}/${repo.upstream_name || repo.name}`]))
  const table = (title: string, heads: string[], rows: string[], note: boolean, badgeText = ''): string => rows.length === 0 ? '' : `<section class="card"><h2>${escapeHtml(title)}${badgeText === '' ? '' : ` <span class="badge">${escapeHtml(badgeText)}</span>`}</h2><div class="table-scroll"><table><thead><tr>${heads.map((head) => `<th>${escapeHtml(head)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>${note ? `<p class="fine">${escapeHtml(t('还有更多结果，缩小关键词或加筛选。', 'More results — narrow the keyword or add a filter.'))}</p>` : ''}</section>`
  const open = (url: string | null): string => url === null ? '—' : `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(t('打开', 'Open'))}</a>`
  // The empty state goes through the shared renderer like the other four kinds:
  // a hand-built copy carried a literal '0' where the SVG set belongs, so this
  // page was the one place the icon contract did not hold.
  const empty = (title: string, body: string): string => renderState({ kind: 'empty', title, body, action: { href: '/console', label: t('回到工作区', 'Back to workspace') } })
  const [reposOut, jobsOut, itemsOut, auditOut] = [results?.repos.rows ?? [], results?.jobs.rows ?? [], results?.workItems.rows ?? [], results?.audit.rows ?? []]
  const sections = [
    table(t('仓库', 'Repositories'), [t('仓库', 'Repository'), t('状态', 'Status')], reposOut.map((row) => `<tr><td><a href="/repos/${escapeHtml(row.id)}">${text(`${row.owner}/${row.name}`)}</a></td><td>${escapeHtml(row.enabled === 1 ? t('已启用', 'enabled') : t('已暂停', 'paused'))}</td></tr>`), results?.repos.capped === true),
    table(t('任务', 'Jobs'), [t('任务', 'Job'), t('状态', 'Status'), t('摘要', 'Summary'), 'PR / Issue'], jobsOut.map((job) => `<tr><td><a href="/repos/${escapeHtml(job.repo_id)}/jobs/${escapeHtml(job.id)}"><code>${text(job.id)}</code></a><br /><span class="fine">${text(labels.get(job.repo_id) ?? job.repo_id)}</span></td><td>${badge(t, job.status)} <span class="badge kind">${text(jobKindLabel(t, job))}</span></td><td>${text(redact(job.summary ?? job.error ?? job.goal))}</td><td>${open(job.pr_url ?? job.issue_url)}</td></tr>`), results?.jobs.capped === true),
    table(t('工作项', 'Work items'), [t('工作项', 'Work item'), t('状态', 'Status'), 'PR / Issue'], itemsOut.map((item) => `<tr><td><a href="/repos/${escapeHtml(item.repo_id)}/workspace">${text(item.title)}</a><br /><span class="fine">${text(labels.get(item.repo_id) ?? item.repo_id)} · ${text(item.id)}</span></td><td>${text(workItemStateLabel(t, item.state))}</td><td>${open(item.pr_url ?? item.issue_url)}</td></tr>`), results?.workItems.capped === true),
    // Audit rows carry no repository, so that filter does not narrow them and the
    // section says so rather than quietly returning another repository's trail.
    table(t('审计', 'Audit'), [t('时间', 'When'), t('动作', 'Action'), t('说明', 'Detail')], auditOut.map((row) => `<tr><td>${escapeHtml(humanTimeShort(row.at))}</td><td><code>${text(row.action)}</code></td><td>${text(row.detail ?? '—')}</td></tr>`), results?.audit.capped === true, filters.repo === '' ? '' : t('不限仓库', 'not scoped by repository')),
  ].join('')
  const option = (value: string, label: string, selected: string): string => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
  const all = t('全部', 'All')
  const statusOptions = ['', ...JOB_FILTER_STATUSES].map((value) => option(value, value === '' ? all : statusFilterLabel(t, value), filters.status)).join('')
  // #568: `/search` applies the `kind` it is given, so an applied kind the form
  // does not offer — `discover`, or a token no job can have — is still the
  // selected option: visible, named and clearable, never hidden behind 全部类型 /
  // All kinds while the WHERE clause narrows by something else. The value is
  // clipped but never validated, so it is built by `option()`, which escapes it.
  const kindValues = filters.kind !== '' && !(JOB_FILTER_KINDS as string[]).includes(filters.kind) ? [...JOB_FILTER_KINDS, filters.kind] : [...JOB_FILTER_KINDS]
  const kindOptions = ['', ...kindValues].map((value) => option(value, value === '' ? all : kindFilterLabel(t, value), filters.kind)).join('')
  const body = `<a class="back" href="/console">← ${escapeHtml(t('返回工作区', 'Back to workspace'))}</a>
    <section class="card"><div class="eyebrow">${escapeHtml(t('搜索', 'SEARCH'))}</div><h1>${escapeHtml(t('在你的数据里查找', 'Search your own data'))}</h1><p class="muted">${escapeHtml(t(`只查你自己：仓库、任务、工作项和审计。每类最多显示前 ${cap} 条。`, `Your own data only: repositories, jobs, work items and audit. First ${cap} results per section.`))}</p>
      <form method="get" action="/search" class="form"><div class="row"><label>${escapeHtml(t('关键词', 'Query'))} <input name="q" value="${escapeHtml(filters.q)}" placeholder="${escapeHtml(t('任务 id、PR 链接、摘要…', 'job id, PR link, summary…'))}" /></label><label>${escapeHtml(t('仓库', 'Repository'))} <select name="repo">${[option('', t('全部仓库', 'All repositories'), filters.repo), ...repos.map((repo) => option(repo.id, labels.get(repo.id) ?? repo.id, filters.repo))].join('')}</select></label><label>${escapeHtml(t('状态', 'Status'))} <select name="status">${statusOptions}</select></label><label>${escapeHtml(t('类型', 'Kind'))} <select name="kind">${kindOptions}</select></label><label>${escapeHtml(t('从', 'From'))} <input name="from" value="${escapeHtml(filters.from)}" placeholder="YYYY-MM-DD" /></label><label>${escapeHtml(t('到', 'To'))} <input name="to" value="${escapeHtml(filters.to)}" placeholder="YYYY-MM-DD" /></label><button class="btn" type="submit">${escapeHtml(t('搜索', 'Search'))}</button></div></form></section>
    ${results === null ? empty(t('输入关键词开始搜索。', 'Type a keyword to search.'), t('搜索范围只有你自己：仓库、任务、工作项和审计。', 'The scope is your own data only: repositories, jobs, work items and audit.')) : sections === '' ? empty(t('没有匹配的结果。', 'No matches.'), t('换一个关键词、缩短它，或增加一项筛选来缩小范围；清空筛选会扩大范围。', 'Try another keyword, shorten it, or add a filter to narrow the search; clearing a filter widens it.') + (filters.kind === '' ? '' : ' ' + t(`当前类型：${kindFilterLabel(t, filters.kind)}。`, `Kind: ${kindFilterLabel(t, filters.kind)}.`))) : sections}`
  return layout({ title: t('搜索', 'Search'), viewer, body, config, locale, path: '/search', active: 'console', notice, error })
}

// #459: the newest export a viewer's scope produced, as the trail recorded it.
export type LastExport = { at: string; rows: number; scope: string; sha256: string }

export function adminSearchPage(input: {
  config: Config
  locale: Locale
  viewer: Viewer
  jobs: JobRow[]
  audit: AuditRow[]
  usersById: Map<string, string>
  filters: { q: string; status: string; kind: string; action: string; from: string; to: string }
  jobsPage: number
  jobsTotal: number
  auditPage: number
  auditTotal: number
  perPage: number
  lastJobsExport: LastExport | null
  lastAuditExport: LastExport | null
  notice?: string
  error?: string
}): string {
  const { config, locale, viewer, jobs, audit, usersById, filters, jobsPage, jobsTotal, auditPage, auditTotal, perPage, lastJobsExport, lastAuditExport, notice, error } = input
  const t = translator(locale)
  // #459: the newest export for this viewer's scope, so the page does not send
  // them paging the audit table by hand to learn what the last file was.
  const lastExportLine = (row: LastExport | null): string => row === null ? '' : `<p class="fine" data-last-export>${escapeHtml(t('上次导出', 'Last export'))} ${escapeHtml(humanTimeShort(row.at))} · ${escapeHtml(t('行数', 'rows'))} ${row.rows} · ${escapeHtml(t('范围', 'scope'))} ${escapeHtml(row.scope)} · sha256 ${escapeHtml(row.sha256.slice(0, 8))}</p>`
  const query = (values: Record<string, string | number>): string => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(values)) if (String(value) !== '') params.set(key, String(value))
    return params.toString()
  }
  const jobRows = jobs.length === 0
    ? stateCell(4, { kind: 'empty', title: t('没有匹配的任务。', 'No matching jobs.'), body: t('换一个关键词，或清空筛选。', 'Try another keyword, or clear the filter.'), action: { href: '/admin', label: t('回到管理', 'Back to admin') } })
    : jobs.map((job) => `<tr><td><a href="/admin/jobs/${escapeHtml(job.id)}"><code>${escapeHtml(job.id)}</code></a></td><td>${badge(t, job.status)} <span class="badge kind">${escapeHtml(jobKindLabel(t, job))}</span></td><td>${escapeHtml(usersById.get(job.user_id) ?? job.user_id)}</td><td>${escapeHtml(job.pr_url ?? job.issue_url ?? '—')}</td></tr>`).join('')
  const auditTable = auditRows(locale, audit, usersById, false)
  const jobQuery = query({ q: filters.q, status: filters.status, kind: filters.kind })
  const auditQuery = query({ q: filters.q, action: filters.action, from: filters.from, to: filters.to })
  const body = `<a class="back" href="/admin">← ${escapeHtml(t('返回管理', 'Back to admin'))}</a>
    <section class="card"><div class="eyebrow">${escapeHtml(t('搜索与导出', 'SEARCH & EXPORT'))}</div><h1>${escapeHtml(t('审计与任务', 'Audit and jobs'))}</h1><p class="muted">${escapeHtml(t('按用户范围过滤；可导出当前结果。', 'Scoped by the same user visibility as the admin page; export the current result.'))}</p></section>
    <section class="card"><h2>${escapeHtml(t('任务', 'Jobs'))}</h2><form method="get" action="/admin/search" class="form"><div class="row"><label>${escapeHtml(t('关键词', 'Query'))} <input name="q" value="${escapeHtml(filters.q)}" /></label><label>${escapeHtml(t('状态', 'Status'))} <select name="status"><option value="">${escapeHtml(t('全部', 'All'))}</option>${JOB_FILTER_STATUSES.map((status) => `<option value="${status}"${filters.status === status ? ' selected' : ''}>${escapeHtml(statusFilterLabel(t, status))}</option>`).join('')}</select></label><label>${escapeHtml(t('类型', 'Kind'))} <select name="kind"><option value="">${escapeHtml(t('全部', 'All'))}</option>${JOB_FILTER_KINDS.map((kind) => `<option value="${kind}"${filters.kind === kind ? ' selected' : ''}>${escapeHtml(kindFilterLabel(t, kind))}</option>`).join('')}</select></label><button class="btn" type="submit">${escapeHtml(t('搜索', 'Search'))}</button><a class="btn btn-ghost" href="/admin/export/jobs.csv?${escapeHtml(jobQuery)}">${escapeHtml(t('导出 CSV', 'Export CSV'))}</a></div></form>${lastExportLine(lastJobsExport)}<div class="table-scroll"><table><thead><tr><th>${escapeHtml(t('任务', 'Job'))}</th><th>${escapeHtml(t('状态', 'Status'))}</th><th>${escapeHtml(t('用户', 'User'))}</th><th>PR / Issue</th></tr></thead><tbody>${jobRows}</tbody></table></div><p class="fine">${escapeHtml(t('共', 'Total'))} ${jobsTotal} · ${escapeHtml(t('第', 'Page'))} ${jobsPage}</p>${pager('/admin/search', 'jobsPage', jobsPage, jobsTotal, perPage, t, { q: filters.q, status: filters.status, kind: filters.kind, auditPage })}</section>
    <section class="card"><h2>${escapeHtml(t('审计', 'Audit'))}</h2><form method="get" action="/admin/search" class="form"><div class="row"><label>${escapeHtml(t('关键词', 'Query'))} <input name="q" value="${escapeHtml(filters.q)}" /></label><label>${escapeHtml(t('动作', 'Action'))} <input name="action" value="${escapeHtml(filters.action)}" placeholder="repo.settings" /></label><label>${escapeHtml(t('从', 'From'))} <input name="from" value="${escapeHtml(filters.from)}" placeholder="YYYY-MM-DD" /></label><label>${escapeHtml(t('到', 'To'))} <input name="to" value="${escapeHtml(filters.to)}" placeholder="YYYY-MM-DD" /></label><button class="btn" type="submit">${escapeHtml(t('搜索', 'Search'))}</button><a class="btn btn-ghost" href="/admin/export/audit.csv?${escapeHtml(auditQuery)}">${escapeHtml(t('导出 CSV', 'Export CSV'))}</a></div></form>${lastExportLine(lastAuditExport)}${auditTable}<p class="fine">${escapeHtml(t('共', 'Total'))} ${auditTotal} · ${escapeHtml(t('第', 'Page'))} ${auditPage}</p>${pager('/admin/search', 'auditPage', auditPage, auditTotal, perPage, t, { q: filters.q, action: filters.action, from: filters.from, to: filters.to, jobsPage })}</section>`
  return layout({ title: t('审计与任务', 'Audit and jobs'), viewer, body, config, locale, path: '/admin/search', active: 'admin', notice, error })
}
