// Assemble the daily release state from the API payloads the workflow fetched.
//
// This used to be one `jq` expression in the workflow, and the page shape broke
// it in a way no test could see: `gh api --paginate --slurp` already returns an
// array of pages, `jq -s 'add'` wrapped it once more, and the open pull requests
// became an array of arrays, so selecting `.title` aborted the step before the
// planner ran. Flattening is a function here and is executed by the suite, so the
// shape is pinned instead of being grepped out of YAML.

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
  return {
    lastTag: String(lastTag ?? ''),
    lastTagCommittedAt: String(lastTagCommittedAt ?? ''),
    packageVersion: String(packageVersion ?? ''),
    fragments: Number(fragments ?? 0),
    tags: Array.isArray(tags) ? tags.map(String) : [],
    dryRun: dryRun === true || dryRun === 'true',
    ciOk: latestConclusion(checks, 'ci-ok'),
    openPr: openPrs.find((pr) => String(pr?.title ?? '').startsWith('release: v')) ?? null,
    lastMerged: mergedPrs.at(-1) ?? null,
    mergedPrs,
  }
}
