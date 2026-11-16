// #637: a review that requests changes may start a fix, and a loop of such
// reviews must not spend model budget without a bound. The number of fixes a
// review may cause depends on who reviewed: a person is not counted, a
// third-party review bot may cause one fix per pull request, and the platform's
// own reviewer may cause `max_revisions` at one head. The rule is a pure
// function so every combination is cheaper to prove here than through a webhook
// and a database.

export type ReviewAuthor = 'human' | 'bot' | 'reviewer'

/** Default ceiling for the platform reviewer's own loop; a repository may lower it. */
export const DEFAULT_MAX_REVISIONS = 3

/** Where a repository overrides `DEFAULT_MAX_REVISIONS`. */
export function maxRevisionsSettingKey(repoId: string): string {
  return `repo:${repoId}:max_revisions`
}

export interface RevisionBudgetFacts {
  author: ReviewAuthor
  /** Fixes already started for this identity. */
  used: number
  /** The repository's ceiling for the platform reviewer. */
  limit: number
}

export type RevisionBudgetDecision =
  | { allow: true; counted: boolean; used: number }
  | { allow: false; reason: 'bot-once' | 'reviewer-limit'; used: number }

export function decideRevision(facts: RevisionBudgetFacts): RevisionBudgetDecision {
  // A person asking for a change is never met with a budget refusal: the
  // maintainer's own words are the request, and the fingerprint dedupe below is
  // what keeps a repeated request from starting twice.
  if (facts.author === 'human') return { allow: true, counted: false, used: facts.used }
  if (facts.author === 'bot') {
    // Another bot reviewing this product must not be able to drive a loop: one
    // fix per pull request, whichever head it reviewed and however it worded it.
    return facts.used >= 1
      ? { allow: false, reason: 'bot-once', used: facts.used }
      : { allow: true, counted: true, used: 1 }
  }
  const limit = Number.isInteger(facts.limit) && facts.limit > 0 ? facts.limit : DEFAULT_MAX_REVISIONS
  return facts.used >= limit
    ? { allow: false, reason: 'reviewer-limit', used: facts.used }
    : { allow: true, counted: true, used: facts.used + 1 }
}

export function parseMaxRevisions(value: string | undefined): number {
  const parsed = Number(value ?? '')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REVISIONS
}

/** The counter for one identity: a bot counts per pull request, the reviewer per head. */
export function revisionCounterKey(author: 'bot' | 'reviewer', repoId: string, prUrl: string, headSha: string): string {
  return author === 'bot' ? `revision:bot:${repoId}:${prUrl}` : `revision:reviewer:${repoId}:${headSha}:${prUrl}`
}

/**
 * The platform reviewer is the GitHub App's bot account (`<slug>[bot]`), because
 * that is the identity an installation token posts as. Any other bot account is
 * a third party; everything else is a person. The login check comes first
 * because an App bot would otherwise be classified as a third party.
 */
export function classifyReviewAuthor(login: string, type: string, reviewerLogin: string): ReviewAuthor {
  if (login !== '' && reviewerLogin !== '' && login.toLowerCase() === reviewerLogin.toLowerCase()) return 'reviewer'
  if (type.toLowerCase() === 'bot' || login.toLowerCase().endsWith('[bot]')) return 'bot'
  return 'human'
}
