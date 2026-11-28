// #1274: a change request has no re-review trigger. A pull request whose blocker
// was fixed sits at CHANGES_REQUESTED until the reviewer happens to look again —
// a moved tip is not an event the gate reacts to, and a body-only evidence edit
// moves nothing at all. This module is the decision, kept pure so the six shapes
// the card names are asserted as strings:
//
//   head moved after a change request  -> request head=<new>
//   maintainer `Re-review: <reason>`   -> request head=<same>
//   the same comment with no reason    -> refused: no reason
//   a comment from a non-maintainer    -> refused: not a maintainer
//   a request is already open at head  -> no-op: open request at <sha>
//   a head move with no change request -> no-op: no change request
//
// The request is never a PASS and carries no evidence: the reviewer still re-runs
// the gates itself. One request per head is honoured while no verdict at that head
// has answered it, so a second trigger at the same head writes nothing and cannot
// produce a second conclusion.

export const MAINTAINER_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR']
export const REQUEST_MARKER = 'Re-review:'

const HEAD_SUFFIX = /\s*—?\s*head ([0-9a-f]{7,40})\s*$/i

function decision(kind, code, head) {
  return { kind, code, head }
}

export function isMaintainer(association) {
  return MAINTAINER_ASSOCIATIONS.includes(String(association ?? '').toUpperCase())
}

function markerLine(body) {
  for (const line of String(body ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(REQUEST_MARKER)) return trimmed
  }
  return null
}

// The reason is everything the marker line carries except the marker and the
// `— head <sha>` suffix; a marker with no reason left has none at all.
export function parseReason(body) {
  const line = markerLine(body)
  if (line === null) return null
  const reason = line.slice(REQUEST_MARKER.length).replace(HEAD_SUFFIX, '').trim()
  return reason === '' ? null : reason
}

// The head a request comment names, or null when the comment names none.
export function requestedHead(body) {
  const line = markerLine(body)
  if (line === null) return null
  const match = HEAD_SUFFIX.exec(line)
  return match === null ? null : match[1]
}

function isBotComment(comment) {
  const login = String(comment?.user?.login ?? '')
  return comment?.user?.type === 'Bot' || /\[bot\]$/i.test(login)
}

// A review that answers a request is a verdict, and only a verdict state counts:
// this repository posts machine `COMMENTED` reviews (CodeQL), and an inline-only
// comment is not a conclusion, so neither may close a request and allow a second
// one at the same head.
export const VERDICT_STATES = ['APPROVED', 'CHANGES_REQUESTED']

// The head of the open request, or null when there is none. A request stays open
// until a verdict review at that head is submitted after it; the comment that
// posted the request is the workflow's own bot comment, so a person typing
// `Re-review:` in a reply opens nothing.
export function openRequestAt(comments, reviews, head) {
  const requests = (Array.isArray(comments) ? comments : []).filter(
    (comment) => isBotComment(comment) && requestedHead(comment?.body) === head && parseReason(comment?.body) !== null,
  )
  const last = requests.at(-1)
  if (last === undefined) return null
  const answered = (Array.isArray(reviews) ? reviews : []).some(
    (review) =>
      VERDICT_STATES.includes(String(review?.state ?? '')) &&
      review?.commit_id === head &&
      typeof review?.submitted_at === 'string' &&
      typeof last.created_at === 'string' &&
      review.submitted_at > last.created_at,
  )
  return answered ? null : head
}

// A tip that moved after the newest change request asks for one re-review. A
// change request that is already at this head means the tip did not move: that
// case is the comment form's, not this one's.
export function headMoveDecision({ head, reviews, hasOpenRequest }) {
  if (hasOpenRequest) return decision('no-op', 'open-request', head)
  const list = Array.isArray(reviews) ? reviews : []
  const change = [...list].reverse().find((review) => review?.state === 'CHANGES_REQUESTED')
  if (change === undefined) return decision('no-op', 'no-change-request', head)
  if (change.commit_id === head) return decision('no-op', 'no-head-move', head)
  return decision('request', 'head-moved', head)
}

// The comment form: only a maintainer's comment counts, it must carry a reason,
// and a request already open at this head makes it a no-op.
export function commentDecision({ head, association, body, hasOpenRequest }) {
  if (!isMaintainer(association)) return decision('refused', 'not-a-maintainer', head)
  if (parseReason(body) === null) return decision('refused', 'no-reason', head)
  if (hasOpenRequest) return decision('no-op', 'open-request', head)
  return decision('request', 'maintainer-request', head)
}

const NO_OP_TEXT = {
  'open-request': (d) => `open request at ${d.head}`,
  'no-change-request': () => 'no change request',
  'no-head-move': () => 'no head move',
}

const REFUSED_TEXT = {
  'no-reason': () => 'no reason',
  'not-a-maintainer': () => 'not a maintainer',
}

export function decisionText(decided) {
  if (decided.kind === 'request') return `request head=${decided.head}`
  const text = (decided.kind === 'refused' ? REFUSED_TEXT : NO_OP_TEXT)[decided.code]
  return `${decided.kind}: ${text === undefined ? decided.code : text(decided)}`
}

// The dry-run line the card specifies, one per open pull request.
export function reportLine({ number, head, decision: decided }) {
  return `PR ${number} head=${head} decision=${decided.kind} reason=${decided.code}`
}

// The re-run ceiling, in one place so the code and the record cannot drift: a
// `Review gate` run is re-run only while its attempt is below this, so a request
// causes at most one re-run and a head reaches attempt 2 at most.
export const RERUN_ATTEMPT_LIMIT = 2

export function rerunAllowed(attempt) {
  return Number.isInteger(attempt) && attempt >= 1 && attempt < RERUN_ATTEMPT_LIMIT
}
