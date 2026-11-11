#!/usr/bin/env node
// The recording side of an issue verdict's body hash (#324). A verdict's first
// line names a 12-hex sha256 of the issue body; this prints the two forms the
// gate accepts, so a verdict writer records from the same definition instead of
// re-deriving it with `sha256sum` and a trailing-newline trim of its own.
//
//   node scripts/issue-hash.mjs --issue 324
//   node scripts/issue-hash.mjs --body-file body.md
//   node scripts/issue-hash.mjs --issue 324 --match c6caa3f34634
//
// Output is one machine line per form; `match` is added only with --match:
//
//   issue-hash: raw <hash>
//   issue-hash: trimmed <hash>
//   issue-hash: match raw|trimmed|none
//
// Exit 0 when the body was read; 1 when --match names neither form; 6 when the
// tool could not run. The comparison and hashing live in
// scripts/lib/issue-body-hash.mjs — this file computes nothing itself.

import { readFileSync } from 'node:fs'
import { bodyHashes, matchBodyHash } from './lib/issue-body-hash.mjs'

const DEFAULT_API = 'https://api.github.com'

function arg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

function fail(message) {
  console.error(`issue-hash: ${message}`)
  process.exit(6)
}

async function readIssueBody(issueNumber) {
  const apiBase = (arg('--api-base') ?? process.env.GITHUB_API_URL ?? DEFAULT_API).replace(/\/$/, '')
  const repo = arg('--repo') ?? process.env.GITHUB_REPOSITORY ?? ''
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) fail('--issue <number> must be a positive integer')
  if (!/^[^/]+\/[^/]+$/.test(repo)) fail('GITHUB_REPOSITORY or --repo owner/name is required')
  if (apiBase === DEFAULT_API && token === '') fail('GITHUB_TOKEN is not set (pass --api-base for a fixture)')
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'fledge-issue-hash' }
  if (token !== '') headers.authorization = `Bearer ${token}`
  const response = await fetch(`${apiBase}/repos/${repo}/issues/${issueNumber}`, { headers, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) fail(`GitHub ${response.status} for issue #${issueNumber}`)
  const issue = await response.json()
  if (typeof issue?.body !== 'string') fail(`GitHub returned no body for #${issueNumber}`)
  return issue.body
}

async function main() {
  const issue = Number(arg('--issue'))
  const bodyFile = arg('--body-file')
  const inline = arg('--body')
  const match = arg('--match')

  let body
  if (bodyFile !== undefined) body = readFileSync(bodyFile, 'utf8')
  else if (inline !== undefined) body = inline
  else if (Number.isInteger(issue) && issue > 0) body = await readIssueBody(issue)
  else fail('pass --issue <N>, --body-file <path> or --body <text>')

  const hashes = bodyHashes(body)
  console.log(`issue-hash: raw ${hashes.raw}`)
  console.log(`issue-hash: trimmed ${hashes.trimmed}`)

  if (match !== undefined) {
    const found = matchBodyHash(body, match)
    if (found === null) {
      console.log('issue-hash: match none')
      process.exit(1)
    }
    console.log(`issue-hash: match ${found.form}`)
  }
}

await main()
