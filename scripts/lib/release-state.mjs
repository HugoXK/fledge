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

export function buildState({ lastTag, lastTagCommittedAt, packageVersion, fragments, tags, dryRun, closedPages, openPages, checks }) {
  const mergedPrs = flattenPages(closedPages)
    .filter((pr) => pr?.merged_at !== null && pr?.merged_at !== undefined)
    .sort((a, b) => mergedAt(a) - mergedAt(b))
  const openPrs = flattenPages(openPages)
  // A PR whose title merely starts with `release: v` is not the release PR. The
  // release routine writes a `release/vX.Y.Z` branch with a matching title, so a
  // docs-only `release: v9.9.9` on a feature branch must not be auto-merged; the
  // path set is checked again in the drive, which has the file list.
  const candidate = openPrs.find((pr) => String(pr?.title ?? '').startsWith('release: v')) ?? null
  // A release branch and title can be declared from a fork as easily as from this
  // repository, so the candidate must also be a head in the base repository.
  const headRepo = String(candidate?.head?.repo?.full_name ?? '')
  const sameRepo = candidate !== null && headRepo !== '' && headRepo === String(candidate?.base?.repo?.full_name ?? '')
  const identity = candidate === null || !sameRepo ? null : releaseIdentity({ branch: candidate?.head?.ref, title: candidate?.title })
  return {
    lastTag: String(lastTag ?? ''),
    lastTagCommittedAt: String(lastTagCommittedAt ?? ''),
    packageVersion: String(packageVersion ?? ''),
    fragments: Number(fragments ?? 0),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    dryRun: dryRun === true || dryRun === 'true',
    ciOk: latestConclusion(checks, 'ci-ok'),
    openPr: identity === null ? null : candidate,
    openPrRejected: candidate !== null && identity === null
      ? { number: Number(candidate?.number ?? 0), title: String(candidate?.title ?? ''), branch: String(candidate?.head?.ref ?? '') }
      : null,
    lastMerged: mergedPrs.at(-1) ?? null,
    mergedPrs,
  }
}
