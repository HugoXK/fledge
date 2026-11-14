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
    return { ok: false, code: 'missing_gate', message: 'the default branch is not protected by required checks, so this repository is not onboarded to a gate' }
  }
  if (!input.releaseWorkflow) {
    return { ok: false, code: 'missing_release_workflow', message: 'the repository has no tag-triggered .github/workflows/release.yml' }
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
      return { ok: false, code: 'no_new_commits', message: `nothing to release: ${previous.name} already points at the target commit` }
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
  | { ok: false; code: 'tag_exists' | 'tag_ref_failed' | 'target_missing'; message: string }

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
      return { ok: false, code: 'target_missing', message: `${input.plan.targetSha} is not a commit in this repository` }
    }
    throw error
  }
  const ref = `refs/tags/${input.plan.tagName}`
  const created = await client.createTagRef(input.owner, input.name, { ref, sha: tag.sha })
  if (created.ok) return { ok: true, tagObjectSha: tag.sha, ref }
  if (created.status === 422) {
    return { ok: false, code: 'tag_exists', message: `tag ${input.plan.tagName} already exists; nothing was moved or deleted` }
  }
  return { ok: false, code: 'tag_ref_failed', message: created.message }
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

// The preflight is read-only: five GETs decide whether a tag may be written, and
// the answer is the plan a maintainer confirms. Nothing here writes. The commit
// is checked first because a maintainer types that SHA by hand: a missing object
// must be a named refusal here, not a 404 from `compare` or a 422 from the write.
export async function releasePreflight(
  client: ReleaseLookupClient,
  input: { owner: string; name: string; defaultBranch: string; requestedVersion: string; targetSha: string },
): Promise<ReleasePlan> {
  const commit = await client.commitExists(input.owner, input.name, input.targetSha)
  if (!commit) {
    return { ok: false, code: 'target_missing', message: `${input.targetSha} is not a commit in this repository` }
  }
  const tags = await client.listTags(input.owner, input.name)
  const candidates: ReleaseTag[] = []
  for (const tag of tags) {
    if (parseVersion(tag.name) === null) continue
    const compare = await client.compareCommits(input.owner, input.name, tag.name, input.targetSha)
    candidates.push({
      name: tag.name,
      sha: tag.sha,
      targetCommitsAhead: compare.status === 'ahead' || compare.status === 'identical' ? (compare.status === 'identical' ? 0 : compare.aheadBy) : null,
    })
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
