import { MIN_FEATURES, MIN_PRS, planRelease } from '../../scripts/release-plan.mjs'
import type { ReleasePlanPr } from '../../scripts/release-plan.mjs'

// #897: the superadmin release action is a preview plus a dispatch. It never
// creates a tag, merges a pull request or deploys: the existing release
// workflow does that under its normal gates. The only write in this module is
// the workflow_dispatch call.

export interface ReleaseDispatchPreview {
  repo: string
  workflow: string
  mainSha: string
  mainDate: string
  latestTag: string
  latestTagSha: string
  packageVersion: string
  nextVersion: string
  /** Merged pull requests since the last tag, as `planRelease` counts them. */
  aheadMerges: number
  /** Feature merges by the planner's rule: `feat:`/`feature:` title or `enhancement`. */
  features: number
  fragments: number
  ciOk: string
  openReleasePr: { number: number; title: string; headSha: string; branch: string; url: string } | null
  tagExists: boolean
  branchExists: boolean
  eligible: boolean
  reason: string
}

export interface ReleaseDispatchResult {
  ok: boolean
  runUrl: string
}

export interface ReleaseDispatchOptions {
  fetch: typeof globalThis.fetch
  token: string
  repo: string
  workflow: string
  ref: string
  apiBase?: string
  now?: number
}

const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/

// #984: the dispatch names a ref, and GitHub runs the workflow file as it exists
// at that ref — with that run's secrets and write scopes. The preview already
// reads `main` and nothing else, so `main` is the only ref this action can mean;
// anything else is a configuration error, refused before the first request
// rather than run with the repository's privileges.
const DEFAULT_BRANCH = 'main'
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const WORKFLOW_FILE = /^[A-Za-z0-9._-]+\.yml$/

function assertDispatchSettings(options: ReleaseDispatchOptions): void {
  if (!REPOSITORY.test(options.repo)) throw new Error(`RELEASE_DISPATCH_REPO is not owner/name: ${options.repo}`)
  if (!WORKFLOW_FILE.test(options.workflow)) throw new Error(`RELEASE_DISPATCH_WORKFLOW is not a workflow file: ${options.workflow}`)
  if (options.ref !== DEFAULT_BRANCH) throw new Error(`RELEASE_DISPATCH_REF is not the default branch: ${options.ref}`)
}

function compareVersions(left: string, right: string): number {
  const a = VERSION.exec(left)
  const b = VERSION.exec(right)
  if (a === null || b === null) return left.localeCompare(right)
  for (let index = 1; index <= 3; index += 1) {
    const delta = Number(a[index] ?? 0) - Number(b[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

export function latestTagOf(tags: string[]): string {
  const versions = tags.filter((tag) => VERSION.test(tag)).sort(compareVersions)
  return versions.at(-1) ?? ''
}

function api(options: ReleaseDispatchOptions, path: string): Promise<Response> {
  return options.fetch(`${options.apiBase ?? 'https://api.github.com'}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${options.token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-release-dispatch',
    },
    signal: AbortSignal.timeout(15_000),
  })
}

// A repo-scoped token minted with only Actions: write can dispatch the workflow
// but cannot read any of the preview endpoints, so it answers 403 on the first
// call. The bare status left the operator guessing which permission to add, and
// pointing at this list keeps the message and the docs saying the same thing.
const READ_SCOPES: Array<[RegExp, string]> = [
  [/\/check-runs/, 'Checks: read'],
  [/\/pulls/, 'Pull requests: read'],
  [/\/contents\//, 'Contents: read'],
  [/\/git\/matching-refs/, 'Contents: read'],
  [/\/git\/ref\//, 'Contents: read'],
  [/\/compare\//, 'Contents: read'],
  [/\/commits\//, 'Contents: read'],
]

export function readScopeFor(path: string): string {
  return READ_SCOPES.find(([pattern]) => pattern.test(path))?.[1] ?? 'Contents: read'
}

function refused(options: ReleaseDispatchOptions, status: number, path: string): Error {
  if (status !== 403) return new Error(`GitHub ${String(status)} ${path}`)
  return new Error(`GitHub 403 on ${path}: RELEASE_DISPATCH_TOKEN needs ${readScopeFor(path)} on ${options.repo}.`)
}

async function json<T>(options: ReleaseDispatchOptions, path: string): Promise<T> {
  const response = await api(options, path)
  if (!response.ok) throw refused(options, response.status, path)
  return (await response.json()) as T
}

async function optional<T>(options: ReleaseDispatchOptions, path: string): Promise<T | null> {
  const response = await api(options, path)
  if (response.status === 404) return null
  if (!response.ok) throw refused(options, response.status, path)
  return (await response.json()) as T
}

const PULL_PAGE_SIZE = 100
// The rule counts merged pull requests since the last tag, and the nightly run
// reads the same listing with `--paginate`. A release window is days old, so
// three pages hold far more merges than one window can; an unbounded walk would
// turn a page render into dozens of requests, and stopping short only refuses a
// release the night might make, which is the safe direction.
const MAX_PULL_PAGES = 3

async function mergedPulls(options: ReleaseDispatchOptions, repo: string): Promise<ReleasePlanPr[]> {
  const out: ReleasePlanPr[] = []
  for (let page = 1; page <= MAX_PULL_PAGES; page += 1) {
    const batch = await json<Array<{ number?: number; title?: string; labels?: Array<{ name?: string }>; merged_at?: string | null }>>(
      options,
      `/repos/${repo}/pulls?state=closed&per_page=${String(PULL_PAGE_SIZE)}&sort=updated&direction=desc&page=${String(page)}`,
    )
    for (const pr of batch) {
      if (typeof pr.merged_at !== 'string' || pr.merged_at === '') continue
      out.push({
        number: Number(pr.number ?? 0),
        title: String(pr.title ?? ''),
        labels: (Array.isArray(pr.labels) ? pr.labels : []).map((label) => String(label?.name ?? '')),
        mergedAt: pr.merged_at,
      })
    }
    if (batch.length < PULL_PAGE_SIZE) break
  }
  return out
}

function decodePackage(content: { content?: string; encoding?: string }): string {
  if (content.encoding !== 'base64' || typeof content.content !== 'string') return ''
  try {
    const parsed = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}

export async function previewRelease(options: ReleaseDispatchOptions): Promise<ReleaseDispatchPreview> {
  assertDispatchSettings(options)
  const repo = options.repo
  const main = await json<{ sha: string; commit: { committer: { date: string } } }>(options, `/repos/${repo}/commits/main`)
  const mainSha = main.sha
  const mainDate = main.commit.committer.date
  const tagsRaw = await json<Array<{ ref?: string }>>(options, `/repos/${repo}/git/matching-refs/tags/v`)
  const tags = tagsRaw.map((entry) => String(entry.ref ?? '').replace(/^refs\/tags\//, '')).filter((tag) => VERSION.test(tag))
  const latestTag = latestTagOf(tags)
  const latest = latestTag === ''
    ? null
    : await json<{ sha?: string; commit: { committer: { date: string } } }>(options, `/repos/${repo}/commits/${encodeURIComponent(latestTag)}`)
  const latestTagSha = latest === null ? '' : String(latest.sha ?? '')
  const latestTagCommittedAt = latest?.commit.committer.date ?? ''
  const isRelease = latestTag === ''
  const pkg = await json<{ content?: string; encoding?: string }>(options, `/repos/${repo}/contents/package.json?ref=${encodeURIComponent(mainSha)}`)
  const packageVersion = decodePackage(pkg)
  const fragmentsRaw = await json<Array<{ name?: string; type?: string }> | { message?: string }>(options, `/repos/${repo}/contents/changelog.d?ref=${encodeURIComponent(mainSha)}`)
  const fragments = Array.isArray(fragmentsRaw)
    ? fragmentsRaw.filter((entry) => entry.type === 'file' && String(entry.name ?? '').endsWith('.md') && String(entry.name ?? '').toLowerCase() !== 'readme.md').length
    : 0
  const checks = await json<{ check_runs?: Array<{ id?: number; name?: string; conclusion?: string | null; status?: string }> }>(options, `/repos/${repo}/commits/${encodeURIComponent(mainSha)}/check-runs?per_page=100&check_name=ci-ok`)
  const ciRuns = (checks.check_runs ?? []).filter((run) => run.name === 'ci-ok')
  const ciOk = ciRuns.length === 0
    ? 'missing'
    : String(ciRuns.reduce((best, run) => (Number(run.id ?? 0) >= Number(best.id ?? 0) ? run : best)).conclusion ?? 'missing')
  const pulls = await json<Array<{ number?: number; title?: string; html_url?: string; head?: { sha?: string; ref?: string } }>>(options, `/repos/${repo}/pulls?state=open&per_page=100`)
  const openReleasePr = pulls.find((pr) => String(pr.title ?? '').startsWith('release: v') || String(pr.head?.ref ?? '').startsWith('release/v'))
  // The rule is `planRelease`, the function the nightly workflow calls: a feature
  // is a merged pull request whose title is `feat:`/`feature:` or which carries
  // `enhancement`, and the merge count is merged pull requests since the tag. The
  // preview used to count commit messages of its own, so `feature: …` was not a
  // feature and the label was never read: the button could refuse a release the
  // night would make, and it printed numbers that were not the rule's (#985).
  const plan = planRelease({
    lastTag: latestTag,
    packageVersion,
    prs: await mergedPulls(options, repo),
    fragments,
    openReleasePr: openReleasePr !== undefined,
    existingTags: tags,
    lastTagCommittedAt: latestTagCommittedAt,
    releaseAt: new Date(options.now ?? Date.now()).toISOString(),
  })
  const nextVersion = plan.nextVersion
  const tagName = nextVersion === '' ? '' : `v${nextVersion}`
  const tagExists = tagName !== '' && tags.includes(tagName)
  const branchExists = nextVersion === '' ? false : (await optional<{ ref?: string }>(options, `/repos/${repo}/git/ref/heads/release/v${encodeURIComponent(nextVersion)}`)) !== null
  const reasons: string[] = []
  if (options.token === '') reasons.push('dispatch-token-missing')
  if (packageVersion === '') reasons.push('package-version-unreadable')
  if (nextVersion === '') reasons.push('next-version-unreadable')
  if (packageVersion !== '' && latestTag !== '' && packageVersion !== latestTag.slice(1)) reasons.push('version-tag-mismatch')
  if (ciOk !== 'success') reasons.push(`ci-ok-${ciOk}`)
  if (openReleasePr !== undefined) reasons.push('open-release-pr')
  if (tagExists) reasons.push('tag-exists')
  if (branchExists) reasons.push('release-branch-exists')
  if (fragments === 0) reasons.push('no-fragments')
  if (isRelease) reasons.push('main-is-release')
  // The thresholds are the planner's own exports and the numbers are its output,
  // so both count gates can be named at once instead of only the first one.
  if (plan.features < MIN_FEATURES) reasons.push('not-enough-features')
  if (plan.total < MIN_PRS) reasons.push('not-enough-prs')
  // The preview adds gates on top of the rule and must never relax it: if the
  // planner refuses for a reason this list did not name, the refusal stands.
  if (reasons.length === 0 && !plan.shouldRelease) {
    const token = plan.reason.split('; ')[0] ?? ''
    if (token !== '') reasons.push(token)
  }
  const preview: ReleaseDispatchPreview = {
    repo,
    workflow: options.workflow,
    mainSha,
    mainDate,
    latestTag,
    latestTagSha,
    packageVersion,
    nextVersion,
    aheadMerges: plan.total,
    features: plan.features,
    fragments: plan.fragments,
    ciOk,
    openReleasePr: openReleasePr === undefined
      ? null
      : {
          number: Number(openReleasePr.number ?? 0),
          title: String(openReleasePr.title ?? ''),
          headSha: String(openReleasePr.head?.sha ?? ''),
          branch: String(openReleasePr.head?.ref ?? ''),
          url: String(openReleasePr.html_url ?? ''),
        },
    tagExists,
    branchExists,
    eligible: reasons.length === 0,
    reason: reasons.join('; '),
  }
  return preview
}

// The POST path fetches the complete preview itself, so a stale button cannot
// dispatch a release that the live state no longer allows.
export async function previewAndDispatch(options: ReleaseDispatchOptions): Promise<{ preview: ReleaseDispatchPreview; result: ReleaseDispatchResult }> {
  const preview = await previewRelease(options)
  if (!preview.eligible) throw new Error(`release preview refused: ${preview.reason}`)
  const response = await options.fetch(`${options.apiBase ?? 'https://api.github.com'}/repos/${options.repo}/actions/workflows/${encodeURIComponent(options.workflow)}/dispatches`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-release-dispatch',
    },
    body: JSON.stringify({ ref: options.ref, inputs: { dry_run: 'false' } }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub ${String(response.status)} dispatch ${options.workflow}`)
  return {
    preview,
    result: {
      ok: true,
      runUrl: `https://github.com/${options.repo}/actions/workflows/${options.workflow}`,
    },
  }
}
