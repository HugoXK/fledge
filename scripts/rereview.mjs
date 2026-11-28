#!/usr/bin/env node
// #1274: the missing trigger for a re-review. A change request that was answered
// waits for the reviewer to happen to look again, because the only events the
// gate reacts to are a person's review, a verdict comment and a merge group. This
// entrypoint turns two events into one request:
//
//   - a head that moved after `CHANGES_REQUESTED` (the workflow runs on
//     `pull_request: synchronize`), and
//   - a maintainer's `Re-review: <reason>` comment on the pull request (the
//     workflow runs on `issue_comment: created`), which is the only form that
//     works when the tip does not move and only the evidence changed.
//
// The request itself is never evidence and never a PASS: it posts one comment
// naming the request and the head, asks the reviewer named by the base branch's
// policy for one review, and re-runs the newest completed `Review gate` run at
// that head so the check, not just the thread, is re-decided. The decision is in
// scripts/lib/rereview.mjs; this file only reads the event and performs the writes.
//
//   node scripts/rereview.mjs --dry-run   one line per open PR, no write
//   node scripts/rereview.mjs --plan      the workflow's plan job: head=/decision= keys
//   node scripts/rereview.mjs             the workflow's request job: perform one request

import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { arg, readEvent } from './lib/gate-env.mjs'
import { commentDecision, decisionText, headMoveDecision, openRequestAt, parseReason, reportLine, rerunAllowed } from './lib/rereview.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const EVENT_PATH = process.env.GITHUB_EVENT_PATH ?? ''
const WORKFLOW = 'Review gate'
const HEAD_MOVED_REASON = 'the tip moved after a change request'

function stop(code, message) {
  const line = `rereview: ${message}`
  if (code === 0) console.log(line)
  else console.error(line)
  process.exit(code)
}

// gate-env's client only performs bodyless writes; a request comment and a review
// request both need a JSON body.
function client({ token, base, userAgent }) {
  return async function api(path, init = {}) {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': userAgent,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body,
      signal: AbortSignal.timeout(20_000),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) throw new Error(`GitHub ${response.status} ${path}: ${text.slice(0, 200)}`)
    return text === '' ? null : JSON.parse(text)
  }
}

async function thread(api, repo, number) {
  const [pr, reviews, comments] = await Promise.all([
    api(`/repos/${repo}/pulls/${number}`),
    api(`/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    api(`/repos/${repo}/issues/${number}/comments?per_page=100`),
  ])
  return {
    pr,
    reviews: Array.isArray(reviews) ? reviews : [],
    comments: Array.isArray(comments) ? comments : [],
  }
}

// The head-move source, evaluated the same way by the dry run, the plan job and
// the request job, so the line the plan job prints is the decision the write
// performs.
function headDecision(live) {
  const head = String(live.pr?.head?.sha ?? '')
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('the pull request names no head sha')
  const hasOpenRequest = openRequestAt(live.comments, live.reviews, head) !== null
  return { head, decided: headMoveDecision({ head, reviews: live.reviews, hasOpenRequest }) }
}

async function openPullRequests(api, repo, only) {
  if (only !== undefined && only !== null) return [Number(only)]
  const page = await api(`/repos/${repo}/pulls?state=open&per_page=100`)
  return (Array.isArray(page) ? page : []).map((pr) => Number(pr.number)).filter((n) => Number.isInteger(n) && n > 0)
}

async function dryRun(api, repo, only) {
  const numbers = await openPullRequests(api, repo, only)
  for (const number of numbers) {
    const live = await thread(api, repo, number)
    const { head, decided } = headDecision(live)
    console.log(reportLine({ number, head, decision: decided }))
  }
  console.log(`rereview: ${numbers.length} open pull request(s) read, no write performed`)
}

async function eventDecision(api, repo, eventName, event) {
  if (eventName === 'pull_request') {
    const number = Number(event?.pull_request?.number)
    if (!Number.isInteger(number) || number <= 0) throw new Error('the event names no pull request')
    const live = await thread(api, repo, number)
    if (live.pr?.state !== 'open' || live.pr?.draft === true) {
      return { number, head: String(live.pr?.head?.sha ?? ''), decided: { kind: 'no-op', code: 'not-open', head: String(live.pr?.head?.sha ?? '') }, reason: null }
    }
    const { head, decided } = headDecision(live)
    return { number, head, decided, reason: HEAD_MOVED_REASON, live }
  }
  if (eventName === 'issue_comment') {
    if (event?.issue?.pull_request == null) throw new Error('the comment is not on a pull request')
    const number = Number(event?.issue?.number)
    const live = await thread(api, repo, number)
    const head = String(live.pr?.head?.sha ?? '')
    const hasOpenRequest = openRequestAt(live.comments, live.reviews, head) !== null
    const decided = commentDecision({
      head,
      association: event?.comment?.author_association,
      body: event?.comment?.body,
      hasOpenRequest,
    })
    return { number, head, decided, reason: parseReason(event?.comment?.body), live }
  }
  throw new Error(`the event is ${eventName === '' ? '(none)' : eventName}, not a pull request or a comment`)
}

// The reviewer is the account the base branch's policy names, and a request that
// cannot prove which identity to ask asks nobody: the policy is read from the
// checkout of the base ref, never from the pull request head.
function reviewerFor() {
  let policy
  try {
    policy = JSON.parse(readFileSync('.github/agent/review-policy.json', 'utf8'))
  } catch (error) {
    throw new Error(`cannot read .github/agent/review-policy.json: ${error.message}`)
  }
  const reviewer = String(policy?.requiredPass ?? '')
  if (reviewer === '') throw new Error('the review policy names no requiredPass account')
  return reviewer
}

function requestComment({ reason, head }) {
  return [
    'Written-by: Fledge Re-review (GitHub Actions)',
    '',
    `Re-review: ${reason} — head ${head}`,
    '',
    'One open request per head: the reviewer re-runs the gates at this head and posts the verdict. This request is not a PASS and carries no evidence.',
  ].join('\n')
}

// The newest completed gate run at the head. A run that is still queued is the
// one the synchronize event just started, and it will publish the answer itself.
async function rerunGate(api, repo, head) {
  const page = await api(`/repos/${repo}/actions/runs?head_sha=${head}&per_page=100`)
  const runs = (Array.isArray(page?.workflow_runs) ? page.workflow_runs : []).filter(
    (run) => run?.name === WORKFLOW && run?.head_sha === head,
  )
  const newest = runs.sort((a, b) => Number(b.id) - Number(a.id))[0]
  if (newest === undefined) return `no ${WORKFLOW} run at ${head} to re-run`
  if (newest.status !== 'completed') return `${WORKFLOW} run ${String(newest.id)} is ${String(newest.status)}; it publishes its own answer`
  const attempt = Number(newest.run_attempt ?? 1)
  if (!rerunAllowed(attempt)) return `${WORKFLOW} run ${String(newest.id)} is at attempt ${attempt}; not re-run again`
  await api(`/repos/${repo}/actions/runs/${String(newest.id)}/rerun`, { method: 'POST' })
  return `re-ran ${WORKFLOW} run ${String(newest.id)} (attempt ${attempt}) at ${head}`
}

async function request(api, repo, { number, head, decided, reason, live }) {
  // The comment is the record that a request is open, so it is written last:
  // if the reviewer cannot be resolved, asked, or the gate cannot be re-run, no
  // open request is left behind for the next trigger to no-op against.
  const reviewer = reviewerFor()
  const already = (Array.isArray(live?.pr?.requested_reviewers) ? live.pr.requested_reviewers : []).some(
    (user) => user?.login === reviewer,
  )
  if (already) {
    console.log(`rereview: ${reviewer} is already a requested reviewer`)
  } else {
    await api(`/repos/${repo}/pulls/${number}/requested_reviewers`, {
      method: 'POST',
      body: JSON.stringify({ reviewers: [reviewer] }),
    })
    console.log(`rereview: requested one review from ${reviewer}`)
  }

  console.log(`rereview: ${await rerunGate(api, repo, head)}`)

  const comment = await api(`/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: requestComment({ reason, head }) }),
  })
  console.log(`rereview: posted request comment ${String(comment?.id ?? '')} at ${head}`)
  console.log(`rereview: ${reportLine({ number, head, decision: decided })}`)
}

async function main() {
  const repo = arg(process.argv, '--repo', process.env.GITHUB_REPOSITORY ?? '')
  if (repo === '') stop(1, 'GITHUB_REPOSITORY or --repo owner/name is not set')
  if (TOKEN === '') stop(1, 'GITHUB_TOKEN is not set')
  const api = client({ token: TOKEN, base: API, userAgent: 'fledge-rereview' })
  const only = arg(process.argv, '--pr', undefined)

  if (process.argv.includes('--dry-run')) {
    await dryRun(api, repo, only)
    return
  }

  const eventName = process.env.GITHUB_EVENT_NAME ?? ''
  const event = readEvent(EVENT_PATH)
  const { number, head, decided, reason, live } = await eventDecision(api, repo, eventName, event)

  if (process.argv.includes('--plan')) {
    for (const [key, value] of Object.entries({ number, head, decision: decided.kind, reason: decided.code })) {
      console.log(`${key}=${value}`)
    }
    return
  }

  if (decided.kind !== 'request') {
    console.log(`rereview: ${reportLine({ number, head, decision: decided })} — ${decisionText(decided)}`)
    return
  }
  await request(api, repo, { number, head, decided, reason, live })
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `rereview: ${decisionText(decided)} (${decided.code}) at ${head}\n`)
    } catch {
      // The summary is a convenience; it never changes the outcome.
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => stop(1, error.message))
}
