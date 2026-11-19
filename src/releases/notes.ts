import type { GithubClient } from '../repos/github.js'

// #546 slice 3: the draft Release is a summary of a real commit range, not a
// placeholder sentence. Every source printed here is a commit or a merged pull
// request the range contains, each appears exactly once, and a source outside the
// range can never reach the body. A merged pull request covers its own merge
// commit, so that commit is not printed a second time as a bare change.

export interface ReleaseNotesPullRequest {
  number: number
  title: string
  url: string
  /** The commit this pull request merged as; the range decides whether it counts. */
  mergeCommitSha: string
}

export interface ReleaseNotesCommit {
  sha: string
  title: string
  url: string
}

export interface ReleaseNotesSource {
  kind: 'pull_request' | 'commit'
  /** `#812` for a pull request, the short commit sha for a commit. */
  ref: string
  title: string
  url: string
}

export interface ReleaseNotesInput {
  previousTag: string | null
  targetSha: string
  pullRequests: ReleaseNotesPullRequest[]
  commits: ReleaseNotesCommit[]
  /** False when a read stopped at its page cap while the range was still open. */
  commitsComplete: boolean
}

/**
 * #546 slice 5: which path produced the body. Written by the release path that
 * built it, so the page can say "organised by this skill at this commit" or name
 * why the built-in list was used, without re-reading GitHub on every render.
 */
export interface ReleaseNotesProvenance {
  kind: 'skill' | 'builtin'
  /** The skill's path in the repository; present when `kind` is `skill`. */
  skillPath?: string
  /** `repo_releases.target_sha`, the commit the skill was read at. */
  commit?: string
  reason?: 'no_skill' | 'skill_refused' | 'skill_too_large' | 'gateway_refused' | 'answer_rejected'
  detail?: string
}

export interface ReleaseNotes {
  previousTag: string | null
  targetSha: string
  sources: ReleaseNotesSource[]
  /** False when the range was read only in part; the body says so. */
  complete: boolean
  body: string
  organisedBy?: ReleaseNotesProvenance
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function bullet(source: ReleaseNotesSource): string {
  return source.kind === 'pull_request'
    ? `- ${source.ref} ${source.title} — ${source.url}`
    : `- \`${source.ref}\` ${source.title} — ${source.url}`
}

export function buildReleaseNotes(input: ReleaseNotesInput): ReleaseNotes {
  const commitsBySha = new Map<string, ReleaseNotesCommit>()
  for (const commit of input.commits) {
    if (!commitsBySha.has(commit.sha)) commitsBySha.set(commit.sha, commit)
  }
  const pullRequests: ReleaseNotesSource[] = []
  const seenPullRequests = new Set<number>()
  const coveredCommits = new Set<string>()
  for (const pull of input.pullRequests) {
    // The merge commit is the range's own evidence that this pull request is in
    // it. A pull request merged before the previous tag is not part of this
    // release, whatever its merge date says.
    if (!commitsBySha.has(pull.mergeCommitSha)) continue
    if (seenPullRequests.has(pull.number)) continue
    seenPullRequests.add(pull.number)
    coveredCommits.add(pull.mergeCommitSha)
    pullRequests.push({
      kind: 'pull_request',
      ref: `#${String(pull.number)}`,
      title: pull.title,
      url: pull.url,
    })
  }
  const commits: ReleaseNotesSource[] = []
  const seenCommits = new Set<string>()
  for (const commit of commitsBySha.values()) {
    if (coveredCommits.has(commit.sha) || seenCommits.has(commit.sha)) continue
    seenCommits.add(commit.sha)
    commits.push({ kind: 'commit', ref: shortSha(commit.sha), title: commit.title, url: commit.url })
  }
  const sources = [...pullRequests, ...commits]

  const range = input.previousTag === null
    ? `the first release of this repository (no previous tag to compare against)`
    : `the commits between \`${input.previousTag}\` and \`${shortSha(input.targetSha)}\``
  const lines: string[] = [
    `Draft written by Fledge from ${range}. A human edits and publishes this Release.`,
  ]
  if (!input.commitsComplete) {
    lines.push('', 'The commit range was only read in part, so this draft is partial: the list below is not the whole release.')
  }
  if (pullRequests.length > 0) {
    lines.push('', '### Merged pull requests', ...pullRequests.map(bullet))
  }
  if (commits.length > 0) {
    lines.push('', '### Commits', ...commits.map(bullet))
  }
  if (sources.length === 0) {
    lines.push('', 'No merged pull request or commit was recorded in this range.')
  }
  return {
    previousTag: input.previousTag,
    targetSha: input.targetSha,
    sources,
    complete: input.commitsComplete,
    body: lines.join('\n'),
  }
}

// A first release has no previous tag, so there is no range to read and nothing
// to ask GitHub for. It says that instead of listing the repository's history as
// if it were this release.
export function firstReleaseNotes(input: { targetSha: string }): ReleaseNotes {
  return {
    previousTag: null,
    targetSha: input.targetSha,
    sources: [],
    complete: true,
    body: `Draft written by Fledge for the first release of this repository. There is no previous tag to compare against, so no sources are listed; a human edits and publishes this Release.`,
  }
}

export interface ReleaseNotesClient {
  compareReleaseRange(owner: string, name: string, base: string, head: string): Promise<{
    status: string
    aheadBy: number
    totalCommits: number
    commits: Array<{ sha: string; title: string; url: string }>
  }>
  listMergedPullRequestsSince(owner: string, name: string, since: string, maxPages?: number): Promise<{
    pulls: Array<{ number: number; title: string; url: string; mergedAt: string; mergeCommitSha: string }>
    complete: boolean
  }>
  getCommitMeta(owner: string, name: string, ref: string): Promise<{ sha: string; committedAt: string } | null>
}

export async function collectReleaseNotes(
  client: ReleaseNotesClient | GithubClient,
  input: { owner: string; name: string; previousTag: string | null; targetSha: string },
): Promise<ReleaseNotes> {
  if (input.previousTag === null) return firstReleaseNotes({ targetSha: input.targetSha })
  const range = await client.compareReleaseRange(input.owner, input.name, input.previousTag, input.targetSha)
  // The pull-request walk is bounded by time, the commit range by ancestry. The
  // time bound comes from the previous tag's own commit, and the ancestry check
  // inside `buildReleaseNotes` is what decides membership, so a pull request that
  // merged later but landed outside the branch is still excluded.
  const meta = await client.getCommitMeta(input.owner, input.name, input.previousTag)
  const merged = meta === null
    ? { pulls: [], complete: false }
    : await client.listMergedPullRequestsSince(input.owner, input.name, meta.committedAt)
  return buildReleaseNotes({
    previousTag: input.previousTag,
    targetSha: input.targetSha,
    pullRequests: merged.pulls.map((pull) => ({
      number: pull.number,
      title: pull.title,
      url: pull.url,
      mergeCommitSha: pull.mergeCommitSha,
    })),
    commits: range.commits,
    commitsComplete: merged.complete && range.totalCommits <= range.commits.length,
  })
}

// What the release row keeps: the exact range and the exact sources, so the page
// can list them later without another GitHub read. It is written by the same
// reconcile that created the draft, never edited afterwards.
export function releaseNotesSourceJson(notes: ReleaseNotes): string {
  return JSON.stringify({
    previousTag: notes.previousTag,
    targetSha: notes.targetSha,
    complete: notes.complete,
    sources: notes.sources,
    // #546 slice 5: the page names the path that produced the body. It rides in
    // the column the sources already use, so no migration and no second reader.
    ...(notes.organisedBy === undefined ? {} : { organisedBy: notes.organisedBy }),
  })
}

const PROVENANCE_REASONS = new Set(['no_skill', 'skill_refused', 'skill_too_large', 'gateway_refused', 'answer_rejected'])

// A row written before #546 slice 5 has no `organisedBy`: it renders as the
// built-in list, which is what built it. The provenance line is an explanation,
// never a page error, so a wrong shape is dropped rather than thrown.
export function readReleaseNotesProvenance(json: string | null): ReleaseNotesProvenance | null {
  if (json === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const value = (parsed as { organisedBy?: unknown }).organisedBy
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.kind !== 'skill' && record.kind !== 'builtin') return null
  const provenance: ReleaseNotesProvenance = { kind: record.kind }
  if (typeof record.skillPath === 'string' && record.skillPath !== '') provenance.skillPath = record.skillPath
  if (typeof record.commit === 'string' && /^[0-9a-f]{7,40}$/.test(record.commit)) provenance.commit = record.commit
  if (typeof record.reason === 'string' && PROVENANCE_REASONS.has(record.reason)) provenance.reason = record.reason as ReleaseNotesProvenance['reason']
  if (typeof record.detail === 'string' && record.detail !== '') provenance.detail = record.detail.slice(0, 300)
  return provenance
}

// A stored value that is missing, unparsable or structurally wrong renders as no
// sources at all rather than as a page error: the draft Release itself is the
// record of what was published, and this column is only its explanation.
export function readReleaseNotesSources(json: string | null): ReleaseNotesSource[] {
  if (json === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const sources = (parsed as { sources?: unknown }).sources
  if (!Array.isArray(sources)) return []
  const result: ReleaseNotesSource[] = []
  for (const entry of sources) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const kind = record.kind
    if (kind !== 'pull_request' && kind !== 'commit') continue
    if (typeof record.ref !== 'string' || typeof record.title !== 'string' || typeof record.url !== 'string') continue
    result.push({ kind, ref: record.ref, title: record.title, url: record.url })
  }
  return result
}
