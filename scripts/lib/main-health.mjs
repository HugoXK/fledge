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

// The label is created by the reporter before its first use. `gh issue create
// --label <unknown>` is rejected with a 422 before the issue exists, so without
// this the first red `main` — the only case the feature exists for — would fail
// at exactly the moment it matters.
export const RED_LABEL_COLOR = 'b60205'
export const RED_LABEL_DESCRIPTION = 'a red default branch'

function text(value) {
  return String(value ?? '')
}

// `needs` holds every job the reporter depends on plus the aggregate. A job's
// result is one of success, failure, cancelled or skipped: only the first two
// are about the job, and `skipped` (a job that does not run for this event) must
// never be reported as a failing job.
export function failingJobsFrom(needs) {
  const entries = needs !== null && typeof needs === 'object' && !Array.isArray(needs) ? Object.entries(needs) : []
  return entries
    .filter(([name, value]) => name !== 'ci-ok' && ['failure', 'cancelled'].includes(text(value?.result)))
    .map(([name]) => name)
}

// Both halves of the label's life are here so the runner has no policy of its
// own: list, create only when absent, and treat a create that lost a race as
// presence. A create that genuinely fails is a named error rather than a bare
// 422 from `gh`, because the red job's log is the only place an operator sees it.
export async function ensureTrackerLabel({ label = RED_LABEL, listLabels, createLabel } = {}) {
  const has = (names) => (Array.isArray(names) ? names.map(text) : []).includes(label)
  if (has(await listLabels())) return { present: true, created: false }
  try {
    await createLabel(label)
    return { present: true, created: true }
  } catch (error) {
    if (has(await listLabels().catch(() => []))) return { present: true, created: false }
    throw new Error(
      `main-health: the ${label} label does not exist and could not be created (${text(error?.message ?? error)}); the first red main cannot open its tracker without it`,
    )
  }
}

function shortSha(sha) {
  const value = text(sha)
  return value === '' ? '(unknown sha)' : value.slice(0, 12)
}

// Every `gh` argument list lives here rather than in the runner so a suite can
// pin it. While `apply()` built its own arrays, mutating a verb — `'comment'` to
// `'coment'` — changed nothing any test could see: the decision was covered, the
// call it produced was not.
export function labelListArgs() {
  return ['label', 'list', '--json', 'name', '--limit', '100']
}

export function labelCreateArgs(label = RED_LABEL) {
  return ['label', 'create', text(label), '--color', RED_LABEL_COLOR, '--description', RED_LABEL_DESCRIPTION]
}

export function issueListArgs() {
  return ['issue', 'list', '--label', RED_LABEL, '--state', 'open', '--json', 'number,title,createdAt', '--limit', '100']
}

export function issueCreateArgs(issue) {
  return ['issue', 'create', '--title', text(issue?.title), '--label', RED_LABEL, '--body', text(issue?.body)]
}

export function issueCommentArgs(number, body) {
  return ['issue', 'comment', text(number), '--body', text(body)]
}

export function issueCloseArgs(number, body) {
  return ['issue', 'close', text(number), '--comment', text(body)]
}

function labelsIn(raw) {
  const value = text(raw).trim()
  const parsed = value === '' ? [] : JSON.parse(value)
  return (Array.isArray(parsed) ? parsed : []).map((entry) => text(entry?.name))
}

// Applies one decision through a caller-supplied command runner, so a test drives
// every call with no `gh` binary. The label bootstrap sits on the create path
// only: a green `main` — with or without a tracker — issues no label write, and a
// listing against a label that does not exist yet answers `200` with `[]`, not a
// failure, so the lookup before the decision is safe without it.
export async function apply(result, run) {
  if (typeof run !== 'function') throw new Error('main-health: apply() needs a command runner')
  if (result?.action === 'create') {
    const issue = result.issue
    if (issue === undefined) throw new Error('create decision without an issue payload')
    const outcome = await ensureTrackerLabel({
      label: RED_LABEL,
      listLabels: async () => labelsIn(run(labelListArgs())),
      createLabel: async (name) => {
        run(labelCreateArgs(name))
      },
    })
    const prefix = outcome.created ? `main-health: created the ${RED_LABEL} label\n` : ''
    return `${prefix}main-health: opened ${text(run(issueCreateArgs(issue)))}`
  }
  if (result?.action === 'comment' || result?.action === 'close') {
    const number = text(result.tracker?.number ?? '')
    if (number === '') throw new Error(`${result.action} decision without a tracker number`)
    if (result.action === 'comment') {
      run(issueCommentArgs(number, result.body ?? ''))
      return `main-health: commented on #${number}`
    }
    run(issueCloseArgs(number, result.body ?? ''))
    return `main-health: closed #${number}`
  }
  return 'main-health: nothing to report'
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
