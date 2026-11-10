import type { JobStatus } from '../db.js'
import type { Translate } from '../i18n.js'

// #232: the dashboard's job filters. The state is the URL — `repo`, `status`,
// `kind` — so a refresh, a shared link and a pagination click all land on the
// same list. Nothing here keeps client state: the route parses the query, the
// store filters in SQL, and the page renders the query back into its links.

export const JOB_FILTER_STATUSES: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'paused', 'quota_exhausted']
export const JOB_FILTER_KINDS: string[] = ['iterate', 'review', 'plan', 'research']

export interface JobFilter {
  repo: string
  status: JobStatus | ''
  kind: string
}

/** A value the account cannot use is dropped, never an error page. */
export function parseJobFilters(
  query: { repo?: string | undefined; status?: string | undefined; kind?: string | undefined },
  repoIds: string[],
): JobFilter {
  const repo = (query.repo ?? '').trim()
  const status = (query.status ?? '').trim()
  const kind = (query.kind ?? '').trim()
  return {
    repo: repoIds.includes(repo) ? repo : '',
    status: JOB_FILTER_STATUSES.includes(status as JobStatus) ? (status as JobStatus) : '',
    kind: JOB_FILTER_KINDS.includes(kind) ? kind : '',
  }
}

export function jobFilterIsActive(filter: JobFilter): boolean {
  return filter.repo !== '' || filter.status !== '' || filter.kind !== ''
}

/** Only the values that are set, so a cleared filter leaves a clean URL. */
export function jobFilterParams(filter: JobFilter): Record<string, string> {
  const params: Record<string, string> = {}
  if (filter.repo !== '') params.repo = filter.repo
  if (filter.status !== '') params.status = filter.status
  if (filter.kind !== '') params.kind = filter.kind
  return params
}

const STATUS_LABELS: Record<string, [string, string]> = {
  queued: ['排队中', 'Queued'],
  running: ['运行中', 'Running'],
  succeeded: ['成功', 'Succeeded'],
  failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'],
  paused: ['已暂停', 'Paused'],
  quota_exhausted: ['额度用尽', 'Quota exhausted'],
}

const KIND_LABELS: Record<string, [string, string]> = {
  iterate: ['迭代', 'Iterate'],
  review: ['审核', 'Review'],
  plan: ['计划', 'Plan'],
  research: ['分析', 'Research'],
}

export function statusFilterLabel(t: Translate, status: string): string {
  const label = STATUS_LABELS[status]
  return label === undefined ? status : t(label[0], label[1])
}

export function kindFilterLabel(t: Translate, kind: string): string {
  const label = KIND_LABELS[kind]
  return label === undefined ? kind : t(label[0], label[1])
}

/** The empty state and the summary line both name the active filters. */
export function jobFilterLabels(filter: JobFilter, repos: Array<{ id: string; label: string }>, t: Translate): string[] {
  const labels: string[] = []
  if (filter.repo !== '') {
    const repo = repos.find((candidate) => candidate.id === filter.repo)
    labels.push(t(`仓库：${repo?.label ?? filter.repo}`, `Repository: ${repo?.label ?? filter.repo}`))
  }
  if (filter.status !== '') labels.push(t(`状态：${statusFilterLabel(t, filter.status)}`, `Status: ${statusFilterLabel(t, filter.status)}`))
  if (filter.kind !== '') labels.push(t(`类型：${kindFilterLabel(t, filter.kind)}`, `Kind: ${kindFilterLabel(t, filter.kind)}`))
  return labels
}
