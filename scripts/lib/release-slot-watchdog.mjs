#!/usr/bin/env node
// Which release-slot day failed to ship, and the one card that says so (#941).
//
// Pure: the caller supplies the clock reading, the releases, the workflow runs
// and the recent issues, so every decision is executable in the suite without a
// token, a repository or a clock. The driver reads `now` from the API `Date`
// response header, never from the host: the box clock has been wrong before and
// a subtraction from it would place the slot on the wrong day.
//
// Invariants:
//   - the slot is 02:00Z on the current UTC day (10:00 Asia/Shanghai, ADR 0024);
//     a reading before that boundary belongs to the previous slot, which is what
//     lets an early-morning tick keep judging yesterday rather than today.
//   - nothing is said before the grace window ends. A release that is merely
//     late is the workflow's business; the card is for a day that has no release
//     after the window.
//   - a release counts only when `published_at` falls in [slot, slot + 24h).
//     A release published before the boundary belongs to the previous day, and
//     the manual dispatch the card's evidence names is exactly that shape.
//   - one card per slot, ever: the card carries a marker built from the slot,
//     and the planner refuses when any issue (open or closed) already carries
//     it. A rerun of the same day is therefore a no-op, not a second card.
//   - the detector is read-only except for the card. It dispatches nothing,
//     creates no tag or release, and writes no file.

export const SLOT_HOUR_UTC = 2
export const GRACE_MINUTES = 60
export const SLOT_MARKER_PREFIX = 'release-slot-watchdog'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

function parseTime(value) {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

function iso(ms) {
  return new Date(ms).toISOString()
}

/** The slot governing `now`, its day and the instant its grace window ends. */
export function slotFor(now, graceMinutes = GRACE_MINUTES) {
  const ms = parseTime(String(now ?? ''))
  if (ms === null) return null
  const at = new Date(ms)
  let slotMs = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), SLOT_HOUR_UTC, 0, 0, 0)
  // A reading before today's boundary still belongs to yesterday's slot: the
  // slot's day window runs from 02:00Z to the next 02:00Z, so an early tick is
  // the last chance to catch yesterday, not a too-early look at today.
  if (ms < slotMs) slotMs -= DAY_MS
  const slot = iso(slotMs)
  return { slot, day: slot.slice(0, 10), graceEnds: iso(slotMs + graceMinutes * MINUTE_MS) }
}

/** The marker that makes a card belong to exactly one slot. */
export function markerFor(slot) {
  return `<!-- ${SLOT_MARKER_PREFIX}:slot=${String(slot ?? '')} -->`
}

function releaseOf(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const published = parseTime(String(entry.published_at ?? ''))
  if (published === null) return null
  return { tag: String(entry.tag_name ?? ''), publishedAt: iso(published), published }
}

function runsOf(runs, fromMs, toMs) {
  const out = []
  for (const entry of Array.isArray(runs) ? runs : []) {
    if (entry === null || typeof entry !== 'object') continue
    const created = parseTime(String(entry.created_at ?? ''))
    if (created === null || created < fromMs || created >= toMs) continue
    out.push({
      id: Number(entry.id ?? 0),
      event: String(entry.event ?? ''),
      status: String(entry.status ?? ''),
      conclusion: String(entry.conclusion ?? ''),
      createdAt: iso(created),
      headSha: String(entry.head_sha ?? ''),
    })
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id))
}

function runLine(run) {
  const conclusion = run.conclusion === '' ? 'no conclusion' : run.conclusion
  const sha = run.headSha === '' ? '' : `, head ${run.headSha.slice(0, 12)}`
  return `- run ${run.id}: event \`${run.event}\`, ${run.status}, ${conclusion}, created ${run.createdAt}${sha}`
}

function cardBody({ window, checkedAt, observed }) {
  const lines = [
    `release-watchdog: the ${window.day} ${window.slot.slice(11, 16)}Z slot shipped no release`,
    '',
    `No release was published for the ${window.day} UTC day inside its window \`${window.slot}\` → \`${iso(Date.parse(window.slot) + DAY_MS)}\`.`,
    '',
    `- Day: ${window.day} (UTC)`,
    `- Expected slot: \`${window.slot}\` (10:00 Asia/Shanghai, ADR 0024)`,
    `- Grace window: ${GRACE_MINUTES} minutes, ending \`${window.graceEnds}\``,
    `- API Date used: ${checkedAt} (this is the clock reading; no host wall-clock subtraction)`,
    `- Releases seen in the window: none`,
    '',
    '`daily-release` runs observed in the window:',
    ...(observed.length === 0 ? ['- none: the workflow did not run for this slot'] : observed.map(runLine)),
    '',
    'The detector is read-only: this card is its only write. A rerun of the same UTC day/slot opens no second card because the marker below already exists.',
    '',
    'Refs #941',
    '',
    markerFor(window.slot),
    '',
  ]
  return lines.join('\n')
}

/**
 * Decide what the slot watchdog does.
 *
 * Returns `{ action, reason, slot, day, graceEnds, checkedAt, ... }` with
 * `action` one of `invalid-clock`, `too-early`, `shipped`, `already-open` or
 * `missed`; only `missed` carries `issue: { title, body }`.
 */
export function decideSlotWatchdog(input = {}) {
  const { now = '', graceMinutes = GRACE_MINUTES, releases = [], runs = [], issues = [] } = input
  const window = slotFor(now, graceMinutes)
  const raw = String(now ?? '')
  if (window === null) {
    return { action: 'invalid-clock', reason: `the clock reading ${raw === '' ? '(empty)' : raw} cannot be read`, checkedAt: raw }
  }
  const nowMs = parseTime(raw)
  const graceMs = Date.parse(window.graceEnds)
  const base = { slot: window.slot, day: window.day, graceEnds: window.graceEnds, checkedAt: iso(nowMs) }

  if (nowMs < graceMs) {
    return {
      ...base,
      action: 'too-early',
      reason: `the grace window for ${window.slot} ends at ${window.graceEnds} and the clock reads ${iso(nowMs)}`,
    }
  }

  const fromMs = Date.parse(window.slot)
  const toMs = fromMs + DAY_MS
  const shipped = (Array.isArray(releases) ? releases : [])
    .map(releaseOf)
    .filter((entry) => entry !== null)
    .find((entry) => entry.published >= fromMs && entry.published < toMs)
  if (shipped !== undefined) {
    return {
      ...base,
      action: 'shipped',
      reason: `${shipped.tag === '' ? 'a release' : shipped.tag} was published at ${shipped.publishedAt}, inside this slot's day`,
      release: { tag: shipped.tag, publishedAt: shipped.publishedAt },
    }
  }

  const marker = markerFor(window.slot)
  const existing = (Array.isArray(issues) ? issues : []).find(
    (entry) => entry !== null && typeof entry === 'object' && String(entry.body ?? '').includes(marker),
  )
  if (existing !== undefined) {
    return {
      ...base,
      action: 'already-open',
      reason: `issue #${Number(existing.number ?? 0)} already records this slot`,
      existingIssueNumber: Number(existing.number ?? 0),
    }
  }

  const observed = runsOf(runs, fromMs, toMs)
  return {
    ...base,
    action: 'missed',
    reason: `no release was published for the ${window.day} UTC day by ${window.graceEnds}`,
    observedRuns: observed,
    issue: {
      title: `release-watchdog: the ${window.day} ${window.slot.slice(11, 16)}Z slot shipped no release`,
      body: cardBody({ window, checkedAt: base.checkedAt, observed }),
    },
  }
}
