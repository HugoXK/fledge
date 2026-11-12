#!/usr/bin/env node
// The `main-health` job's I/O half (#305). Every decision — create, comment,
// close or none — is `decision()` in `scripts/lib/main-health.mjs`, and every
// `gh` argument list plus the label bootstrap is `apply()` there too; this file
// only gathers the run's input and hands its one action to `apply(result, gh)`.
// That split is what lets a suite pin the calls (#343): a runner that built its
// own argv hid a mutated verb behind a covered decision.
//
// It runs in the only job in `ci.yml` with `issues: write`, gated on the default
// branch, so the write surface it exposes is one issue: create it, comment on
// it, or close it. The tracker is found by the `ci:main-red` label, never by
// its title, because a human can rename an issue and a title search would then
// open a duplicate on the next red run.

import { execFileSync } from 'node:child_process'
import { apply, decision, failingJobsFrom, issueListArgs } from './lib/main-health.mjs'

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' }).trim()
}

function readNeeds() {
  const raw = process.env.NEEDS ?? ''
  if (raw.trim() === '') return {}
  const parsed = JSON.parse(raw)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function runUrlOf(repository, serverUrl, runId) {
  if (repository === '' || runId === '') return ''
  const server = serverUrl === '' ? 'https://github.com' : serverUrl.replace(/\/+$/, '')
  return `${server}/${repository}/actions/runs/${runId}`
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const needs = readNeeds()
  const aggregate = needs['ci-ok']
  const failingJobs = failingJobsFrom(needs)

  const listed = gh(issueListArgs())
  const openTrackers = listed === '' ? [] : JSON.parse(listed)

  const result = decision({
    conclusion: String(aggregate?.result ?? ''),
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    ref: process.env.GITHUB_REF ?? '',
    sha: process.env.GITHUB_SHA ?? '',
    failingJobs,
    runUrl: runUrlOf(repository, process.env.GITHUB_SERVER_URL ?? '', process.env.GITHUB_RUN_ID ?? ''),
    openTrackers,
  })

  console.log(`main-health: ${result.action} — ${result.reason}`)
  console.log(await apply(result, gh))
}

main().catch((error) => {
  // The failure has to be readable in the job log: `ensureTrackerLabel` names
  // the label it could not create instead of leaving a bare 422 from `gh`.
  console.error(String(error?.message ?? error))
  process.exitCode = 1
})
