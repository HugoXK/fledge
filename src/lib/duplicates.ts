export interface OpenPullRequest {
  number: number
  url: string
  title: string
  body: string
  head: string
  base: string
}

export function issueNumberFromText(text: string): number | null {
  const match = /\/issues\/(\d+)\b/.exec(text) ?? /(?:^|\s)#(\d+)\b/.exec(text)
  if (match === null || match[1] === undefined) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

export function findDuplicatePullRequest(issueNumber: number, pulls: OpenPullRequest[]): OpenPullRequest | null {
  const reference = new RegExp(`(?:/issues/|#)${issueNumber}\\b`)
  for (const pull of pulls) {
    if (reference.test(pull.body) || reference.test(pull.title) || reference.test(pull.head)) return pull
  }
  return null
}
