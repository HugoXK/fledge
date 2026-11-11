// Which number the next release gets. One rule, shared by the planner and the
// review gate:
//
//   first release of an ISO week  -> bump the minor  (0.3.4 -> 0.4.0)
//   later release in the same week -> bump the patch (0.3.4 -> 0.3.5)
//
// The weeks are UTC weeks, because the nightly runs at 14:30 UTC and the tag is
// created a few hours later, still on the same UTC day. Using the local date
// would move a late Monday release into Tuesday and make the next Monday look
// like the same week.
//
// Missing or unreadable timestamps keep the old first-release behaviour: bump
// the minor. That is the conservative direction for a planner and it means a
// gate that cannot read the dates only exempts a minor release, never a patch it
// cannot explain.

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

export function parseVersion(value) {
  const match = VERSION.exec(typeof value === 'string' ? value : '')
  if (match === null) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

// The Monday of the UTC week that contains the timestamp, as YYYY-MM-DD.
export function weekKey(value) {
  if (typeof value !== 'string' || value === '') return ''
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - daysSinceMonday)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export function nextReleaseVersion({ packageVersion, lastTagCommittedAt, releaseAt }) {
  const parsed = parseVersion(packageVersion)
  if (parsed === null) return { version: '', bump: '', known: false }
  const lastWeek = weekKey(lastTagCommittedAt)
  const thisWeek = weekKey(releaseAt)
  const sameWeek = lastWeek !== '' && thisWeek !== '' && lastWeek === thisWeek
  return {
    version: sameWeek
      ? `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
      : `${parsed.major}.${parsed.minor + 1}.0`,
    bump: sameWeek ? 'patch' : 'minor',
    known: lastWeek !== '' && thisWeek !== '',
  }
}
