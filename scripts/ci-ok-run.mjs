#!/usr/bin/env node
// Publish the `ci-ok` check run from the default branch's copy of the gate.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo GITHUB_EVENT_PATH=... node scripts/ci-ok-run.mjs
//   ... node scripts/ci-ok-run.mjs --dry-run
//
// `ci-ok-publish.yml` runs this on `workflow_run`, after a `CI` run completes,
// so the file that decides the merge is the default branch's and not the pull
// request's. The aggregate inside `ci.yml` keeps publishing `ci-ok` until the
// follow-up renames it to `ci-ok-head`; every check run at the head sha counts,
// so the head's green cannot retire this verdict.
//
// The trigger is a finished run, so this script reads that run's job list, has
// the base branch's classifier re-derive the change flags from the same diff,
// evaluates the base branch's required list, and creates the check run itself.
// A superseded (`cancelled`) run is skipped: a newer run for the same head is
// the one whose verdict counts.
//
// Nothing here is allowed to turn silence into a pass: a run whose evidence
// cannot be read publishes `failure` with the reason, because a missing
// required check and a red one block a merge either way, and only the red one
// explains itself.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { REQUIRED_JOBS } from './ci-ok.mjs'
import { allGateChanges } from './lib/ciChanges.mjs'
import { checkRunPayload, shouldPublish, verdict } from './lib/ci-ok-run.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const EVENT_PATH = process.env.GITHUB_EVENT_PATH ?? ''
const DRY_RUN = process.argv.includes('--dry-run')
const MAX_JOB_PAGES = 50

const CHECKOUT = (() => {
  const index = process.argv.indexOf('--repo')
  return index === -1 || process.argv[index + 1] === undefined ? '.' : process.argv[index + 1]
})()

function fail(message) {
  console.error(`ci-ok-run: ${message}`)
  process.exit(1)
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-ci-ok-run',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GitHub ${String(response.status)} ${path}: ${text.slice(0, 200)}`)
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`GitHub ${String(response.status)} ${path} returned non-JSON`)
  }
}

// The event payload carries the id of the run that triggered this workflow; the
// run itself is then read from the API so the facts (head, event, pull requests,
// conclusion) come from one place rather than from a payload shaped per event.
function triggeredRunId() {
  const index = process.argv.indexOf('--run')
  if (index !== -1 && process.argv[index + 1] !== undefined) return Number(process.argv[index + 1])
  if (EVENT_PATH === '') fail('no GITHUB_EVENT_PATH and no --run <id>: there is nothing to judge')
  let payload
  try {
    payload = JSON.parse(readFileSync(EVENT_PATH, 'utf8'))
  } catch (error) {
    fail(`cannot read the event payload: ${error.message}`)
  }
  const id = payload?.workflow_run?.id
  if (typeof id !== 'number') fail('the event payload has no workflow_run.id')
  return id
}

async function loadRun(runId) {
  const run = await api(`/repos/${REPO}/actions/runs/${String(runId)}`)
  if (run === null || typeof run !== 'object') throw new Error(`run ${String(runId)} answered nothing`)
  return run
}

async function loadJobs(runId) {
  const jobs = []
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const body = await api(`/repos/${REPO}/actions/runs/${String(runId)}/jobs?filter=latest&per_page=100&page=${String(page)}`)
    const batch = Array.isArray(body?.jobs) ? body.jobs : []
    jobs.push(...batch)
    if (batch.length < 100) break
  }
  return jobs
}

function git(args) {
  return spawnSync('git', ['-C', CHECKOUT, ...args], { encoding: 'utf8' })
}

// The commit the tree under test is compared against, and the branch name the
// classifier may fetch when the sha is not in the checkout. A push or a
// scheduled run verifies the whole tree, so it has no range at all.
function range(run) {
  const pulls = Array.isArray(run.pull_requests) ? run.pull_requests : []
  if (run.event === 'pull_request') {
    const bases = new Set(pulls.map((pull) => pull?.base?.sha).filter((sha) => typeof sha === 'string' && sha !== ''))
    if (bases.size !== 1) {
      throw new Error(`a pull request run must name exactly one base sha, got ${String(bases.size)}`)
    }
    const [sha] = [...bases]
    const ref = pulls[0]?.base?.ref
    return { base: sha, ref: typeof ref === 'string' ? ref : undefined }
  }
  if (run.event === 'merge_group') {
    // A queue entry's head is the synthetic merge commit; its first parent is
    // the branch tip the queue measured against. The payload's pull request
    // list is not guaranteed for this event, so the commit graph says it.
    const parent = git(['rev-parse', '--verify', `${String(run.head_sha)}^1`])
    if (parent.status !== 0) throw new Error('a merge queue head has no first parent in the checkout')
    const ref = pulls[0]?.base?.ref
    return { base: parent.stdout.trim(), ref: typeof ref === 'string' ? ref : undefined }
  }
  return { base: undefined, ref: undefined }
}

function changesFor(run, from) {
  if (from.base === undefined) return allGateChanges()
  const classifier = fileURLToPath(new URL('./ci-changes.mjs', import.meta.url))
  const args = [classifier, '--repo', CHECKOUT, '--git-base', from.base, '--git-head', String(run.head_sha)]
  if (from.ref !== undefined) args.push('--base-ref', from.ref)
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    const tail = (result.stderr ?? '').trim().split('\n').filter((line) => line !== '').pop()
    throw new Error(`the base classifier could not read the diff: ${tail ?? `exit ${String(result.status)}`}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error('the base classifier did not print JSON')
  }
}

function failingResult(message) {
  return { needs: {}, lines: [], problems: [message], ok: false }
}

async function publish(payload) {
  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  await api(`/repos/${REPO}/check-runs`, { method: 'POST', body: JSON.stringify(payload) })
}

async function main() {
  if (TOKEN === '') fail('GITHUB_TOKEN is empty, and the check run cannot be created without it')
  if (REPO === '') fail('GITHUB_REPOSITORY is empty')
  const run = await loadRun(triggeredRunId())
  if (!shouldPublish(run)) {
    console.log(`ci-ok-run: run ${String(run.id)} concluded ${String(run.conclusion)}; a newer run for this head supersedes it`)
    return
  }
  let result
  try {
    const jobs = await loadJobs(run.id)
    const from = range(run)
    const changes = changesFor(run, from)
    result = verdict({ jobs, eventName: run.event, changes })
  } catch (error) {
    result = failingResult(`ci-ok could not be computed from run ${String(run.id)}: ${error.message}`)
  }
  const payload = checkRunPayload({
    headSha: String(run.head_sha),
    result,
    runId: run.id,
    runUrl: typeof run.html_url === 'string' ? run.html_url : undefined,
    required: REQUIRED_JOBS,
  })
  await publish(payload)
  console.log(`ci-ok-run: ${payload.conclusion} at ${payload.head_sha} (${payload.output.title})`)
  for (const line of result.lines) console.log(line)
  for (const problem of result.problems) console.error(problem)
}

await main()
