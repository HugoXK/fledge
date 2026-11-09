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

// `#N` counts only when the `#` does not continue a repository path, and an
// `/issues/N` URL counts only for the target repository; `other/repo#42`,
// `other/repo #42` and `https://github.com/other/repo/issues/42` are
// cross-repository references.
const BARE_REFERENCE = /#(\d+)\b/g
const ANY_ISSUE_URL = /\/issues\/(\d+)\b/
const REPOSITORY_PATH_BEFORE_REFERENCE = /[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function followsRepositoryPath(text: string, index: number): boolean {
  return REPOSITORY_PATH_BEFORE_REFERENCE.test(text.slice(0, index).trimEnd())
}

function bareReferences(text: string): number[] {
  const numbers: number[] = []
  for (const match of text.matchAll(BARE_REFERENCE)) {
    const value = Number(match[1])
    if (!Number.isInteger(value) || value <= 0) continue
    if (followsRepositoryPath(text, match.index ?? 0)) continue
    numbers.push(value)
  }
  return numbers
}

function sameRepoReference(repository: string, issueNumber: number): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRegExp(repository)}/issues/${issueNumber}\\b`)
}

function sameRepoIssueUrl(repository: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9_.-])${escapeRegExp(repository)}/issues/(\\d+)\\b`)
}

function referenceNumber(match: RegExpExecArray | null): number | null {
  if (match === null || match[1] === undefined) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

export function issueNumberFromText(text: string, repository?: string): number | null {
  if (repository === undefined) return referenceNumber(ANY_ISSUE_URL.exec(text)) ?? bareReferences(text)[0] ?? null
  return referenceNumber(sameRepoIssueUrl(repository).exec(text)) ?? bareReferences(text)[0] ?? null
}

export function findDuplicatePullRequest(issueNumber: number, repository: string, pulls: OpenPullRequest[]): OpenPullRequest | null {
  const sameRepo = sameRepoReference(repository, issueNumber)
  for (const pull of pulls) {
    for (const text of [pull.title, pull.body, pull.head]) {
      if (sameRepo.test(text) || bareReferences(text).includes(issueNumber)) return pull
    }
  }
  return null
}
