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

export const REQUIRED_CONTEXT = 'review-gate'

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

export function hasRan(body) {
  const text = String(body ?? '')
  if (/(^|\n)\s*Ran[^\n:]*[:：]\s*(npm|node|npx|docker|git|gh|curl|pnpm|yarn)\b/i.test(text)) return true
  if (/(^|\n)\s*Ran[^\n:]*[:：]\s*\n(?:\s*[-*]\s*|\s*\$ )?.*\b(npm|node|npx|docker|git|gh|curl|pnpm|yarn)\b/i.test(text)) return true
  if (/(^|\n)\s*\$\s+(npm|node|npx|docker|git|gh|curl|pnpm|yarn)\b/i.test(text)) return true
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

// `kind` tells a caller why the tip did not pass:
//   pass    - nothing to do
//   verdict - the newest conclusion at the tip does not allow a merge (the case
//             the repair step can repaint at the head SHA)
//   hold    - a maintainer parked the pull request; repainting cannot help
//   error   - the gate could not decide; nothing at the SHA may be re-run
export async function evaluateGate({ api, repo, policy, prNumber, tier: tierOverride, sha: shaOverride }) {
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
  const tier = String(tierOverride ?? tierForFiles(files.map((file) => file.filename), loadRules()).tier).toUpperCase()
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
  for (const comment of comments) {
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association)) continue
    const parsed = parseConclusion(comment.body)
    if (parsed === null) continue
    candidates.push({
      at: comment.created_at,
      author: comment.user?.login ?? 'unknown',
      association: comment.author_association,
      body: comment.body,
      ...parsed,
    })
  }
  for (const review of reviews) {
    if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(review.author_association)) continue
    const parsed = parseConclusion(review.body)
    if (parsed === null) continue
    candidates.push({
      at: review.submitted_at ?? review.created_at,
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

  const writer = writtenBy(newest.body)
  if (writer === '') return failed('the newest conclusion has no Written-by line')
  if (!policy.writers.map((name) => String(name).toLowerCase()).includes(writer.toLowerCase())) return failed(`writer "${writer}" is not in the review policy`)

  const poster = postedBy(newest.body)
  if (poster === '') return failed('the newest conclusion has no Posted-by line')
  if (poster.toLowerCase() !== newest.author.toLowerCase()) return failed(`Posted-by "${poster}" does not match the poster "${newest.author}"`)

  const requiredPass = String(policy.requiredPass ?? '').trim()
  if (requiredPass !== '') {
    if (writer.toLowerCase() !== requiredPass.toLowerCase()) return failed(`the required PASS identity is ${requiredPass}, not ${writer}`)
    if (newest.author.toLowerCase() !== requiredPass.toLowerCase()) return failed(`the required PASS must be posted by ${requiredPass}, not ${newest.author}`)
  }

  const author = String(pr.user?.login ?? '')
  const selfReview = (policy.selfReview ?? []).map((name) => String(name).toLowerCase())
  if (author !== '' && writer.toLowerCase() === author.toLowerCase() && !selfReview.includes(writer.toLowerCase())) {
    return failed(`the pull request author "${author}" may not PASS its own tip`)
  }

  if (newest.verdict !== 'PASS') return failed(`newest conclusion is ${newest.verdict} at ${newest.sha}`)
  if (!hasRan(newest.body)) return failed('the PASS has no real Ran: command; it is not a conclusion')
  if (!hasNotRun(newest.body)) return failed('the PASS has no Not run: line; it is not a conclusion')
  return { ok: true, kind: 'pass', message: `${tier} PASS at ${headSha.slice(0, 12)} by ${writer}, posted by ${poster}` }
}
