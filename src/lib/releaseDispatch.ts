import { nextReleaseVersion } from '../../scripts/lib/release-version.mjs'

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
  aheadCommits: number
  fixes: number
  features: number
  others: number
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

function countKind(message: string): 'fix' | 'feat' | 'other' {
  const first = message.trim().split(/\s+/)[0] ?? ''
  const head = first.replace(/\([^)]*\)/, '')
  if (head.startsWith('fix:')) return 'fix'
  if (head.startsWith('feat:')) return 'feat'
  return 'other'
}

export function countCommitKinds(messages: string[]): { fixes: number; features: number; others: number } {
  let fixes = 0
  let features = 0
  let others = 0
  for (const message of messages) {
    const kind = countKind(message)
    if (kind === 'fix') fixes += 1
    else if (kind === 'feat') features += 1
    else others += 1
  }
  return { fixes, features, others }
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
  const repo = options.repo
  const main = await json<{ sha: string; commit: { committer: { date: string } } }>(options, `/repos/${repo}/commits/main`)
  const mainSha = main.sha
  const mainDate = main.commit.committer.date
  const tagsRaw = await json<Array<{ ref?: string }>>(options, `/repos/${repo}/git/matching-refs/tags/v`)
  const tags = tagsRaw.map((entry) => String(entry.ref ?? '').replace(/^refs\/tags\//, '')).filter((tag) => VERSION.test(tag))
  const latestTag = latestTagOf(tags)
  const latest = latestTag === ''
    ? null
    : await json<{ commit: { committer: { date: string } } }>(options, `/repos/${repo}/commits/${encodeURIComponent(latestTag)}`)
  const latestTagSha = latest === null ? '' : (await json<{ sha: string }>(options, `/repos/${repo}/commits/${encodeURIComponent(latestTag)}`)).sha
  const isRelease = latestTag === ''
  const compare = isRelease
    ? { commits: [] as Array<{ commit: { message: string } }>, total_commits: 0 }
    : await json<{ commits: Array<{ commit: { message: string } }>; total_commits: number }>(options, `/repos/${repo}/compare/${encodeURIComponent(latestTag)}...${encodeURIComponent(mainSha)}`)
  const messages = compare.commits.map((entry) => String(entry.commit.message.split('\n')[0] ?? ''))
  const counts = countCommitKinds(messages)
  const pkg = await json<{ content?: string; encoding?: string }>(options, `/repos/${repo}/contents/package.json?ref=${encodeURIComponent(mainSha)}`)
  const packageVersion = decodePackage(pkg)
  const next = nextReleaseVersion({
    packageVersion,
    lastTagCommittedAt: latest?.commit.committer.date ?? '',
    releaseAt: new Date(options.now ?? Date.now()).toISOString(),
  })
  const nextVersion = next.version
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
  if (counts.features < 5) reasons.push('not-enough-features')
  if (compare.total_commits < 10) reasons.push('not-enough-prs')
  const preview: ReleaseDispatchPreview = {
    repo,
    workflow: options.workflow,
    mainSha,
    mainDate,
    latestTag,
    latestTagSha,
    packageVersion,
    nextVersion,
    aheadCommits: compare.total_commits,
    fixes: counts.fixes,
    features: counts.features,
    others: counts.others,
    fragments,
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
