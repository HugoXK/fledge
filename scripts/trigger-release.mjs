#!/usr/bin/env node
// Dispatch the daily release workflow from a reliable scheduler.
//
// GitHub's `schedule` event is best-effort and can arrive hours late. This
// script is the external trigger: a host cron or a Cloudflare Worker calls it
// at 02:00Z (10:00 Asia/Shanghai), and GitHub's own schedule remains the
// fallback. It only calls the workflow_dispatch endpoint; the workflow's
// `release-trigger` predicate still decides whether the slot needs filling, so
// a late schedule after this run is a no-op.
//
// The token is read from GITHUB_TOKEN, never from argv, and is never printed.
// GITHUB_REPOSITORY must be owner/name.
//
// #1035: the promise is checked, not assumed. A dispatch reads back the run it
// created, and `--check-slot` fails when no workflow_dispatch run exists by
// 02:05Z, so a scheduled fallback is named as a fallback rather than counted as
// the slot. A GitHub read that fails is reported as unreadable, never as a
// missed slot: "we could not look" is a different fact from "nobody came".

const WORKFLOW = 'daily-release.yml'
const SLOT_HOUR_UTC = 2
const DEADLINE_MINUTES = 5

function fail(message) {
  process.stderr.write(`trigger-release: ${message}\n`)
  process.exit(1)
}

const headers = (token) => ({
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  'user-agent': 'fledge-trigger',
})

export async function dispatchRelease({ repo, token, fetchImpl = globalThis.fetch, ref = 'main', workflow = WORKFLOW, clock = () => new Date().toISOString() }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(repo ?? ''))) throw new Error('GITHUB_REPOSITORY must be owner/name')
  if (typeof token !== 'string' || token === '') throw new Error('GITHUB_TOKEN is required')
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation')
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ ref, inputs: { dry_run: 'false' } }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`workflow dispatch answered ${String(response.status)}${text === '' ? '' : `: ${text.slice(0, 200)}`}`)
  }
  return { ok: true, at: clock(), repo, workflow, ref }
}

/** The most recent runs of the release workflow, newest first. A failed read
 * throws: the caller must be able to tell "unreadable" from "nobody came". */
export async function readReleaseRuns({ repo, token, fetchImpl = globalThis.fetch, workflow = WORKFLOW, sinceIso }) {
  if (typeof token !== 'string' || token === '') throw new Error('GITHUB_TOKEN is required')
  const query = `per_page=50${sinceIso === undefined ? '' : `&created=${encodeURIComponent(`>=${sinceIso}`)}`}`
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/runs?${query}`, {
    method: 'GET',
    headers: headers(token),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`run list answered ${String(response.status)}${text === '' ? '' : `: ${text.slice(0, 200)}`}`)
  }
  const body = JSON.parse(await response.text())
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : []
  return runs.flatMap((entry) => (typeof entry?.id === 'number' && typeof entry?.created_at === 'string'
    ? [{ id: entry.id, event: typeof entry.event === 'string' ? entry.event : '', createdAt: entry.created_at, conclusion: typeof entry.conclusion === 'string' ? entry.conclusion : null }]
    : []))
}

/** Dispatch, then read back the run it created. The dispatch is the result; the
 * read-back is proof, so a read failure returns `run: null` instead of turning a
 * real dispatch into an error. */
export async function dispatchWithProof({ repo, token, fetchImpl = globalThis.fetch, ref = 'main', workflow = WORKFLOW, clock = () => new Date().toISOString() }) {
  const dispatched = await dispatchRelease({ repo, token, fetchImpl, ref, workflow, clock })
  let run = null
  try {
    const since = new Date(Date.parse(dispatched.at) - 120_000).toISOString()
    const runs = await readReleaseRuns({ repo, token, fetchImpl, workflow, sinceIso: since })
    const created = runs.find((entry) => entry.event === 'workflow_dispatch' && Date.parse(entry.createdAt) >= Date.parse(dispatched.at) - 120_000)
    run = created === undefined ? null : { id: created.id, event: created.event, createdAt: created.createdAt, conclusion: created.conclusion }
  } catch {
    run = null
  }
  return { ...dispatched, run }
}

function iso(ms) {
  return new Date(ms).toISOString()
}

/** The 02:00Z boundary and its 02:05Z deadline for the UTC day of `now`. */
export function slotWindow(now) {
  const at = new Date(now)
  const boundary = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), SLOT_HOUR_UTC, 0, 0, 0)
  return { boundary: iso(boundary), deadline: iso(boundary + DEADLINE_MINUTES * 60_000) }
}

/**
 * What the slot looks like, from the runs and the clock:
 * - `slot-dispatched` — a workflow_dispatch run landed inside [02:00Z, 02:05Z];
 * - `slot-pending` — the deadline has not passed yet, so nothing has failed;
 * - `slot-late` — no dispatch, but a run filled the slot later: the fallback,
 *   named as such rather than counted as the promise kept;
 * - `slot-missed` — no dispatch and no run at all: nobody came.
 */
export function releaseSlotVerdict({ runs, now, deadlineMinutes = DEADLINE_MINUTES }) {
  const nowMs = Date.parse(String(now))
  const at = new Date(nowMs)
  const boundaryMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), SLOT_HOUR_UTC, 0, 0, 0)
  const deadlineMs = boundaryMs + deadlineMinutes * 60_000
  const list = Array.isArray(runs) ? runs : []
  const created = (run) => Date.parse(String(run?.createdAt))
  const dispatch = list.find((run) => run.event === 'workflow_dispatch' && Number.isFinite(created(run)) && created(run) >= boundaryMs && created(run) <= deadlineMs)
  if (dispatch !== undefined) {
    return { state: 'slot-dispatched', event: 'workflow_dispatch', boundary: iso(boundaryMs), deadline: iso(deadlineMs), run: dispatch }
  }
  if (nowMs < deadlineMs) {
    return { state: 'slot-pending', event: null, boundary: iso(boundaryMs), deadline: iso(deadlineMs), run: null }
  }
  const fallback = list.find((run) => Number.isFinite(created(run)) && created(run) >= boundaryMs)
  if (fallback !== undefined) {
    return { state: 'slot-late', event: fallback.event, boundary: iso(boundaryMs), deadline: iso(deadlineMs), run: fallback }
  }
  return { state: 'slot-missed', event: null, boundary: iso(boundaryMs), deadline: iso(deadlineMs), run: null }
}

async function main() {
  const repo = String(process.env.GITHUB_REPOSITORY ?? '')
  const token = String(process.env.GITHUB_TOKEN ?? '')
  if (repo === '') fail('GITHUB_REPOSITORY is not set')
  if (token === '') fail('GITHUB_TOKEN is not set')
  if (process.argv.includes('--check-slot')) {
    const now = new Date().toISOString()
    const dayStart = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString()
    let runs
    try {
      runs = await readReleaseRuns({ repo, token, sinceIso: dayStart })
    } catch (error) {
      process.stdout.write(`release-slot: unreadable ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(2)
    }
    const verdict = releaseSlotVerdict({ runs, now })
    const line = { state: verdict.state, boundary: verdict.boundary, deadline: verdict.deadline, event: verdict.event, run: verdict.run === null ? null : verdict.run.id }
    process.stdout.write(`release-slot: ${JSON.stringify(line)}\n`)
    process.exit(verdict.state === 'slot-dispatched' || verdict.state === 'slot-pending' ? 0 : 1)
  }
  try {
    const result = await dispatchWithProof({ repo, token })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
