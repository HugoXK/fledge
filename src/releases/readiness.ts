import { compareVersions, hasTagTriggeredWorkflow, parseVersion, releaseRefusals, type ReleaseRefusalCode } from './release.js'

// #546 slice 1: the read-only answer to "is there anything to release here, and
// if not, why". It reads the repository and never writes: no tag, no Release, no
// token with release scope. The refusal sentences are the ones the tag route
// refuses with, so a maintainer cannot read one reason on this page and a
// different one from `POST /repos/:id/release`.

export interface ReadinessPullRequest {
  number: number
  title: string
  url: string
  labels: string[]
  mergedAt: string
}

export interface ReadinessTag {
  name: string
  sha: string
  committedAt: string
}

export interface ReadinessFacts {
  defaultBranch: string
  headSha: string | null
  latestTag: ReadinessTag | null
  /** Commits from the latest tag to the default branch head, null when unknown. */
  commitsSince: number | null
  mergedSince: ReadinessPullRequest[]
  /** False when the merged list stopped at the page cap while still in range. */
  mergedSinceComplete: boolean
  /** `changelog.d` fragments added or changed since the latest tag. */
  fragments: string[]
  gateOnboarded: boolean
  releaseWorkflow: boolean
}

export interface ReadinessFeature {
  number: number
  title: string
  url: string
  /** Which rule counted it, so a mislabelled pull request stays visible. */
  reason: 'label' | 'title'
}

export interface ReleaseReadinessView {
  defaultBranch: string
  headSha: string | null
  ready: boolean
  refusal: { code: ReleaseRefusalCode; message: string } | null
  latestTag: ReadinessTag | null
  commitsSince: number | null
  mergedPrs: number
  mergedPrsComplete: boolean
  featurePrs: number
  features: ReadinessFeature[]
  fragments: string[]
  changelogFragment: boolean
}

const FEATURE_LABELS = new Set(['enhancement', 'feature'])
// `feat:`, `feat(views):`, `feat!:` — a conventional-commit title is the fallback
// only when no label answers, and the page says which of the two counted it.
const FEATURE_TITLE = /^feat(?:\([^)]*\))?!?:/

export function featureReason(pull: { title: string; labels: string[] }): 'label' | 'title' | null {
  if (pull.labels.some((label) => FEATURE_LABELS.has(label.trim().toLowerCase()))) return 'label'
  return FEATURE_TITLE.test(pull.title.trim()) ? 'title' : null
}

// The three version-independent blockers, in the order the tag route reports
// them. `tag_exists` and `not_higher` are not here on purpose: both need a
// requested version, and this slice answers without one.
export function releaseReadiness(facts: ReadinessFacts): ReleaseReadinessView {
  const refusal =
    !facts.gateOnboarded
      ? { code: 'missing_gate' as const, message: releaseRefusals.missingGate }
      : !facts.releaseWorkflow
        ? { code: 'missing_release_workflow' as const, message: releaseRefusals.missingReleaseWorkflow }
        : facts.latestTag !== null && facts.commitsSince === 0
          ? { code: 'no_new_commits' as const, message: releaseRefusals.noNewCommits(facts.latestTag.name) }
          : null
  const features: ReadinessFeature[] = []
  for (const pull of facts.mergedSince) {
    const reason = featureReason(pull)
    if (reason !== null) features.push({ number: pull.number, title: pull.title, url: pull.url, reason })
  }
  return {
    defaultBranch: facts.defaultBranch,
    headSha: facts.headSha,
    ready: refusal === null,
    refusal,
    latestTag: facts.latestTag,
    commitsSince: facts.commitsSince,
    mergedPrs: facts.mergedSince.length,
    mergedPrsComplete: facts.mergedSinceComplete,
    featurePrs: features.length,
    features,
    fragments: facts.fragments,
    changelogFragment: facts.fragments.length > 0,
  }
}

export interface ReadinessClient {
  getBranch(owner: string, name: string, branch: string): Promise<{ name: string; sha: string } | null>
  listTags(owner: string, name: string): Promise<Array<{ name: string; sha: string }>>
  compareCommits(owner: string, name: string, base: string, head: string): Promise<{ status: string; aheadBy: number }>
  getCommitMeta(owner: string, name: string, ref: string): Promise<{ sha: string; committedAt: string } | null>
  listMergedPullRequestsSince(owner: string, name: string, since: string, maxPages?: number): Promise<{ pulls: ReadinessPullRequest[]; complete: boolean }>
  listDirectory(owner: string, name: string, path: string, ref: string): Promise<Array<{ name: string; type: string; path: string; sha: string }> | null>
  getRepoFile(owner: string, name: string, path: string, ref: string): Promise<string | null>
  getBranchProtection(owner: string, name: string, branch: string): Promise<{ protected: boolean; requiredChecks: string[]; requiredApprovals: number } | null>
}

// The highest SemVer tag reachable from the head is the previous release. Tags
// are walked highest-first so the common case costs one compare, and the walk is
// bounded because a repository can carry hundreds of tags that no longer sit on
// the default branch.
const REACHABILITY_PROBES = 8

type TagLookup =
  | { status: 'found'; tag: { name: string; sha: string }; commitsSince: number }
  | { status: 'none' }
  // The probe budget ran out while versioned tags remained unchecked, so
  // "no previous tag" would be a guess about the tags that were never compared.
  | { status: 'unknown' }

async function latestReachableTag(
  client: ReadinessClient,
  input: { owner: string; name: string; headSha: string },
): Promise<TagLookup> {
  const tags = (await client.listTags(input.owner, input.name))
    .filter((tag) => parseVersion(tag.name) !== null)
    .sort((left, right) => compareVersions(right.name, left.name))
  if (tags.length === 0) return { status: 'none' }
  for (const tag of tags.slice(0, REACHABILITY_PROBES)) {
    const compare = await client.compareCommits(input.owner, input.name, tag.name, input.headSha)
    if (compare.status === 'identical') return { status: 'found', tag, commitsSince: 0 }
    if (compare.status === 'ahead') return { status: 'found', tag, commitsSince: compare.aheadBy }
  }
  return tags.length > REACHABILITY_PROBES ? { status: 'unknown' } : { status: 'none' }
}

// A fragment counts when it is present at the head and was not present with the
// same content at the previous tag, so an edited fragment is still pending work.
async function pendingFragments(
  client: ReadinessClient,
  input: { owner: string; name: string; headSha: string; tag: string | null },
): Promise<string[]> {
  const head = await client.listDirectory(input.owner, input.name, 'changelog.d', input.headSha)
  if (head === null) return []
  const released = input.tag === null ? [] : (await client.listDirectory(input.owner, input.name, 'changelog.d', input.tag)) ?? []
  const seen = new Set(released.map((entry) => `${entry.name}:${entry.sha}`))
  return head
    .filter((entry) => entry.type === 'file' && entry.name.endsWith('.md'))
    .filter((entry) => !seen.has(`${entry.name}:${entry.sha}`))
    .map((entry) => entry.name)
}

export async function readReleaseReadiness(
  client: ReadinessClient,
  input: { owner: string; name: string; defaultBranch: string },
): Promise<ReleaseReadinessView | null> {
  const branch = await client.getBranch(input.owner, input.name, input.defaultBranch)
  // Without the branch there is no head to compare against, and a page that
  // guessed one would be worse than one that says it could not read it.
  if (branch === null) return null
  const previous = await latestReachableTag(client, { owner: input.owner, name: input.name, headSha: branch.sha })
  // An undetermined previous tag is reported as "no answer" rather than as a
  // first release: the tags that were not compared could already point at head.
  if (previous.status === 'unknown') return null
  const meta = previous.status === 'none' ? null : await client.getCommitMeta(input.owner, input.name, previous.tag.name)
  const merged = meta === null
    ? { pulls: [], complete: false }
    : await client.listMergedPullRequestsSince(input.owner, input.name, meta.committedAt)
  const workflow = await client.getRepoFile(input.owner, input.name, '.github/workflows/release.yml', branch.sha)
  const protection = await client.getBranchProtection(input.owner, input.name, input.defaultBranch)
  const known = meta !== null
  return releaseReadiness({
    defaultBranch: input.defaultBranch,
    headSha: branch.sha,
    latestTag: previous.status === 'none' || meta === null ? null : { name: previous.tag.name, sha: previous.tag.sha, committedAt: meta.committedAt },
    commitsSince: previous.status === 'none' ? null : previous.commitsSince,
    mergedSince: merged.pulls,
    // An unknown tag date means the pull-request window could not be bounded, so
    // the count is reported as incomplete rather than as a smaller number.
    mergedSinceComplete: known && merged.complete,
    fragments: await pendingFragments(client, { owner: input.owner, name: input.name, headSha: branch.sha, tag: previous.status === 'found' ? previous.tag.name : null }),
    gateOnboarded: protection !== null && protection.protected && protection.requiredChecks.length > 0,
    releaseWorkflow: workflow !== null && hasTagTriggeredWorkflow(workflow),
  })
}
