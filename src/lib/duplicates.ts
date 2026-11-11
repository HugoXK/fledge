export interface OpenPullRequest {
  number: number
  url: string
  title: string
  body: string
  head: string
  base: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// `#N` counts when no repository path stands before it, and an `/issues/N` URL
// counts only for the target repository. A path that names the target
// repository still counts (GitHub paths are case-insensitive); `other/repo#42`,
// `other/repo #42` and `https://github.com/other/repo/issues/42` are
// cross-repository references.
const BARE_REFERENCE = /#(\d+)\b/g
const ANY_ISSUE_URL = /\/issues\/(\d+)\b/
// The start is anchored to a delimiter so the scan is linear: a bare
// `[class]+/[class]+$` retries every split point from every position, which is
// quadratic on a slash-less run (65,538 chars measured 5,942 ms), and a pull
// request body is stored whole and matched once per `#N`.
const REPOSITORY_PATH = /(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/
// Only the path immediately before the `#` decides the reference, so a fixed
// window is enough and the copy is O(1) per reference instead of O(length).
// It is safe because a legal `owner/repo` is at most 140 characters (GitHub
// caps an owner at 39 and a repository at 100), so a real reference is always
// inside the last 256 characters before its `#`, with the delimiter that the
// pattern anchors on still in view; a longer run of path characters is not a
// repository reference at all, and truncating it cannot change the last two
// segments the pattern captures.
const PATH_WINDOW = 256

function repositoryPathBefore(text: string, index: number): string | null {
  const match = REPOSITORY_PATH.exec(text.slice(Math.max(0, index - PATH_WINDOW), index).trimEnd())
  return match === null ? null : (match[1] ?? null)
}

function bareReferences(text: string, repository?: string): number[] {
  const numbers: number[] = []
  for (const match of text.matchAll(BARE_REFERENCE)) {
    const value = Number(match[1])
    if (!Number.isInteger(value) || value <= 0) continue
    const path = repositoryPathBefore(text, match.index ?? 0)
    if (path !== null && repository !== undefined && path.toLowerCase() !== repository.toLowerCase()) continue
    numbers.push(value)
  }
  return numbers
}

function sameRepoReference(repository: string, issueNumber: number): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRegExp(repository)}/issues/${issueNumber}\\b`, 'i')
}

function sameRepoIssueUrl(repository: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRegExp(repository)}/issues/(\\d+)\\b`, 'i')
}

function referenceNumber(match: RegExpExecArray | null): number | null {
  if (match === null || match[1] === undefined) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

export function issueNumberFromText(text: string, repository?: string): number | null {
  if (repository === undefined) return referenceNumber(ANY_ISSUE_URL.exec(text)) ?? bareReferences(text)[0] ?? null
  return referenceNumber(sameRepoIssueUrl(repository).exec(text)) ?? bareReferences(text, repository)[0] ?? null
}

// Generic over the pull request shape so a caller that passes merged pull
// requests gets the merge evidence back instead of the open-listing interface.
export function findDuplicatePullRequest<T extends OpenPullRequest>(issueNumber: number, repository: string, pulls: T[]): T | null {
  const sameRepo = sameRepoReference(repository, issueNumber)
  for (const pull of pulls) {
    for (const text of [pull.title, pull.body, pull.head]) {
      if (sameRepo.test(text) || bareReferences(text, repository).includes(issueNumber)) return pull
    }
  }
  return null
}

// #174: "someone is already on it" and "this already landed" are different facts,
// and a maintainer needs the difference. An open pull request proves work in
// flight; a merged one proves the fix is in, and its merge commit is the evidence
// to read. The two outcomes are computed together so no caller can report one as
// the other.
export interface MergedPullRequest extends OpenPullRequest {
  mergedAt: string
  mergeCommitSha: string | null
}

export type DuplicateOutcome =
  | { kind: 'open-pr'; url: string }
  | { kind: 'already-fixed'; url: string; mergeCommitSha: string | null; mergedAt: string }

// The merged list costs one more read, so it is requested lazily: a duplicate that
// is still open answers without it, and only work with nothing in flight pays for
// the history read.
//
// A merged pull request that merely *mentions* the issue is not the fix: the same
// matcher accepts a reference in a title, a body or a head branch name, and `This
// does not close #42` is routine on an active repository. The issue's own state is
// the fact that decides it, so it is read once, only after a merged candidate
// matched, and an open issue lets the work through rather than refusing it.
export async function duplicateOutcome(
  issueNumber: number,
  repository: string,
  open: OpenPullRequest[],
  merged: () => Promise<MergedPullRequest[]>,
  issueIsClosed: () => Promise<boolean>,
): Promise<DuplicateOutcome | null> {
  const inFlight = findDuplicatePullRequest(issueNumber, repository, open)
  if (inFlight !== null) return { kind: 'open-pr', url: inFlight.url }
  const landed = findDuplicatePullRequest(issueNumber, repository, await merged())
  if (landed === null) return null
  if (!(await issueIsClosed())) return null
  return { kind: 'already-fixed', url: landed.url, mergeCommitSha: landed.mergeCommitSha, mergedAt: landed.mergedAt }
}
