// The review gate's decision, in one place so the required check and the
// rollup-repair step judge a tip with the same code.
//
// `api` performs one authenticated request and returns the parsed JSON body; it
// throws on a non-2xx response. Everything else here is a decision over data.
//
// A verdict is only ever looked for *at the tip*, and the newest conclusion wins.
// Two consequences are by design, not defects:
//   - a PASS that arrives after a REQUEST_CHANGES at the same SHA still exits 1
//     until a new commit moves the tip or one run at that SHA is re-run
//     (scripts/gate-repair.mjs performs that re-run);
//   - the gate needs nothing from the pull request tree: the policy comes from
//     the base ref, the tier from the API and the verdicts from the API.
import { tierForFiles, loadRules } from './risk.mjs'
import { mechanicalDiffShape, mechanicalRelease } from './mechanical-release.mjs'

export const REQUIRED_CONTEXT = 'review-gate'

// The verdict is a review object now, so its poster is `review.user.login` and
// no body line has to assert it. A verdict posted as an issue comment is the old
// shape: it stays valid only until this date, and this constant is the whole
// policy for it. It gates the comment path alone; the review path never expires.
export const COMMENT_VERDICT_FALLBACK_UNTIL = '2026-12-14T00:00:00.000Z'

export function commentVerdictFallbackOpen(now = Date.now()) {
  const until = Date.parse(COMMENT_VERDICT_FALLBACK_UNTIL)
  return Number.isFinite(now) && Number.isFinite(until) && now <= until
}

export function firstLine(body) {
  return String(body ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''
}

export function parseConclusion(body) {
  const head = firstLine(body)
  const fixed = /^Verdict:\s+(PASS|INC|REQUEST_CHANGES)\s+at\s+([0-9a-f]{7,40})\b/i.exec(head)
  if (fixed !== null) return { verdict: fixed[1].toUpperCase(), sha: fixed[2] }
  const heading = /^##\s*Review\s*[—:-]\s*(PASS|FAIL|INC|REQUEST_CHANGES)\b/i.exec(head)
  if (heading !== null) {
    const sha = /\b([0-9a-f]{7,40})\b/i.exec(String(body ?? ''))?.[1]
    return sha === undefined ? null : { verdict: heading[1].toUpperCase(), sha }
  }
  return null
}

export function writtenBy(body) {
  const match = /^\s*Written-by:\s*(.+)$/im.exec(String(body ?? ''))
  return match?.[1]?.trim() ?? ''
}

export function postedBy(body) {
  const match = /^\s*Posted-by:\s*(.+)$/im.exec(String(body ?? ''))
  return match?.[1]?.trim() ?? ''
}

export function hasNotRun(body) {
  return /(^|\n)\s*Not run[^\n:]*[:：]/i.test(String(body ?? ''))
}

const COMMAND_FIRST = /^(?:npm|node|npx|docker|git|gh|curl|pnpm|yarn)\b/i
const RAN_LABEL = /^\s*Ran[^\n:]*[:：]\s*(.*)$/
const BLOCK_END = /^\s*(?:#{1,6}\s|Not run[^\n:]*[:：]|Findings\s*[:：])/i
const FENCE = /^\s*```/

// Position, not markup: a step counts only when its first token is a command
// word. Prose that mentions a CLI ("I did not run npm today") and an API call
// (`GET /repos/...`) do not count, while a bare `- npm ci`, a backticked
// command and a `$ <cmd>` line do.
function ranCommand(text) {
  const first = String(text)
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^`+/, '')
    .replace(/^\$\s+/, '')
    .trim()
  return COMMAND_FIRST.test(first)
}

export function hasRan(body) {
  let inRan = false
  let fence = false
  let fenceChecked = false
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (!inRan) {
      const label = RAN_LABEL.exec(line)
      if (label === null) continue
      inRan = true
      if (ranCommand(label[1] ?? '')) return true
      continue
    }
    if (fence) {
      if (FENCE.test(line)) {
        fence = false
        continue
      }
      if (!fenceChecked && line.trim() !== '') {
        fenceChecked = true
        if (ranCommand(line)) return true
      }
      continue
    }
    if (FENCE.test(line)) {
      fence = true
      fenceChecked = false
      continue
    }
    if (BLOCK_END.test(line)) return false
    if (ranCommand(line)) return true
  }
  return false
}

export async function paginate(api, path, maxPages = 4) {
  const out = []
  for (let page = 1; page <= maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?'
    const items = await api(`${path}${sep}per_page=100&page=${page}`)
    out.push(...items)
    if (items.length < 100) break
  }
  return out
}

// The mechanical release is the next minor: read the base branch's package.json
// and add one to the minor. Unreadable or unparsable means no exemption.
async function expectedNextVersion(api, repo, ref) {
  try {
    const file = await api(`/repos/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`)
    const text = Buffer.from(String(file?.content ?? ''), 'base64').toString('utf8')
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(JSON.parse(text)?.version ?? ''))
    if (match === null) return ''
    return `${Number(match[1])}.${Number(match[2]) + 1}.0`
  } catch {
    return ''
  }
}

// `kind` tells a caller why the tip did not pass:
//   pass    - nothing to do
//   verdict - the newest conclusion at the tip does not allow a merge (the case
//             the repair step can repaint at the head SHA)
//   hold    - a maintainer parked the pull request; repainting cannot help
//   error   - the gate could not decide; nothing at the SHA may be re-run
// `now` exists so a test can stand past COMMENT_VERDICT_FALLBACK_UNTIL; the CLI
// never passes it and the date itself is never a parameter.
export async function evaluateGate({ api, repo, policy, prNumber, tier: tierOverride, sha: shaOverride, now = Date.now() }) {
  const failed = (message, kind = 'verdict') => ({ ok: false, kind, message })
  const threw = (cause, prefix) => failed(`${prefix}${cause instanceof Error ? cause.message : String(cause)}`, 'error')

  let pr
  try {
    pr = await api(`/repos/${repo}/pulls/${prNumber}`)
  } catch (cause) {
    return threw(cause, '')
  }
  const headSha = String(shaOverride ?? pr.head?.sha ?? '')
  if (headSha === '') return failed('the pull request has no head SHA', 'error')

  const labels = (pr.labels ?? []).map((label) => label.name)
  if (labels.includes('hold')) return failed('the pull request carries the hold label', 'hold')

  let files
  try {
    files = await paginate(api, `/repos/${repo}/pulls/${prNumber}/files`)
  } catch (cause) {
    return threw(cause, '')
  }
  // The mechanical daily release is the one identity-based exemption from the
  // PASS requirement, and it is honoured here for the same reason it is honoured
  // in risk-gate: otherwise the release PR's own review-gate fails forever on the
  // `package.json` basis and `decideDrive` could never enqueue it. The exemption is
  // earned, not declared: the identity must match *and* the diff must have the
  // shape the release routine writes, or the tier stays what the paths say (T3).
  // The exemption is only for the release this repository's routine writes: the
  // head branch must live in this repository (a fork can call itself release/vX.Y.Z
  // just as easily), and the version must be the next minor the planner computes
  // from the base's package.json, not one the author typed into a branch name.
  const headRepo = String(pr.head?.repo?.full_name ?? '')
  const sameRepo = headRepo !== '' && headRepo.toLowerCase() === String(repo).toLowerCase()
  const identity = sameRepo
    ? mechanicalRelease({ branch: pr.head?.ref, title: pr.title, files: files.map((file) => String(file.filename)) })
    : { mechanical: false, version: '', reason: `${headRepo === '' ? 'the head repository' : headRepo} is not ${repo}` }
  const nextVersion = identity.mechanical ? await expectedNextVersion(api, repo, String(pr.base?.sha ?? '')) : ''
  const versionMatches = identity.mechanical && nextVersion !== '' && identity.version === nextVersion
  const shape = versionMatches
    ? mechanicalDiffShape(files, identity.version)
    : {
        shaped: false,
        reason: identity.mechanical
          ? `the release version v${identity.version} is not the computed next ${nextVersion === '' ? 'of the base branch' : `v${nextVersion}`}`
          : identity.reason,
      }
  const declaredTier = String(tierOverride ?? tierForFiles(files.map((file) => file.filename), loadRules()).tier).toUpperCase()
  const tier = tierOverride === undefined && shape.shaped ? 'T0' : declaredTier
  if (!['T0', 'T1', 'T2', 'T3'].includes(tier)) return failed(`unknown tier ${tier}`, 'error')

  if (tier === 'T0' || tier === 'T1') return { ok: true, kind: 'pass', message: `${tier} at ${headSha.slice(0, 12)} needs no PASS` }

  let comments
  let reviews
  try {
    comments = await paginate(api, `/repos/${repo}/issues/${prNumber}/comments`)
    reviews = await paginate(api, `/repos/${repo}/pulls/${prNumber}/reviews`)
  } catch (cause) {
    return threw(cause, '')
  }

  const candidates = []
  const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR']
  for (const comment of comments) {
    if (!trusted.includes(comment.author_association)) continue
    const parsed = parseConclusion(comment.body)
    if (parsed === null) continue
    candidates.push({
      at: comment.created_at,
      source: 'comment',
      author: comment.user?.login ?? 'unknown',
      association: comment.author_association,
      body: comment.body,
      ...parsed,
    })
  }
  // A review object is a platform fact about who wrote the verdict, so its
  // presence — not its text — decides which identity rule applies below. Reviews
  // from accounts the API does not trust as maintainers do not count as one.
  const reviewObjects = reviews.filter((review) => trusted.includes(review.author_association))
  for (const review of reviewObjects) {
    const parsed = parseConclusion(review.body)
    if (parsed === null) continue
    candidates.push({
      at: review.submitted_at ?? review.created_at,
      source: 'review',
      author: review.user?.login ?? 'unknown',
      association: review.author_association,
      body: review.body,
      ...parsed,
    })
  }
  candidates.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const newest = candidates.at(-1)
  if (newest === undefined) return failed(`no conclusion at ${headSha}; a ${tier} tip needs a PASS`)
  if (!headSha.startsWith(newest.sha)) return failed(`newest conclusion is for ${newest.sha}, but the head is ${headSha}`)

  // Precedence. The review object is the evidence; a comment-shaped verdict is
  // the old shape and may only decide while this pull request has no review
  // object at all, and only before the fallback date. Both miss = fail closed.
  if (newest.source === 'comment') {
    if (reviewObjects.length > 0) {
      return failed('the newest conclusion is an issue comment, but this pull request has a review object; post the verdict as a review so its identity comes from the platform')
    }
    if (!commentVerdictFallbackOpen(now)) {
      return failed(`the comment-shaped verdict path closed on ${COMMENT_VERDICT_FALLBACK_UNTIL.slice(0, 10)}; post the verdict as a review`)
    }
  }

  const writer = writtenBy(newest.body)
  if (writer === '') return failed('the newest conclusion has no Written-by line')
  if (!policy.writers.map((name) => String(name).toLowerCase()).includes(writer.toLowerCase())) return failed(`writer "${writer}" is not in the review policy`)

  const requiredPass = String(policy.requiredPass ?? '').trim()
  if (newest.source === 'review') {
    // `Posted-by:` is not read here at all: the login on the review object is
    // the poster, and `Author:` is a declaration the gate never consults.
    if (requiredPass !== '' && newest.author.toLowerCase() !== requiredPass.toLowerCase()) {
      return failed(`the required PASS must come from a review by ${requiredPass}, not ${newest.author}`)
    }
  } else {
    // Legacy comment path: the poster can only be asserted by the body, so it is
    // checked against the comment's author and the required identity.
    const poster = postedBy(newest.body)
    if (poster === '') return failed('the newest conclusion has no Posted-by line')
    if (poster.toLowerCase() !== newest.author.toLowerCase()) return failed(`Posted-by "${poster}" does not match the poster "${newest.author}"`)
    if (requiredPass !== '' && newest.author.toLowerCase() !== requiredPass.toLowerCase()) return failed(`the required PASS must be posted by ${requiredPass}, not ${newest.author}`)
  }
  if (requiredPass !== '' && writer.toLowerCase() !== requiredPass.toLowerCase()) return failed(`the required PASS identity is ${requiredPass}, not ${writer}`)

  const author = String(pr.user?.login ?? '')
  const selfReview = (policy.selfReview ?? []).map((name) => String(name).toLowerCase())
  const signers = newest.source === 'review' ? [writer, newest.author] : [writer]
  if (author !== '' && signers.some((name) => name.toLowerCase() === author.toLowerCase()) && !selfReview.includes(writer.toLowerCase())) {
    return failed(`the pull request author "${author}" may not PASS its own tip`)
  }

  if (newest.verdict !== 'PASS') return failed(`newest conclusion is ${newest.verdict} at ${newest.sha}`)
  if (!hasRan(newest.body)) return failed('the PASS has no real Ran: command; it is not a conclusion')
  if (!hasNotRun(newest.body)) return failed('the PASS has no Not run: line; it is not a conclusion')
  const where = newest.source === 'review' ? `a review by ${newest.author}` : `a comment by ${newest.author}`
  return { ok: true, kind: 'pass', message: `${tier} PASS at ${headSha.slice(0, 12)} by ${writer} from ${where}` }
}
