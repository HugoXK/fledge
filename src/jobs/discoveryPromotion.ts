import type { Config } from '../config.js'
import type { Store } from '../db.js'
import { randomId } from '../lib/secrets.js'

// #803: discovery stays issue-only. This is the explicit, opt-in bridge from a
// discovered issue to the normal work-item queue. It never creates a branch or
// a pull request and it never changes the issue itself.
export type DiscoveryPromotionStatus = 'promoted' | 'disabled' | 'duplicate' | 'cap' | 'no-issue'

export interface DiscoveryPromotionResult {
  status: DiscoveryPromotionStatus
  workItemId?: string
}

export function promoteDiscoveredIssue(
  store: Store,
  config: Config,
  input: { repoId: string; userId: string; issueUrl: string | null; title?: string; priority?: number; now?: Date },
): DiscoveryPromotionResult {
  const issueUrl = input.issueUrl ?? ''
  if (issueUrl === '') return { status: 'no-issue' }
  if (!config.autoPromoteDiscovery || config.autoPromoteDiscoveryDailyCap <= 0) return { status: 'disabled' }

  const existing = store.findWorkItemByIssueUrl(input.repoId, issueUrl)
  if (existing !== undefined) return { status: 'duplicate', workItemId: existing.id }

  // The cap is per repository: a deployment-wide counter let one busy
  // repository spend every other repository's day. A corrupt value counts as
  // zero — `NaN >= cap` is false forever, which would switch the cap off.
  const day = (input.now ?? new Date()).toISOString().slice(0, 10)
  const key = `discover-promote:${input.repoId}:${day}`
  const stored = Number(store.getSetting(key) ?? 0)
  const used = Number.isFinite(stored) ? stored : 0
  if (used >= config.autoPromoteDiscoveryDailyCap) return { status: 'cap' }

  const id = randomId('work')
  const title = (input.title ?? '').trim().slice(0, 160) || issueUrl
  store.createWorkItem({ id, repoId: input.repoId, userId: input.userId, title, issueUrl, state: 'proposed', priority: input.priority })
  store.setSetting(key, String(used + 1))
  return { status: 'promoted', workItemId: id }
}
