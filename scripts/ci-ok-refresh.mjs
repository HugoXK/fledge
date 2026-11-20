#!/usr/bin/env node
// #1116: recompute the merge verdict when the required set grows.
//
// `ci-ok` is published once, when a `CI` run completes. Nothing re-asks when
// `scripts/ci-ok.mjs` gains a required job, so a head can keep a green verdict
// computed under a policy that no longer exists (#1016), and a head that renames
// `name: CI` never gets a publisher verdict at all (#1108 hole 2).
//
// This scanner runs on `push: [main]`, enumerates the open pull request heads and
// publishes a red `ci-ok` wherever the newest published verdict was computed under
// a different policy, or where the CI workflow finished, the publisher is not
// running, and no verdict naming a policy exists. It changes no file and merges
// nothing: it only writes a check run.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/ci-ok-refresh.mjs --repo .
//   ... --dry-run
//
// `--repo <dir>` is the default-branch checkout; the gate blob named in every
// verdict comes from it, so the identity is the policy this run publishes under
// and not the pull request's copy.

import { spawnSync } from 'node:child_process'

import { REQUIRED_JOBS } from './ci-ok.mjs'
import { policyIdentity, refreshDecision } from './lib/ci-ok-refresh.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const DRY_RUN = process.argv.includes('--dry-run')
const MAX_PAGES = 10

const CHECKOUT = (() => {
  const index = process.argv.indexOf('--repo')
  return index === -1 || process.argv[index + 1] === undefined ? '.' : process.argv[index + 1]
})()

// The workflow file whose completion the scanner reads. The *path* is stable
// while `name:` is the head's to change, which is the whole point of #1108 hole 2.
const CI_WORKFLOW_PATH = '.github/workflows/ci.yml'
// The publisher's own path: while one of its runs is queued or in progress for
// this head, its verdict is imminent and nothing may be published against the
// in-run aggregate that briefly carries the same check name.
const PUBLISH_WORKFLOW_PATH = '.github/workflows/ci-ok-publish.yml'

function fail(message) {
  console.error(`ci-ok-refresh: ${message}`)
  process.exit(1)
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-ci-ok-refresh',
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

function gateBlob() {
  const result = spawnSync('git', ['-C', CHECKOUT, 'rev-parse', 'HEAD:scripts/ci-ok.mjs'], { encoding: 'utf8' })
  const sha = (result.stdout ?? '').trim()
  return result.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : ''
}

async function openPullRequests() {
  const pulls = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await api(`/repos/${REPO}/pulls?state=open&per_page=100&page=${String(page)}`)
    const list = Array.isArray(batch) ? batch : []
    pulls.push(...list.filter((pull) => typeof pull?.head?.sha === 'string'))
    if (list.length < 100) break
  }
  return pulls
}

async function checkRuns(headSha) {
  const body = await api(`/repos/${REPO}/commits/${headSha}/check-runs?check_name=ci-ok&filter=all&per_page=100`)
  return Array.isArray(body?.check_runs) ? body.check_runs : []
}

async function runsState(headSha) {
  const body = await api(`/repos/${REPO}/actions/runs?head_sha=${headSha}&per_page=100`)
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : []
  return {
    ciCompleted: runs.some((run) => run?.path === CI_WORKFLOW_PATH && run?.status === 'completed'),
    // `status !== 'completed'` covers queued, in_progress, waiting and requested:
    // every state in which the publisher has been asked and has not answered yet.
    publisherPending: runs.some((run) => run?.path === PUBLISH_WORKFLOW_PATH && run?.status !== 'completed'),
  }
}

const TITLES = {
  'stale-policy': 'computed under a superseded required set',
  'no-published-verdict': 'a finished CI run has no published ci-ok',
}

function payloadFor(headSha, policy, decision) {
  return {
    name: 'ci-ok',
    head_sha: headSha,
    status: 'completed',
    conclusion: 'failure',
    output: {
      title: TITLES[decision.reason] ?? 'the published ci-ok is not satisfying',
      summary: [
        policy.text,
        '',
        decision.detail,
        '',
        `reason: ${decision.reason}`,
        `head: ${headSha}`,
        'Published by the push-to-main scanner (#1116); the pull request body still carries the review record.',
      ].join('\n'),
    },
  }
}

async function publish(payload) {
  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  await api(`/repos/${REPO}/check-runs`, { method: 'POST', body: JSON.stringify(payload) })
}

async function main() {
  if (TOKEN === '') fail('GITHUB_TOKEN is empty, and no check run can be created without it')
  if (REPO === '') fail('GITHUB_REPOSITORY is empty')
  const gateSha = gateBlob()
  if (gateSha === '') fail('the default branch checkout has no scripts/ci-ok.mjs blob')
  const policy = policyIdentity({ required: REQUIRED_JOBS, gateSha })
  console.log(`ci-ok-refresh: policy required=${policy.requiredHash} gate=${policy.gateSha}`)
  const pulls = await openPullRequests()
  let published = 0
  let skipped = 0
  for (const pull of pulls) {
    const headSha = String(pull.head.sha)
    if (pull.draft === true) {
      skipped += 1
      console.log(`#${String(pull.number)} ${headSha.slice(0, 12)} skip draft`)
      continue
    }
    const runs = await runsState(headSha)
    const decision = refreshDecision({
      headSha,
      policy,
      checks: await checkRuns(headSha),
      ciCompleted: runs.ciCompleted,
      publisherPending: runs.publisherPending,
    })
    if (!decision.publish) {
      skipped += 1
      console.log(`#${String(pull.number)} ${headSha.slice(0, 12)} skip ${decision.reason}`)
      continue
    }
    await publish(payloadFor(headSha, policy, decision))
    published += 1
    console.log(`#${String(pull.number)} ${headSha.slice(0, 12)} red ${decision.reason}`)
  }
  console.log(`ci-ok-refresh: ${String(published)} published, ${String(skipped)} skipped, ${String(pulls.length)} open pull request(s)`)
}

await main()
