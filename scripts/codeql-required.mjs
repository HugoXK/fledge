#!/usr/bin/env node
// #304: the CodeQL job's conclusion as a required check. `analyze` exits 0
// whether it found a sink or nothing at all, and the gate that reads its SARIF
// runs inside the same workflow, so a red `Analyze JavaScript/TypeScript` used to
// block only itself.
//
// This CLI reads the analysis that this event's commit already has, and fails
// `ci-ok` when it is red or absent. It never runs an analysis: the wait is for
// the one the pull request's own run started, bounded so a slow runner is a wait
// and not a flake.
//
//   GITHUB_EVENT_NAME=pull_request GITHUB_SHA=… GITHUB_REPOSITORY=… \
//   GITHUB_TOKEN=… node scripts/codeql-required.mjs

import { appendFileSync, readFileSync } from 'node:fs'

import { codeqlRequired } from './lib/codeql-required.mjs'

const WORKFLOW = 'codeql.yml'

function readEvent(eventPath) {
  if (eventPath === '') return {}
  try {
    return JSON.parse(readFileSync(eventPath, 'utf8'))
  } catch {
    return {}
  }
}

function apiClient({ token, base }) {
  return async function api(path) {
    const response = await fetch(`${base}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fledge-codeql-required',
      },
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${text.slice(0, 200)}`)
    return text === '' ? null : JSON.parse(text)
  }
}

// The analysis for a commit is the completed run of `codeql.yml` that reported
// that commit as its head. A pull request run reports the pull request head; the
// `pull_requests[].head.sha` match covers a run object that reports the merge
// commit instead, so the lookup cannot miss the run that answered this commit.
async function analysisFor(api, repo, sha) {
  const runs = await api(`/repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=completed&per_page=20`)
  const list = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs : []
  const match = list.find(
    (run) => run?.head_sha === sha || (Array.isArray(run?.pull_requests) && run.pull_requests.some((pull) => pull?.head?.sha === sha)),
  )
  if (match === undefined) return null
  return { conclusion: String(match.conclusion ?? '') }
}

function writeSummary(line) {
  const summary = process.env.GITHUB_STEP_SUMMARY ?? ''
  if (summary === '') return
  try {
    appendFileSync(summary, `${line}\n`)
  } catch {
    // The summary is a convenience; the exit code is the verdict.
  }
}

async function main() {
  const eventName = process.env.GITHUB_EVENT_NAME ?? ''
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
  const sha = process.env.GITHUB_SHA ?? ''
  const payload = readEvent(process.env.GITHUB_EVENT_PATH ?? '')

  // A scheduled analysis observes `main`; it has no merge to gate and needs no
  // credential. Every other event reads this repository's runs.
  if (eventName !== 'schedule' && (repository === '' || token === '')) {
    const missing = repository === '' ? 'GITHUB_REPOSITORY' : 'GITHUB_TOKEN'
    const line = `codeql-required: cannot read the CodeQL analysis, so a merge cannot be gated on it: no ${missing} in this run`
    console.error(line)
    writeSummary(line)
    process.exit(1)
  }

  const api = apiClient({ token, base: process.env.GITHUB_API_URL ?? 'https://api.github.com' })
  let verdict
  try {
    verdict = await codeqlRequired(
      { eventName, sha, payload },
      {
        analysisFor: async (asked) => {
          try {
            return await analysisFor(api, repository, asked)
          } catch (error) {
            throw new Error(`cannot read the CodeQL analysis for ${asked}: ${error.message}`)
          }
        },
      },
      // Real time and a real timer: the bound lives in the module, the test
      // injects its own clock and never sleeps.
      { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    )
  } catch (error) {
    // A read that fails is a gate that cannot decide, and a gate that cannot
    // decide must not read as green (the same stance as review-gate's thread read).
    verdict = { ok: false, reason: String(error?.message ?? error), sha: null, polls: 0 }
  }

  const line = `codeql-required: ${verdict.reason}`
  if (verdict.ok) console.log(line)
  else console.error(line)
  writeSummary(line)
  process.exit(verdict.ok ? 0 : 1)
}

await main()
