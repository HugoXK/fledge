import type { Translate } from '../i18n.js'

export type WorkItemState =
  | 'proposed'
  | 'triaged'
  | 'assigned'
  | 'in_progress'
  | 'pr_ready'
  | 'in_review'
  | 'changes_requested'
  | 'approved'
  | 'merged'
  | 'closed'

export const WORK_ITEM_STATES: readonly WorkItemState[] = [
  'proposed',
  'triaged',
  'assigned',
  'in_progress',
  'pr_ready',
  'in_review',
  'changes_requested',
  'approved',
  'merged',
  'closed',
]

export const WORK_ITEM_TRANSITIONS: Record<WorkItemState, readonly WorkItemState[]> = {
  proposed: ['triaged', 'closed'],
  triaged: ['assigned', 'closed'],
  assigned: ['in_progress', 'triaged', 'closed'],
  in_progress: ['pr_ready', 'triaged', 'changes_requested', 'closed'],
  pr_ready: ['in_review', 'changes_requested', 'merged', 'closed'],
  in_review: ['changes_requested', 'approved', 'merged', 'closed'],
  changes_requested: ['in_progress', 'closed'],
  approved: ['merged', 'closed'],
  merged: [],
  closed: ['triaged'],
}

export const MAINTAINER_ONLY_STATES: ReadonlySet<WorkItemState> = new Set(['triaged', 'assigned', 'approved', 'merged', 'closed'])

export function isWorkItemState(value: unknown): value is WorkItemState {
  return typeof value === 'string' && (WORK_ITEM_STATES as readonly string[]).includes(value)
}

export function workItemStateLabel(t: Translate, state: string): string {
  const labels: Record<string, [string, string]> = {
    proposed: ['待分诊', 'Proposed'],
    triaged: ['已分诊', 'Triaged'],
    assigned: ['已分配', 'Assigned'],
    in_progress: ['进行中', 'In progress'],
    pr_ready: ['PR 已就绪', 'PR ready'],
    in_review: ['审核中', 'In review'],
    changes_requested: ['需要修改', 'Changes requested'],
    approved: ['已批准', 'Approved'],
    merged: ['已合并', 'Merged'],
    closed: ['已关闭', 'Closed'],
  }
  const label = labels[state]
  return label === undefined ? state : t(label[0], label[1])
}
