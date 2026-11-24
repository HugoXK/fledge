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
//
// #1222: a successful `daily-release` run that published nothing is the planner
// saying "not tonight", so the decision reads the run's own `release-plan`
// artifact. The artifact is GitHub's zip; `planFromArtifactZip` gets the JSON
// out of it. An unreadable artifact is not a decline: the night is reported as a
// miss, because silence would hide a real one.

import { GRACE_MINUTES, decideSlotWatchdog, planFromArtifactZip, slotFor } from './lib/release-slot-watchdog.mjs'

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

/** Download one artifact by id: the download endpoint answers a zip, not JSON. */
async function download(path) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-release-slot-watchdog',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`GitHub ${response.status} ${path}`)
  return Buffer.from(await response.arrayBuffer())
}

function runsInWindow(runs, apiDate) {
  const window = slotFor(apiDate, GRACE_MINUTES)
  if (window === null) return []
  const from = Date.parse(window.slot)
  const to = from + 24 * 60 * 60 * 1000
  return runs.filter((run) => {
    const created = Date.parse(String(run?.created_at ?? ''))
    return !Number.isNaN(created) && created >= from && created < to
  })
}

/**
 * The plan the slot's own runs published, newest successful run first. Null when
 * there is nothing to read: the decision then reports the miss rather than a
 * decline. A download error is logged and treated as unknown, never as silence.
 */
async function readPlan(runs) {
  const green = runs
    .filter((run) => String(run?.conclusion ?? '') === 'success' && Number(run?.id ?? 0) > 0)
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
  for (const run of green) {
    try {
      const listed = await request(`/repos/${REPO}/actions/runs/${Number(run.id)}/artifacts?per_page=100`)
      const artifacts = Array.isArray(listed.data?.artifacts) ? listed.data.artifacts : []
      const artifact = artifacts.find((entry) => entry?.name === 'release-plan' && entry?.expired !== true)
      if (artifact === undefined) continue
      const plan = planFromArtifactZip(await download(`/repos/${REPO}/actions/artifacts/${Number(artifact.id)}/zip`))
      if (plan !== null) return plan
    } catch (error) {
      console.error(`release-slot-watchdog: could not read the release-plan artifact of run ${Number(run.id)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return null
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

  // The plan is only asked for once the grace window has passed: a night still
  // inside it is `too-early` and must cost no artifact read.
  const window = slotFor(apiDate, GRACE_MINUTES)
  const plan =
    window !== null && Date.parse(apiDate) >= Date.parse(window.graceEnds)
      ? await readPlan(runsInWindow(workflowRuns, apiDate))
      : null

  const decision = decideSlotWatchdog({
    now: apiDate,
    graceMinutes: GRACE_MINUTES,
    releases: releases.data,
    runs: workflowRuns,
    issues,
    plan,
  })

  console.log(`release-slot-watchdog: ${decision.action} — ${decision.reason}`)

  if (decision.action === 'invalid-clock') fail(decision.reason)
  if (decision.action === 'declined') {
    // The planner's own answer, recorded in the run's artifact and this log:
    // a night the gate correctly declined says its piece without a card.
    console.log(`release-slot-watchdog: declined — ${decision.reason}; no card`)
    return
  }
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
