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

import { analysisFromApi, changeInventory, codeqlRequired } from './lib/codeql-required.mjs'

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

// #752: the range whose change set decides whether an analysis can exist at all.
// Only the events whose trigger `codeql.yml` filters have one; a push is analysed
// unfiltered, so it never short-circuits.
function changeRange(eventName, payload) {
  const event = payload ?? {}
  const read = (base, head) =>
    typeof base === 'string' && typeof head === 'string' && base !== '' && head !== '' ? { base, head } : null
  if (eventName === 'pull_request') return read(event.pull_request?.base?.sha, event.pull_request?.head?.sha)
  if (eventName === 'merge_group') return read(event.merge_group?.base_sha, event.merge_group?.head_sha)
  return null
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
        // #585: the lookup names the commit in its query, so the page cannot be
        // outrun by the repository's other runs. `deadline` is the bound the
        // module computes; the fallback scan for an API that ignores the filter
        // stops inside it.
        analysisFor: async (asked, hint) => {
          try {
            return await analysisFromApi({ api, repo: repository, sha: asked, deadline: hint?.deadline })
          } catch (error) {
            throw new Error(`cannot read the CodeQL analysis for ${asked}: ${error.message}`)
          }
        },
        // #752: the change set and the ignore list that decides whether an
        // analysis can exist. The list is read from the base commit, so a pull
        // request that edits `codeql.yml` is still judged by the policy in force
        // before it; every failure here is "no inventory", never a pass.
        changeInventory: async () => {
          const range = changeRange(eventName, payload)
          if (range === null) return null
          return await changeInventory({ api, repo: repository, base: range.base, head: range.head })
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
