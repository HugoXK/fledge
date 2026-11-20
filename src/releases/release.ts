import { GithubError } from '../repos/github.js'

// Release management for a hosted repository: a maintainer supplies the version
// and confirms the commit, Fledge refuses when the request cannot be honoured,
// and only then creates an annotated tag. A version is never guessed, a tag is
// never moved or deleted, and nothing here publishes a Release — that stays a
// human action in GitHub.
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
  build: string
}

// Strict SemVer 2.0.0 with an optional `v` prefix. Anchored on purpose: a lenient
// pattern here would accept `release-1.2.3` and then write that as a tag.
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function parseVersion(text: string): ParsedVersion | null {
  const match = SEMVER.exec(text.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: (match[4] ?? '').split('.').filter((part) => part !== ''),
    build: match[5] ?? '',
  }
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

// SemVer precedence: build metadata is ignored, and a prerelease sorts below the
// release it leads to.
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) throw new Error(`not a SemVer version: ${a === null ? left : right}`)
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (a[field] !== b[field]) return a[field] - b[field]
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const diff = compareIdentifier(leftPart, rightPart)
    if (diff !== 0) return diff
  }
  return 0
}

// The refusal path needs a concrete next version, not advice: a prerelease is
// promoted to its release, and a release moves its patch.
export function suggestHigher(version: string): string {
  const parsed = parseVersion(version)
  if (parsed === null) return ''
  const core = `v${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.prerelease.length > 0 ? core : `v${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

export interface ReleaseTag {
  name: string
  sha: string
  /** Commits from this tag to the target, or null when it is not an ancestor. */
  targetCommitsAhead: number | null
}

// The refusal sentences a maintainer reads. They live here, not at each call
// site, because the read-only release-readiness page (#546) has to print exactly
// what `POST /repos/:id/release` would refuse with; a second copy would drift.
export const releaseRefusals = {
  missingGate: 'the default branch is not protected by required checks, so this repository is not onboarded to a gate',
  missingReleaseWorkflow: 'the repository has no tag-triggered .github/workflows/release.yml',
  noNewCommits: (tag: string): string => `nothing to release: ${tag} already points at the target commit`,
  // #546 slice 2: a form carries the head it was rendered with. If the branch
  // moved in between, tagging the confirmed commit would release a tree the
  // maintainer never looked at on that page, and a tag cannot be moved after.
  branchMoved: (shown: string, now: string): string => `the default branch moved since this page was read: the page showed ${shown} and the branch head is now ${now}; nothing was tagged, because a tag is never moved or deleted. Re-read the readiness page and confirm the new head`,
  // The installation token is what writes the tag. Without Contents: write the
  // write is refused before anything exists, and the operator needs the name of
  // the permission rather than the upstream sentence GitHub returns.
  // #893: a tag is a ref write, and pushing it runs the workflows committed in
  // the tagged tree. A target the default branch never contained would make
  // "this release was built from this repository at this commit" uncheckable, so
  // ancestry is proven before anything is written. The status is the one
  // `compare/{defaultBranch}...{target}` reports, where `ahead` means the target
  // holds commits the default branch does not — the unmerged branch refused here.
  targetNotOnDefault: (sha: string, branch: string, status: string): string => `${sha} is ${status === 'ahead' ? 'ahead of' : 'not contained in'} the default branch ${branch}; nothing was tagged, because a release is cut from a commit the default branch contains`,
  ancestryUnreadable: (branch: string): string => `the default branch ${branch} could not be compared with the target commit; nothing was tagged, because ancestry is required before a ref write`,
  // #946: every tag is newer than the target, so the walk finds no previous
  // release and the first-release branch used to take it — a repository that
  // already shipped v1.20.0 would accept v0.5.0 as "the first release". There is
  // a previous release here; it is simply not an ancestor of this commit.
  targetBeforeReleases: (sha: string, tag: string): string => `${sha} predates every release tag in this repository (the newest is ${tag}); nothing was tagged, because a repository that already has releases cannot declare a first release`,
  tagScopeMissing: (status: number): string => status === 404
    // A 404 does not prove a missing permission: it also means the App cannot see
    // the repository any more. Both causes are named, neither is asserted.
    ? 'the GitHub App installation cannot see this repository when writing the tag (HTTP 404); check that the App is still installed here and has Contents: write. Nothing was moved or deleted'
    : `the GitHub App installation cannot write tags on this repository (HTTP ${status}); it needs Contents: write. Nothing was moved or deleted`,
}

export interface ReleasePlanInput {
  requestedVersion: string
  targetSha: string
  tags: ReleaseTag[]
  tagExists: boolean
  releaseWorkflow: boolean
  gateOnboarded: boolean
}

export type ReleaseRefusalCode =
  | 'invalid_version'
  | 'target_missing'
  // #893: the target exists but the default branch does not contain it, or the
  // ancestry compare could not be read (fail closed).
  | 'target_not_on_default'
  | 'ancestry_unreadable'
  // #946: the target predates every release tag, so it is not a first release.
  | 'target_before_releases'
  | 'missing_gate'
  | 'missing_release_workflow'
  | 'tag_exists'
  | 'no_new_commits'
  | 'not_higher'

export type ReleasePlan =
  | { ok: true; version: string; tagName: string; targetSha: string; prerelease: boolean; previousTag: string | null; commitsAfter: number | null; message: string }
  | { ok: false; code: ReleaseRefusalCode; message: string; suggestion?: string }

function normalize(text: string): string {
  return text.trim().startsWith('v') ? text.trim() : `v${text.trim()}`
}

// Every check here runs before the caller writes anything, so a refusal can never
// leave a half-created tag behind. The order is the order of the report a
// maintainer reads: the repository is ready, the tag is free, there is something
// to release, and the version is higher than what already shipped.
export function planRelease(input: ReleasePlanInput): ReleasePlan {
  const version = normalize(input.requestedVersion)
  if (parseVersion(version) === null) {
    return { ok: false, code: 'invalid_version', message: `${input.requestedVersion} is not a SemVer version (expected v1.2.3 or v1.2.3-beta.1)` }
  }
  if (!input.gateOnboarded) {
    return { ok: false, code: 'missing_gate', message: releaseRefusals.missingGate }
  }
  if (!input.releaseWorkflow) {
    return { ok: false, code: 'missing_release_workflow', message: releaseRefusals.missingReleaseWorkflow }
  }
  if (input.tagExists) {
    return { ok: false, code: 'tag_exists', message: `tag ${version} already exists; a tag is never moved or deleted` }
  }
  const reachable = input.tags
    .filter((tag) => tag.targetCommitsAhead !== null && parseVersion(tag.name) !== null)
    .sort((left, right) => compareVersions(right.name, left.name))
  const previous = reachable[0]
  if (previous !== undefined) {
    if (previous.targetCommitsAhead === 0) {
      return { ok: false, code: 'no_new_commits', message: releaseRefusals.noNewCommits(previous.name) }
    }
    if (compareVersions(version, previous.name) <= 0) {
      return { ok: false, code: 'not_higher', message: `${version} is not higher than ${previous.name}`, suggestion: suggestHigher(previous.name) }
    }
  }
  return {
    ok: true,
    version,
    tagName: version,
    targetSha: input.targetSha,
    prerelease: (parseVersion(version)?.prerelease.length ?? 0) > 0,
    previousTag: previous?.name ?? null,
    commitsAfter: previous?.targetCommitsAhead ?? null,
    message: `Fledge release ${version}`,
  }
}

export interface ReleaseGithubClient {
  createAnnotatedTag(owner: string, name: string, input: { tag: string; target: string; message: string }): Promise<{ sha: string }>
  createTagRef(owner: string, name: string, input: { ref: string; sha: string }): Promise<{ ok: true } | { ok: false; status: number; message: string }>
}

export type TagCreation =
  | { ok: true; tagObjectSha: string; ref: string }
  // `status` travels with the refusal so a caller can name the cause: a 403/404 is
  // a missing permission, not a refused name, and the page says which.
  | { ok: false; code: 'tag_exists' | 'tag_ref_failed' | 'tag_scope_missing' | 'target_missing'; status: number; message: string }

// The tag object is written first and the ref second, because the ref is what
// makes the tag visible and fires the repository's release workflow. A 422 on the
// ref is the one race that matters: someone else created the tag between the
// preflight and this call, and the answer is a refusal, never an update.
export async function createAnnotatedTag(
  client: ReleaseGithubClient,
  input: { owner: string; name: string; plan: Extract<ReleasePlan, { ok: true }> },
): Promise<TagCreation> {
  let tag: { sha: string }
  try {
    tag = await client.createAnnotatedTag(input.owner, input.name, {
      tag: input.plan.tagName,
      target: input.plan.targetSha,
      message: input.plan.message,
    })
  } catch (error) {
    // `POST /git/tags` answers 422 when the object does not exist in the
    // repository: a mistyped SHA, or a commit force-pushed away between the
    // preflight and this write. The route validated only that the input is 40
    // hex characters, so this is a refusal the page can explain, never a crash.
    if (error instanceof GithubError && error.status === 422) {
      return { ok: false, code: 'target_missing', status: error.status, message: `${input.plan.targetSha} is not a commit in this repository` }
    }
    throw error
  }
  const ref = `refs/tags/${input.plan.tagName}`
  const created = await client.createTagRef(input.owner, input.name, { ref, sha: tag.sha })
  if (created.ok) return { ok: true, tagObjectSha: tag.sha, ref }
  if (created.status === 422) {
    return { ok: false, code: 'tag_exists', status: created.status, message: `tag ${input.plan.tagName} already exists; nothing was moved or deleted` }
  }
  // A 403/404 from the ref write is the installation not being allowed to write
  // the ref — a permission the operator can grant — so it is named rather than
  // reported as a generic refusal. GitHub's own text never reaches the page.
  if (created.status === 403 || created.status === 404) {
    return { ok: false, code: 'tag_scope_missing', status: created.status, message: releaseRefusals.tagScopeMissing(created.status) }
  }
  return { ok: false, code: 'tag_ref_failed', status: created.status, message: `the tag reference was refused by GitHub (HTTP ${created.status}); nothing was moved or deleted` }
}

// The workflow text is read, never executed. A `tags:` key inside the `on:` block
// is what makes the repository's own release run fire when the tag lands; a
// `tags:` anywhere else (a filter on another event, a matrix value) does not.
// A flow mapping such as `{ push: { tags: ['v*'] } }`, split at its top level so
// a nested `tags` under another event never reads as a push filter.
function flowEntries(text: string): Map<string, string> {
  const inner = text.trim().replace(/^\{/, '').replace(/\}$/, '')
  const entries = new Map<string, string>()
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of inner) {
    if (char === '{' || char === '[') depth += 1
    if (char === '}' || char === ']') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  for (const part of parts) {
    const match = /^\s*(['"]?)([A-Za-z0-9_-]+)\1\s*:\s*([\s\S]*)$/.exec(part)
    if (match !== null) entries.set(match[2] ?? '', (match[3] ?? '').trim())
  }
  return entries
}

// Only the push event answers this question: a tag push is a push. A `tags:`
// key under another event (`workflow_dispatch.inputs.tags`) is a field name, and
// reading it as a trigger is the expensive mistake — it writes an irreversible
// tag whose release workflow never runs.
function inlineOnFiresOnTagPush(inline: string): boolean {
  const value = inline.trim()
  if (value.startsWith('{')) {
    const events = flowEntries(value)
    if (!events.has('push')) return false
    const filter = (events.get('push') ?? '').trim()
    if (filter === '' || filter === '{}' || filter === 'null' || filter === '~') return true
    if (filter.startsWith('{')) return flowEntries(filter).has('tags')
    return false
  }
  return /^['"]?push['"]?$/.test(value)
}

// The workflow text is read, never executed. A `tags:` filter directly under the
// `push:` event is what makes the repository's own release run fire when the tag
// lands; the same key in a later block, deeper than one level, or under another
// event does not.
export function hasTagTriggeredWorkflow(text: string): boolean {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^on\s*:/.test(line))
  if (start === -1) return false
  const inline = (lines[start] ?? '').replace(/^on\s*:/, '').trim()
  if (inline !== '') return inlineOnFiresOnTagPush(inline)

  // The event key sits at the block's own indentation and its filters sit exactly
  // one level deeper. The depth is read from the block instead of assumed to be
  // two spaces, so a four-space workflow reads the same as a two-space one.
  let eventIndent: number | null = null
  let event: string | null = null
  let filterIndent: number | null = null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const width = /^( *)/.exec(line)?.[1]?.length ?? 0
    if (eventIndent === null) {
      if (width === 0) return false
      eventIndent = width
    }
    if (width < eventIndent) break
    const key = /^\s*(?:-\s*)?['"]?([A-Za-z0-9_-]+)['"]?\s*:/.exec(line)?.[1] ?? null
    if (width === eventIndent) {
      const rest = line.replace(/^\s*(?:-\s*)?['"]?[A-Za-z0-9_-]+['"]?\s*:/, '').trim()
      if (key === 'push' && rest.startsWith('{')) return flowEntries(rest).has('tags')
      // A bare `push:` filters nothing, so every push including a tag fires it.
      if (event === 'push' && filterIndent === null) return true
      event = key
      filterIndent = null
      continue
    }
    if (filterIndent === null) filterIndent = width
    if (event !== 'push' || width !== filterIndent) continue
    if (key === 'tags') return true
  }
  return event === 'push' && filterIndent === null
}

export interface ReleaseLookupClient {
  commitExists(owner: string, name: string, sha: string): Promise<boolean>
  listTags(owner: string, name: string): Promise<Array<{ name: string; sha: string }>>
  compareCommits(owner: string, name: string, base: string, head: string): Promise<{ status: string; aheadBy: number }>
  getRepoFile(owner: string, name: string, path: string, ref: string): Promise<string | null>
  getBranchProtection(owner: string, name: string, branch: string): Promise<{ protected: boolean; requiredChecks: string[]; requiredApprovals: number } | null>
}

// The preflight is read-only: every call is a GET, and the answer is the plan a
// maintainer confirms. Nothing here writes. The commit is checked first because
// a maintainer types that SHA by hand: a missing object must be a named refusal
// here, not a 404 from `compare` or a 422 from the write.
export async function releasePreflight(
  client: ReleaseLookupClient,
  input: { owner: string; name: string; defaultBranch: string; requestedVersion: string; targetSha: string },
): Promise<ReleasePlan> {
  const commit = await client.commitExists(input.owner, input.name, input.targetSha)
  if (!commit) {
    return { ok: false, code: 'target_missing', message: `${input.targetSha} is not a commit in this repository` }
  }
  // #893: the commit exists, but that says nothing about which branch contains
  // it. GitHub's compare is `base...head`, so on
  // `compare/{defaultBranch}...{target}` `behind` means the target is an
  // ancestor of the default branch — the branch contains it — and `identical`
  // means the same commit; those two are the accepted answers. `ahead` is a
  // target the branch does not contain (an unmerged branch) and `diverged`
  // shares no base with it; both are refused, and a compare that cannot be read
  // fails closed rather than passing on an assumption.
  let ancestry: { status: string; aheadBy: number } | null = null
  try {
    ancestry = await client.compareCommits(input.owner, input.name, input.defaultBranch, input.targetSha)
  } catch {
    ancestry = null
  }
  if (ancestry === null) {
    return { ok: false, code: 'ancestry_unreadable', message: releaseRefusals.ancestryUnreadable(input.defaultBranch) }
  }
  if (ancestry.status !== 'behind' && ancestry.status !== 'identical') {
    return { ok: false, code: 'target_not_on_default', message: releaseRefusals.targetNotOnDefault(input.targetSha, input.defaultBranch, ancestry.status) }
  }
  const tags = await client.listTags(input.owner, input.name)
  const candidates: ReleaseTag[] = []
  // #893: the previous version is the highest reachable SemVer tag, so
  // reachability decides first and the walk stops at the first tag that
  // qualifies: a tag the target is not ahead of is not an ancestor of it. The
  // walk visits the tags newest-first, which is one compare per tag newer than
  // the previous release — the destructive class limit on the route is what
  // paces that. Capping to the ten newest tags *before* the test was wrong: a
  // target older than them lost its real previous release, `previous` was
  // undefined, and both "nothing to release" and "not higher" were skipped, so a
  // downgrade passed.
  const semverTags = tags
    .filter((tag) => parseVersion(tag.name) !== null)
    .sort((left, right) => compareVersions(right.name, left.name))
  for (const tag of semverTags) {
    const compare = await client.compareCommits(input.owner, input.name, tag.name, input.targetSha)
    const targetCommitsAhead = compare.status === 'identical' ? 0 : compare.status === 'ahead' ? compare.aheadBy : null
    if (targetCommitsAhead === null) continue
    candidates.push({ name: tag.name, sha: tag.sha, targetCommitsAhead })
    break
  }
  // #946: a repository that has released before can never declare a first
  // release. When the walk kept no candidate, every tag is newer than the
  // target, so the target predates the releases rather than starting them.
  // Refused here, before `planRelease`, because the first-release branch there
  // skips both version guards by design.
  const newestTag = semverTags[0]
  if (newestTag !== undefined && candidates.length === 0) {
    return { ok: false, code: 'target_before_releases', message: releaseRefusals.targetBeforeReleases(input.targetSha, newestTag.name) }
  }
  const workflow = await client.getRepoFile(input.owner, input.name, '.github/workflows/release.yml', input.targetSha)
  const protection = await client.getBranchProtection(input.owner, input.name, input.defaultBranch)
  const version = normalize(input.requestedVersion)
  return planRelease({
    requestedVersion: input.requestedVersion,
    targetSha: input.targetSha,
    tags: candidates,
    tagExists: tags.some((tag) => tag.name === version),
    releaseWorkflow: workflow !== null && hasTagTriggeredWorkflow(workflow),
    gateOnboarded: protection !== null && protection.protected && protection.requiredChecks.length > 0,
  })
}
