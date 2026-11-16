// #814: the Lead writes a decision, not a free-form status. This module keeps
// the accepted statuses, the fields each one needs and the public GitHub URL
// scope in one place, so the API and its tests cannot drift.

export const TRIAGE_STATUSES = [
  'user_error',
  'duplicate',
  'needs_info',
  'confirmed',
  'issue_opened',
  'pr_opened',
  'fixed',
  'wontfix',
] as const

export type TriageStatus = (typeof TRIAGE_STATUSES)[number]

export interface TriageDecision {
  status: string
  userMessage: string
  publicSummary: string
  issueUrl: string
  prUrl: string
  fixedVersion: string
}

export function isTriageStatus(value: string): value is TriageStatus {
  return (TRIAGE_STATUSES as readonly string[]).includes(value)
}

// A public issue/PR link must be in the configured Fledge repository and be the
// right object kind. A link to another repository, a profile or a comment is a
// mistake the Lead should fix before Fledge records it.
export function publicGithubObject(value: string, kind: 'issues' | 'pull', publicRepo: string): boolean {
  if (value === '') return true
  const [owner, name] = publicRepo.split('/')
  if (owner === undefined || owner === '' || name === undefined || name === '') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return false
    return new RegExp(`^/${escapeRegex(owner)}/${escapeRegex(name)}/${kind}/\\d+/?$`).test(url.pathname)
  } catch {
    return false
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Every user-facing status needs a message. A fixed result and a public issue
// additionally need the link/version that makes the next notification honest.
export function triageProblems(input: TriageDecision & { publicRepo: string }): string[] {
  const problems: string[] = []
  if (input.status === 'new' || input.status === 'released') problems.push('status is system-managed and cannot be written by the Lead')
  else if (!isTriageStatus(input.status)) problems.push('unsupported status')
  if (input.status !== 'new' && input.status !== 'released' && input.userMessage.trim() === '') problems.push('user_message is required for a user-facing status')
  if ((input.status === 'duplicate' || input.status === 'issue_opened') && input.issueUrl === '') problems.push('issue_url is required for this status')
  if ((input.status === 'pr_opened' || input.status === 'fixed') && input.prUrl === '') problems.push('pr_url is required for this status')
  if ((input.status === 'confirmed' || input.status === 'issue_opened') && input.publicSummary === '') problems.push('public_summary is required for a confirmed or opened issue')
  if (input.status === 'fixed' && input.fixedVersion === '') problems.push('fixed_version is required for a fixed status')
  if (!publicGithubObject(input.issueUrl, 'issues', input.publicRepo)) problems.push(`issue_url must be an issue in https://github.com/${input.publicRepo}`)
  if (!publicGithubObject(input.prUrl, 'pull', input.publicRepo)) problems.push(`pr_url must be a pull request in https://github.com/${input.publicRepo}`)
  return problems
}
