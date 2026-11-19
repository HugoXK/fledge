#!/usr/bin/env node
// Open exactly one card when a UTC day's release slot shipped nothing (#941).
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/release-slot-watchdog.mjs
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/release-slot-watchdog.mjs --dry-run
//
// Runs from the existing hourly CI watchdog workflow, after the 02:00Z slot's
// grace window. The clock reading is the API's own `Date` response header: the
// host clock is never consulted and no wall-clock subtraction is made from it.
// The only write is the one card; the detector dispatches no workflow, creates
// no tag or release and writes no file.

import { GRACE_MINUTES, decideSlotWatchdog } from './lib/release-slot-watchdog.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const DRY_RUN = process.argv.includes('--dry-run')

function fail(message) {
  console.error(`release-slot-watchdog: ${message}`)
  process.exit(1)
}

async function request(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-release-slot-watchdog',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${text.slice(0, 200)}`)
  const date = response.headers.get('date') ?? ''
  let data = null
  if (text !== '') {
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`GitHub ${response.status} ${path} returned non-JSON`)
    }
  }
  return { data, date }
}

async function main() {
  if (TOKEN === '') fail('GITHUB_TOKEN is not set')
  if (!/^[^/\s]+\/[^/\s]+$/.test(REPO)) fail('GITHUB_REPOSITORY is not owner/name')

  // The releases read carries the API clock this pass uses.
  const releases = await request(`/repos/${REPO}/releases?per_page=100`)
  const apiDate = String(releases.date ?? '')
  if (apiDate === '' || Number.isNaN(Date.parse(apiDate))) {
    fail(`the API Date header is missing or unreadable (got ${apiDate === '' ? '(none)' : apiDate}); refusing to read the host clock`)
  }
  if (!Array.isArray(releases.data)) fail('GET /releases did not answer a list')

  const runs = await request(`/repos/${REPO}/actions/workflows/daily-release.yml/runs?per_page=100`)
  const workflowRuns = Array.isArray(runs.data?.workflow_runs) ? runs.data.workflow_runs : []

  // Recent issues only: the card for this slot is at most a day old, and the
  // marker makes the match exact. Listing beats search, whose index lags a new
  // issue by enough to open a second card on the next tick.
  const issues = []
  for (let page = 1; page <= 2; page += 1) {
    const batch = await request(`/repos/${REPO}/issues?state=all&per_page=100&sort=created&direction=desc&page=${page}`)
    if (!Array.isArray(batch.data)) fail('GET /issues did not answer a list')
    issues.push(...batch.data)
    if (batch.data.length < 100) break
  }

  const decision = decideSlotWatchdog({
    now: apiDate,
    graceMinutes: GRACE_MINUTES,
    releases: releases.data,
    runs: workflowRuns,
    issues,
  })

  console.log(`release-slot-watchdog: ${decision.action} — ${decision.reason}`)

  if (decision.action === 'invalid-clock') fail(decision.reason)
  if (decision.action === 'missed') {
    const issue = decision.issue
    if (issue === undefined) fail('the planner said missed without a card')
    if (DRY_RUN) {
      console.log(`release-slot-watchdog: dry run — would open "${issue.title}"`)
      return
    }
    const created = await request(`/repos/${REPO}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: issue.title, body: issue.body }),
    })
    const number = Number(created.data?.number ?? 0)
    console.log(`release-slot-watchdog: opened #${number} for ${decision.day} ${decision.slot}`)
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
