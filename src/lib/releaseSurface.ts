import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { projectRoot, readPackageVersion } from './projectRoot.js'

// What this process was shipped with, read from local files only: the release
// routine keeps `package.json` and `CHANGELOG.md` in step, and `changelog.d` is
// what it will assemble next. No GitHub call, no token, no network.
export interface ReleaseSurface {
  /** Running version, from `package.json`; null when the file cannot be read. */
  version: string | null
  /** Version of the newest dated `CHANGELOG.md` section; null when absent. */
  changelogVersion: string | null
  /** Date of the newest dated `CHANGELOG.md` section; null when absent. */
  releasedAt: string | null
  /** Pending `changelog.d` fragments; null when the directory is missing. */
  fragments: number | null
}

// `[Unreleased]` carries no date, so it never matches: the surface reports what
// shipped, not what is queued.
const SECTION = /^##\s*\[([^\]]+)\]\s*[—–-]\s*(\d{4}-\d{2}-\d{2})\s*$/m

function readVersion(root: string): string | null {
  // Same reader as `/healthz`: one resolver, so the footer cannot report a
  // version the process is not running.
  try {
    return readPackageVersion(root)
  } catch {
    return null
  }
}

function readChangelog(root: string): { version: string; date: string } | null {
  try {
    const match = SECTION.exec(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))
    return match === null ? null : { version: match[1] ?? '', date: match[2] ?? '' }
  } catch {
    return null
  }
}

function countFragments(root: string): number | null {
  try {
    return readdirSync(join(root, 'changelog.d'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md')
      .length
  } catch {
    return null
  }
}

export function readReleaseSurface(root: string): ReleaseSurface {
  const section = readChangelog(root)
  return {
    version: readVersion(root),
    changelogVersion: section?.version ?? null,
    releasedAt: section?.date ?? null,
    fragments: countFragments(root),
  }
}

let cached: ReleaseSurface | undefined

/** The surface for the running process, read once and reused by every page. */
export function releaseSurface(): ReleaseSurface {
  cached ??= readReleaseSurface(projectRoot())
  return cached
}
