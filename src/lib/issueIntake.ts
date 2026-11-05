import type { WorkItemState } from './workItems.js'

const HIGH = new Set(['p0', 'p1', 'priority:high', 'prio:high', 'high'])
const MEDIUM = new Set(['p2', 'priority:medium', 'prio:medium', 'medium'])
const LOW = new Set(['p3', 'priority:low', 'prio:low', 'low'])

function lower(labels: string[]): string[] {
  return labels.map((label) => label.trim().toLowerCase())
}

export function issuePriority(labels: string[]): number {
  const values = lower(labels)
  if (values.some((label) => HIGH.has(label))) return 30
  if (values.some((label) => MEDIUM.has(label))) return 20
  if (values.some((label) => LOW.has(label))) return 10
  return 0
}

export function issueState(labels: string[], closed: boolean): WorkItemState {
  if (closed) return 'closed'
  return lower(labels).includes('agent-ready') ? 'triaged' : 'proposed'
}

export function shouldTriage(labels: string[]): boolean {
  return lower(labels).includes('agent-ready')
}
