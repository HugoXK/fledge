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

function repositoryPathBefore(text: string, index: number): string | null {
  const match = REPOSITORY_PATH.exec(text.slice(0, index).trimEnd())
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

export function findDuplicatePullRequest(issueNumber: number, repository: string, pulls: OpenPullRequest[]): OpenPullRequest | null {
  const sameRepo = sameRepoReference(repository, issueNumber)
  for (const pull of pulls) {
    for (const text of [pull.title, pull.body, pull.head]) {
      if (sameRepo.test(text) || bareReferences(text, repository).includes(issueNumber)) return pull
    }
  }
  return null
}
