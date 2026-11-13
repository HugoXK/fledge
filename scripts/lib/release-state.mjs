// Assemble the daily release state from the API payloads the workflow fetched.
//
// This used to be one `jq` expression in the workflow, and the page shape broke
// it in a way no test could see: `gh api --paginate --slurp` already returns an
// array of pages, `jq -s 'add'` wrapped it once more, and the open pull requests
// became an array of arrays, so selecting `.title` aborted the step before the
// planner ran. Flattening is a function here and is executed by the suite, so the
// shape is pinned instead of being grepped out of YAML.

import { releaseIdentity } from './mechanical-release.mjs'

export function flattenPages(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    if (Array.isArray(entry)) out.push(...flattenPages(entry))
    else if (entry !== null && typeof entry === 'object') out.push(entry)
  }
  return out
}

// `GET /commits/{sha}/check-runs` answers `{ total_count, check_runs }`, while the
// page fixtures and `--slurp` payloads are arrays; both shapes are accepted so a
// caller cannot silently read zero runs.
export function checkRunsOf(value) {
  if (Array.isArray(value)) return flattenPages(value)
  const list = value?.check_runs
  return Array.isArray(list) ? flattenPages(list) : []
}

// The newest run by id, not the first in the list: `first` read the oldest run of
// that name, which after a re-run is a stale conclusion.
export function latestConclusion(value, name) {
  const runs = checkRunsOf(value).filter((run) => String(run?.name ?? '') === name)
  if (runs.length === 0) return 'missing'
  const newest = runs.reduce((best, run) => (Number(run?.id ?? 0) >= Number(best?.id ?? 0) ? run : best))
  return String(newest?.conclusion ?? 'missing')
}

function mergedAt(pr) {
  const parsed = Date.parse(String(pr?.merged_at ?? ''))
  return Number.isNaN(parsed) ? 0 : parsed
}

export function buildState({ lastTag, lastTagCommittedAt, packageVersion, fragments, tags, dryRun, closedPages, openPages, checks, branches }) {
  const mergedPrs = flattenPages(closedPages)
    .filter((pr) => pr?.merged_at !== null && pr?.merged_at !== undefined)
    .sort((a, b) => mergedAt(a) - mergedAt(b))
  const openPrs = flattenPages(openPages)
  // A PR whose title merely starts with `release: v` is not the release PR. The
  // release routine writes a `release/vX.Y.Z` branch with a matching title, so a
  // docs-only `release: v9.9.9` on a feature branch must not be auto-merged; the
  // path set is checked again in the drive, which has the file list.
  //
  // The same-repo test is part of the predicate, not a filter applied afterwards:
  // `GET /pulls?state=open` lists newest first, so a fork PR titled `release: v…`
  // found after the fact took the slot and demoted this repository's own release
  // PR to a rejected candidate, which then made the whole night a no-op.
  const titleMatched = openPrs.filter((pr) => String(pr?.title ?? '').startsWith('release: v'))
  const isSameRepo = (pr) => {
    const head = String(pr?.head?.repo?.full_name ?? '')
    return head !== '' && head === String(pr?.base?.repo?.full_name ?? '')
  }
  const accepted = (pr) => isSameRepo(pr) && releaseIdentity({ branch: pr?.head?.ref, title: pr?.title }) !== null
  const candidate = titleMatched.find(accepted) ?? null
  const rejected = titleMatched.find((pr) => !accepted(pr)) ?? null

  // A `release/v<version>` branch that no pull request in any state and no tag
  // accounts for is an orphan: a run pushed it and then could not open the pull
  // request (`#333`), so every later run refuses to overwrite it and the slot is
  // wedged. The classification is here because this is where the branches, the
  // pull requests and the tags meet; the repair is the owner's, never a run's.
  // A pull request only accounts for a branch of this repository: a fork PR whose
  // head happened to be named `release/v0.3.2` used to clear the orphan and send
  // the night back to the generic "different content" red. The same-repo
  // predicate is the one the release candidate takes above.
  const tagNames = Array.isArray(tags) ? tags.map(String) : []
  const closedPrs = flattenPages(closedPages)
  const pullRequestHeads = new Set(
    [...openPrs, ...closedPrs].filter(isSameRepo).map((pr) => String(pr?.head?.ref ?? '')).filter((ref) => ref !== ''),
  )
  const releaseBranches = (Array.isArray(branches) ? branches : [])
    .map((entry) => {
      const name = String(typeof entry === 'string' ? entry : entry?.name ?? '')
      const sha = String(typeof entry === 'string' ? '' : entry?.commit?.sha ?? entry?.sha ?? '')
      const match = /^release\/v(\d+\.\d+\.\d+)$/.exec(name)
      return match === null ? null : { branch: name, version: match[1], tag: `v${match[1]}`, sha }
    })
    .filter((entry) => entry !== null)
    .filter((entry) => !pullRequestHeads.has(entry.branch) && !tagNames.includes(entry.tag))
  return {
    lastTag: String(lastTag ?? ''),
    lastTagCommittedAt: String(lastTagCommittedAt ?? ''),
    packageVersion: String(packageVersion ?? ''),
    fragments: Number(fragments ?? 0),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    dryRun: dryRun === true || dryRun === 'true',
    ciOk: latestConclusion(checks, 'ci-ok'),
    openPr: candidate,
    openPrRejected: rejected === null
      ? null
      : {
          number: Number(rejected?.number ?? 0),
          title: String(rejected?.title ?? ''),
          branch: String(rejected?.head?.ref ?? ''),
          repo: String(rejected?.head?.repo?.full_name ?? ''),
        },
    lastMerged: mergedPrs.at(-1) ?? null,
    mergedPrs,
    orphanBranches: releaseBranches,
  }
}

// The planner input is a projection of the state, and the projection is where the
// night used to stop: `openPrRejected != null` was fed to the planner as
// `openReleasePr: true`, so one outsider PR titled `release: v…` made every night
// return `open-release-pr` — no error, no PR, no release. The planner is told only
// about the accepted candidate; a rejected one is a notice the workflow writes to
// its summary.
export function plannerInput(state) {
  const merged = Array.isArray(state?.mergedPrs) ? state.mergedPrs : []
  return {
    lastTag: String(state?.lastTag ?? ''),
    packageVersion: String(state?.packageVersion ?? ''),
    prs: merged.map((pr) => ({
      number: Number(pr?.number ?? 0),
      title: String(pr?.title ?? ''),
      labels: (Array.isArray(pr?.labels) ? pr.labels : []).map((label) => String(label?.name ?? '')),
      mergedAt: String(pr?.merged_at ?? pr?.mergedAt ?? ''),
    })),
    // The count, not a sentinel: `['fragment']` made every night report one
    // fragment whatever `changelog.d/` held, so the summary and the release body
    // both printed `changelog fragments: 1`.
    fragments: Number(state?.fragments ?? 0),
    openReleasePr: state?.openPr !== null && state?.openPr !== undefined,
    existingTags: Array.isArray(state?.tags) ? state.tags.map(String) : [],
    lastTagCommittedAt: String(state?.lastTagCommittedAt ?? ''),
  }
}
