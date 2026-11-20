#!/usr/bin/env node
// Publish the `ci-ok` check run from the default branch's copy of the gate.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo CI_OK_RUN_ID=... node scripts/ci-ok-run.mjs
//   ... node scripts/ci-ok-run.mjs --dry-run
//
// `ci-ok-publish.yml` runs this on `workflow_run`, after a `CI` run completes,
// so the file that decides the merge is the default branch's and not the pull
// request's. The aggregate inside `ci.yml` keeps publishing `ci-ok` until the
// follow-up renames it to `ci-ok-head`; every check run at the head sha counts,
// so the head's green cannot retire this verdict.
//
// The trigger names the finished run as an integer (`CI_OK_RUN_ID`, set from
// `github.event.workflow_run.id`), and every fact about that run is then read
// from the API: the job list, the head, the event, the pull requests. No file is
// read, so nothing a file holds can become part of a request.
//
// #1108: the job list alone cannot prove a required job did its work. It reports
// the job's *name* and its conclusion, so a head can keep the name `mock-check`
// and make the body `run: true`. A pull request run is therefore also compared
// against the default branch's copy of `.github/workflows/ci.yml` — every
// top-level block outside `jobs:` and every key of every required job, with
// `scripts/lib/gate-compare.mjs` deciding — and a mismatch is a refusal that
// names the job and the key. Both workflow texts are
// read through the contents API at the head sha and the default branch, not from
// the checkouts, for the same reason the run id is: a file read whose bytes end
// up in the check-run body is the `js/file-access-to-http` shape alert 140
// removed, and the checkouts stay data that nothing here reads.
//
// The default branch is read from the repository API, not from the run object:
// the run's slim `repository` has no `default_branch` key (run 44670966564 is
// the proof), so reading it there refuses every pull request. The
// `ci-workflow-change` label is not read at all: it only changed the wording of
// a refusal, never its conclusion, so reading it would add a permission for a
// sentence. Every refusal names the reviewed-change path instead.
//
// A push or a merge-queue entry is not compared: the queue head's tree already
// contains the reviewed change, and a push has no base range at all.
//
// A superseded (`cancelled`) run is skipped: a newer run for the same head is
// the one whose verdict counts. A `pull_request` run whose payload no longer
// names its base is skipped too when the head's pull request is already merged:
// the base is missing because the merge removed it, not because anything about
// the change failed, and there is no merge candidate left to judge (#1117).
// Every other unreadable run still publishes a red.
//
// Nothing here is allowed to turn silence into a pass: a run whose evidence
// cannot be read publishes `failure` with the reason, because a missing
// required check and a red one block a merge either way, and only the red one
// explains itself.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { REQUIRED_JOBS } from './ci-ok.mjs'
import { policyIdentity } from './lib/ci-ok-refresh.mjs'
import { allGateChanges } from './lib/ciChanges.mjs'
import {
  checkRunPayload,
  lostItsBase,
  mergedPullRequestOf,
  runIdFrom,
  skipDetail,
  skipReason,
  verdict,
} from './lib/ci-ok-run.mjs'
import { GATE_COMPARE_FILE, compareGate } from './lib/gate-compare.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
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

// The workflow names the run it was triggered by; the run itself is then read
// from the API so the facts (head, event, pull requests, conclusion) come from
// one place rather than from a payload shaped per event.
function triggeredRunId() {
  try {
    return runIdFrom({ args: process.argv, env: process.env })
  } catch (error) {
    fail(error.message)
  }
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

// #1116: the policy this verdict is computed under, as the blob of the evaluator
// the default branch publishes. An unreadable blob is not "no policy": a verdict
// that cannot name its policy cannot be compared later, so it is red below.
function gateBlob() {
  const result = spawnSync('git', ['-C', join(CHECKOUT, 'base'), 'rev-parse', 'HEAD:scripts/ci-ok.mjs'], { encoding: 'utf8' })
  const sha = (result.stdout ?? '').trim()
  return result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : ''
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

// #1108: the workflow text at a ref, as bytes the contents API serves. Anything
// else — a missing file, a symlink, a file past the API's 1 MB limit — is a
// reason to refuse rather than a reason to assume the gate is intact.
async function workflowText(ref) {
  const body = await api(`/repos/${REPO}/contents/${GATE_COMPARE_FILE}?ref=${encodeURIComponent(ref)}`)
  if (body === null || body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new Error(`${GATE_COMPARE_FILE} at ${ref} is not served as file content, so the comparison cannot be made`)
  }
  return Buffer.from(body.content, 'base64').toString('utf8')
}

// The branch the base workflow is read at. The run object's `repository` is a
// slim shape with no `default_branch` (the key is absent from run 44670966564),
// so the repository endpoint is the trusted answer; an unavailable one is a
// refusal, not a fallback to the head's own tree.
async function baseBranch() {
  const repository = await api(`/repos/${REPO}`)
  const branch = repository?.default_branch
  if (typeof branch !== 'string' || branch === '') {
    throw new Error('the repository API names no default branch, so the base workflow is unknown')
  }
  return branch
}

async function gateComparison(run) {
  const headSha = String(run.head_sha)
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error('the finished run names no 40-character head sha')
  const branch = await baseBranch()
  const [base, head] = await Promise.all([workflowText(branch), workflowText(headSha)])
  return compareGate({ base, head, required: REQUIRED_JOBS })
}

async function publish(payload) {
  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  await api(`/repos/${REPO}/check-runs`, { method: 'POST', body: JSON.stringify(payload) })
}

// The head a squashed or merged pull request used to have is not on the default
// branch, so reachability says nothing here: the commit's own pull request list
// says whether the merge is what removed the base. The lookup is made only for
// the run shape that lost its own list, and a lookup that fails answers nothing,
// which falls through to the red — an unreadable base is still a finding.
async function mergedHead(run) {
  if (!lostItsBase(run)) return null
  const headSha = String(run.head_sha ?? '')
  if (!/^[0-9a-f]{40}$/.test(headSha)) return null
  let pulls
  try {
    pulls = await api(`/repos/${REPO}/commits/${headSha}/pulls?per_page=100`)
  } catch (error) {
    console.error(`ci-ok-run: could not read the pull requests of ${headSha}: ${error.message}`)
    return null
  }
  for (const pull of Array.isArray(pulls) ? pulls : []) {
    if (mergedPullRequestOf(pull) !== null) return pull
  }
  return null
}

async function main() {
  if (TOKEN === '') fail('GITHUB_TOKEN is empty, and the check run cannot be created without it')
  if (REPO === '') fail('GITHUB_REPOSITORY is empty')
  const run = await loadRun(triggeredRunId())
  const merged = await mergedHead(run)
  const reason = skipReason(run, merged)
  if (reason !== null) {
    console.log(`ci-ok-run: run ${String(run.id)} skipped (${reason}): ${skipDetail(run, reason, merged)}`)
    return
  }
  const gateSha = gateBlob()
  const policy = gateSha === '' ? undefined : policyIdentity({ required: REQUIRED_JOBS, gateSha })
  let result
  try {
    if (policy === undefined) throw new Error('the default branch checkout has no scripts/ci-ok.mjs blob, so the verdict cannot name its policy')
    const jobs = await loadJobs(run.id)
    const from = range(run)
    const changes = changesFor(run, from)
    result = verdict({ jobs, eventName: run.event, changes })
    // #1108: the job list proves a job with a required *name* succeeded. The
    // workflow text is what says the job still does the required thing, so a
    // pull request run is refused when a required job's definition differs from
    // the base tree. Silence never passes: `ok` is the conjunction.
    if (run.event === 'pull_request') {
      const comparison = await gateComparison(run)
      result = {
        needs: result.needs,
        lines: [...result.lines, ...comparison.lines],
        problems: [...result.problems, ...comparison.problems],
        ok: result.ok && comparison.ok,
      }
    }
  } catch (error) {
    result = failingResult(`ci-ok could not be computed from run ${String(run.id)}: ${error.message}`)
  }
  const payload = checkRunPayload({
    headSha: String(run.head_sha),
    result,
    runId: run.id,
    runUrl: typeof run.html_url === 'string' ? run.html_url : undefined,
    required: REQUIRED_JOBS,
    policy,
  })
  await publish(payload)
  console.log(`ci-ok-run: ${payload.conclusion} at ${payload.head_sha} (${payload.output.title})`)
  for (const line of result.lines) console.log(line)
  for (const problem of result.problems) console.error(problem)
}

await main()
