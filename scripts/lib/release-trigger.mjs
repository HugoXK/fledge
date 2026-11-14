// Which runs may plan the daily minor release (#315).
//
// The rule used to be carried by the event name alone: the `release` job ran on
// `schedule` and `workflow_dispatch`, and an ordinary merge to `main` was not
// allowed to plan. That made the scheduler the only dependable delivery path, and
// GitHub delivered `schedule` once in 68 runs — 6h27m late. The quantity the
// release rule counts (merged pull requests since the tag) changes only on a push
// to `main`, so a push can fill an open slot; since #548 the workflow only feeds
// this predicate a push that touched a release-shaped path, plus the two
// scheduled slots and a manual dispatch. The policy here is unchanged: an
// ordinary feature merge no longer pays for a full plan, and any run that does
// arrive still uses the same one-slot rule.
//
// Pure: no clock, no network, no environment. The workflow passes `now` and the
// state it already fetches; every decision is testable without a night.
//
// A slot ships at most once. Its marker is remote state, not run history: after a
// plan the `release/v<next>` branch exists, and after the merge the tag is newer
// than the boundary. So nothing has to remember that an earlier run planned.
//
// An orphan branch (`release/v<next>` with no pull request and no tag) is #333's
// subject: the drive reports it red by name. Here the same branch is a plain
// `branch-exists` no-plan, because the drive keeps its own red and this module
// must never be the thing that turns a wedged slot green.

/** The nightly boundary in UTC; 22:30 Asia/Shanghai. */
export const BOUNDARY = '14:30Z'
const BOUNDARY_HOUR = 14
const BOUNDARY_MINUTE = 30
const DAY_MS = 24 * 60 * 60 * 1000

const VERSION = /^\d+\.\d+\.\d+$/
const EVENTS = new Set(['push', 'schedule', 'workflow_dispatch'])

/**
 * The most recent 14:30Z boundary at or before `now`, as an ISO string, or null
 * when the clock cannot be read. A morning push therefore compares against
 * yesterday's boundary, which is what makes a dropped slot catch up.
 */
export function latestBoundary(now) {
  const at = now instanceof Date ? now : new Date(String(now ?? ''))
  const ms = at.getTime()
  if (Number.isNaN(ms)) return null
  const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), BOUNDARY_HOUR, BOUNDARY_MINUTE, 0, 0)
  return new Date(ms < today ? today - DAY_MS : today).toISOString()
}

function branchNames(branches) {
  if (!Array.isArray(branches)) return []
  return branches
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .filter((name) => typeof name === 'string' && name !== '')
}

function no(reason, boundary) {
  return { plan: false, catchUp: false, boundary: boundary ?? null, reason }
}

/**
 * Decide whether this run plans the night.
 *
 * Returns `{ plan, catchUp, boundary, reason }`. The reason starts with a stable
 * token (`slot-open`, `catch-up`, `guard`, `open-pr`, `branch-exists`,
 * `tag-exists`, `slot-shipped`, `invalid-*`, `unknown-event`) so the job summary
 * and a test can both name the real blocker.
 */
export function decideTrigger(input = {}) {
  const {
    event,
    now,
    tags = [],
    branches = [],
    openReleasePullRequests = [],
    nextVersion = '',
    lastTagCommittedAt = '',
    guardsPass = true,
    guardReason = '',
  } = input

  if (!EVENTS.has(event)) {
    return no(`unknown-event: ${String(event)} is not a trigger this routine plans on`)
  }
  // The planner's guards come first: a night the rule refuses has no version to
  // judge and no slot to fill.
  if (guardsPass !== true) {
    return no(`guard: ${String(guardReason) === '' ? 'the planner refused the night' : String(guardReason)}`)
  }
  const version = String(nextVersion ?? '')
  if (!VERSION.test(version)) {
    return no(`invalid-version: ${version === '' ? 'the planner returned no next version' : `${version} is not X.Y.Z`}`)
  }
  const boundary = latestBoundary(now)
  if (boundary === null) {
    return no(`invalid-clock: ${String(now)} cannot be placed against the ${BOUNDARY} boundary`)
  }

  const tag = `v${version}`
  if (Array.isArray(tags) && tags.map(String).includes(tag)) {
    return no(`tag-exists: ${tag} is already tagged, so that slot shipped`, boundary)
  }
  const open = Array.isArray(openReleasePullRequests)
    ? openReleasePullRequests.find((pr) => pr !== null && pr !== undefined)
    : undefined
  if (open !== undefined) {
    return no(`open-pr: #${Number(open?.number ?? 0)} is the open release pull request`, boundary)
  }
  const branch = `release/v${version}`
  if (branchNames(branches).includes(branch)) {
    return no(`branch-exists: ${branch} is already on the remote`, boundary)
  }

  const committedAt = String(lastTagCommittedAt ?? '')
  if (committedAt !== '') {
    const committed = Date.parse(committedAt)
    if (Number.isNaN(committed)) {
      return no(`invalid-tag-time: ${committedAt} cannot be read, so the slot cannot be judged`, boundary)
    }
    if (committed >= Date.parse(boundary)) {
      return no(`slot-shipped: the newest tag was committed at ${committedAt}, after the ${boundary} boundary`, boundary)
    }
  }

  // A push before today's boundary against yesterday's unreleased slot is the
  // catch-up: a dropped slot must not cost a whole day, and the card says so.
  const today = new Date(Date.UTC(
    new Date(String(now)).getUTCFullYear(),
    new Date(String(now)).getUTCMonth(),
    new Date(String(now)).getUTCDate(),
    BOUNDARY_HOUR,
    BOUNDARY_MINUTE,
    0,
    0,
  )).toISOString()
  if (event === 'push' && today !== boundary) {
    return { plan: true, catchUp: true, boundary, reason: `catch-up: the ${boundary} boundary went unreleased and this push is before today's boundary` }
  }
  return { plan: true, catchUp: false, boundary, reason: `slot-open: the ${boundary} boundary has not shipped` }
}
