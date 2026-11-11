#!/usr/bin/env node
// The `main-health` job's I/O half (#305). Every decision — create, comment,
// close or none — is `decision()` in `scripts/lib/main-health.mjs`; this file
// only gathers the run's input and applies that one action with `gh`.
//
// It runs in the only job in `ci.yml` with `issues: write`, gated on the default
// branch, so the write surface it exposes is one issue: create it, comment on
// it, or close it. The tracker is found by the `ci:main-red` label, never by
// its title, because a human can rename an issue and a title search would then
// open a duplicate on the next red run.

import { execFileSync } from 'node:child_process'
import { decision, RED_LABEL } from './lib/main-health.mjs'

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

function apply(result) {
  if (result.action === 'create') {
    const issue = result.issue
    if (issue === undefined) throw new Error('create decision without an issue payload')
    // `--label` is the search key: the next red run lists by this label, not by
    // the title above, so a rename cannot produce a second tracker.
    const url = gh(['issue', 'create', '--title', issue.title, '--label', RED_LABEL, '--body', issue.body])
    console.log(`main-health: opened ${url}`)
    return
  }
  if (result.action === 'comment' || result.action === 'close') {
    const number = String(result.tracker?.number ?? '')
    if (number === '') throw new Error(`${result.action} decision without a tracker number`)
    if (result.action === 'comment') {
      gh(['issue', 'comment', number, '--body', result.body ?? ''])
      console.log(`main-health: commented on #${number}`)
    } else {
      gh(['issue', 'close', number, '--comment', result.body ?? ''])
      console.log(`main-health: closed #${number}`)
    }
    return
  }
  console.log('main-health: nothing to report')
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? ''
  const needs = readNeeds()
  const aggregate = needs['ci-ok']
  const failingJobs = Object.entries(needs)
    .filter(([name, value]) => name !== 'ci-ok' && String(value?.result ?? '') !== 'success')
    .map(([name]) => name)

  const openTrackers = JSON.parse(
    gh(['issue', 'list', '--label', RED_LABEL, '--state', 'open', '--json', 'number,title,createdAt', '--limit', '100']),
  )

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
  apply(result)
}

main()
