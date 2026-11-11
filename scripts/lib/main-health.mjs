// The default branch reports its own health (#305).
//
// Before this module a red `main` was invisible: `ci-ok` computed the commit's
// health and stopped. No job held `issues: write`, no workflow had a `failure()`
// path, and nothing watched the branch, so on 2026-11-11 the default branch was
// red for 83 minutes with nothing in the repository saying so.
//
// The decision is here, pure, for two reasons. It is the part worth testing —
// eight inputs and four outputs — and it keeps the one write scope in `ci.yml`
// from turning into logic that only YAML can explain:
//
//   (green, tracker open)      -> close that tracker with the clearing sha
//   (green, no tracker)        -> none
//   (not green, no tracker)    -> create one issue, labelled `ci:main-red`
//   (not green, tracker open)  -> comment on the newest tracker, never a second
//
// The reporter searches by the label, never by the title: a human can rename an
// issue, and a title search would then open a duplicate on the next red run.
// The concurrency group `ci-main-red` (in the workflow) stops two pushes inside
// one red state from both taking the create branch.

export const MAIN_REF = 'refs/heads/main'
export const RED_LABEL = 'ci:main-red'
export const RED_TITLE = 'ci: main is red'

// A nightly run exists precisely to catch the red main nobody's pull request
// caused, so `schedule` and `workflow_dispatch` are the same event class as a
// push to the default branch.
export const MAIN_EVENTS = ['push', 'schedule', 'workflow_dispatch']

function text(value) {
  return String(value ?? '')
}

function shortSha(sha) {
  const value = text(sha)
  return value === '' ? '(unknown sha)' : value.slice(0, 12)
}

function normaliseTrackers(trackers) {
  const list = (Array.isArray(trackers) ? trackers : [])
    .map((tracker) => ({
      number: Number(tracker?.number),
      title: text(tracker?.title),
      createdAt: text(tracker?.createdAt),
    }))
    .filter((tracker) => Number.isInteger(tracker.number) && tracker.number > 0)
  // Newest first: the reporter keeps one open tracker per red state, so the
  // newest is the one a later red run comments on and a green run closes.
  return list.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
    return right.number - left.number
  })
}

function redBody(sha, failing, runUrl) {
  return [
    `\`main\` is red at \`${text(sha)}\`.`,
    '',
    `Failing jobs: ${failing}`,
    '',
    `Run: ${text(runUrl)}`,
    '',
    'This issue is the tracker for one red state on the default branch. It is found by the `ci:main-red` label, not by its title, and `main-health` closes it when `ci-ok` is green again.',
  ].join('\n')
}

function stillRedBody(sha, failing, runUrl) {
  return [`Still red at \`${text(sha)}\`.`, '', `Failing jobs: ${failing}`, '', `Run: ${text(runUrl)}`].join('\n')
}

function clearedBody(sha, runUrl) {
  return [
    `\`main\` is green again at \`${text(sha)}\`.`,
    '',
    `Run: ${text(runUrl)}`,
    '',
    'Closed by the `main-health` job because `ci-ok` succeeded on the default branch.',
  ].join('\n')
}

export function decision(input = {}) {
  const conclusion = text(input.conclusion)
  const eventName = text(input.eventName)
  const ref = text(input.ref)
  const sha = text(input.sha)
  const runUrl = text(input.runUrl)
  const failingJobs = (Array.isArray(input.failingJobs) ? input.failingJobs : []).map(text).filter((name) => name !== '')

  // The one case that keeps `issues: write` away from pull requests and the
  // merge queue: those refs are not the default branch, so the answer is none.
  if (ref !== MAIN_REF) return { action: 'none', reason: `not the default branch (${ref === '' ? 'no ref' : ref})` }
  if (!MAIN_EVENTS.includes(eventName)) return { action: 'none', reason: `event ${eventName === '' ? '(none)' : eventName} does not report branch health` }

  const trackers = normaliseTrackers(input.openTrackers)
  const newest = trackers[0]
  const green = conclusion === 'success'

  if (green) {
    if (newest === undefined) return { action: 'none', reason: 'main is green and no tracker is open' }
    return {
      action: 'close',
      tracker: { number: newest.number, title: newest.title },
      body: clearedBody(sha, runUrl),
      reason: `main is green at ${shortSha(sha)}; closing #${String(newest.number)}`,
    }
  }

  const failing = failingJobs.length > 0 ? failingJobs.join(', ') : 'ci-ok did not report success'
  if (newest === undefined) {
    return {
      action: 'create',
      issue: { title: RED_TITLE, labels: [RED_LABEL], body: redBody(sha, failing, runUrl) },
      reason: `main is red at ${shortSha(sha)}; opening the first tracker`,
    }
  }
  return {
    action: 'comment',
    tracker: { number: newest.number, title: newest.title },
    body: stillRedBody(sha, failing, runUrl),
    reason: `main is still red at ${shortSha(sha)}; commenting on #${String(newest.number)}`,
  }
}
