import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The admin surface's half of issue #280: the release chain is assembled by
// `node scripts/verify-release.mjs` and written to `${DATA_DIR}/release-status.json`,
// and this process only renders the snapshot it finds. No GitHub call, no token,
// no network: a page render must never depend on the API being reachable.
//
// The snapshot is a claim made at `checkedAt`, so it carries the time it was
// measured and the page names that time rather than implying it is live.

export type ReleaseLinkState = 'ok' | 'missing' | 'mismatch' | 'skipped'

export interface ReleaseStatusLink {
  id: string
  state: ReleaseLinkState
  detail: string
}

export interface ReleaseStatusSnapshot {
  schema: number
  version: string
  checkedAt: string
  baseUrl: string
  ok: boolean
  links: ReleaseStatusLink[]
  problems: string[]
  /** The commit the release tag points at, empty when the chain has no tag. */
  targetSha: string
  /** The GitHub Release url, empty when the chain has no Release. */
  releaseUrl: string
}

export interface RunningInstance {
  version: string
  commit: string
}

export type RunningState = 'ok' | 'mismatch' | 'unknown'

export interface RunningComparison {
  state: RunningState
  detail: string
}

export const RELEASE_STATUS_FILE = 'release-status.json'

const STATES = new Set<ReleaseLinkState>(['ok', 'missing', 'mismatch', 'skipped'])
const SHA = /^[0-9a-f]{40}$/

function isLink(value: unknown): value is ReleaseStatusLink {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    entry.id !== '' &&
    typeof entry.detail === 'string' &&
    typeof entry.state === 'string' &&
    STATES.has(entry.state as ReleaseLinkState)
  )
}

// A snapshot that does not parse is `null`, not a half-rendered chain: showing
// three of nine links as if they were the whole answer would hide the gap.
export function parseReleaseStatus(raw: unknown): ReleaseStatusSnapshot | null {
  if (raw === null || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  if (Number(entry.schema) !== 1) return null
  if (typeof entry.version !== 'string' || entry.version === '') return null
  if (!Array.isArray(entry.links) || !entry.links.every(isLink)) return null
  const problems = Array.isArray(entry.problems) ? entry.problems.filter((item): item is string => typeof item === 'string') : []
  return {
    schema: 1,
    version: entry.version,
    checkedAt: typeof entry.checkedAt === 'string' ? entry.checkedAt : '',
    baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
    ok: entry.ok === true,
    links: entry.links,
    problems,
    targetSha: typeof entry.targetSha === 'string' ? entry.targetSha : '',
    releaseUrl: typeof entry.releaseUrl === 'string' ? entry.releaseUrl : '',
  }
}

export function readReleaseStatus(dataDir: string): ReleaseStatusSnapshot | null {
  if (dataDir === '') return null
  try {
    return parseReleaseStatus(JSON.parse(readFileSync(join(dataDir, RELEASE_STATUS_FILE), 'utf8')))
  } catch {
    return null
  }
}

// The question the page answers for an operator looking at a live instance: is
// the build I am looking at the one the chain released? A build with no stamp
// answers `unknown` instead of matching by accident.
export function compareRunning(snapshot: ReleaseStatusSnapshot, running: RunningInstance): RunningComparison {
  if (running.version === '') {
    return { state: 'unknown', detail: 'this build reports no version' }
  }
  if (running.version !== snapshot.version) {
    return { state: 'mismatch', detail: `this instance runs v${running.version}, the recorded release is v${snapshot.version}` }
  }
  if (!SHA.test(snapshot.targetSha)) {
    return { state: 'unknown', detail: `v${snapshot.version} is recorded as released, but the chain names no tagged commit` }
  }
  if (running.commit === 'unknown' || running.commit === '') {
    return { state: 'unknown', detail: 'this build carries no commit stamp, so it cannot be matched to the tag' }
  }
  if (running.commit !== snapshot.targetSha.slice(0, 12)) {
    return { state: 'mismatch', detail: `this instance runs ${running.commit}, the tag targets ${snapshot.targetSha.slice(0, 12)}` }
  }
  return { state: 'ok', detail: `v${running.version} at ${running.commit} is the tagged commit` }
}
