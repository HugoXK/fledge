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
//   - three nights, three statements (#1222). A planner that declined is not a
//     miss: the `daily-release` run succeeded and its `release-plan` artifact
//     says `shouldRelease: false`, so the slot is `declined` and opens no card.
//     A run that failed, and no run at all, are both `missed` — the two alarms
//     the card names separately. A successful run whose plan cannot be read is
//     still `missed`: silence would hide a real miss, so the alarm is the safe
//     direction.
//   - the detector is read-only except for the card. It dispatches nothing,
//     creates no tag or release, and writes no file.

import { inflateRawSync } from 'node:zlib'

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

/**
 * Which alarm a missed night is (#1222): the workflow failed, it never ran, its
 * plan could not be read, or it said release and shipped nothing. The card says
 * which one in its body, so a reader does not need the workflow log.
 */
export const ALARMS = ['workflow-failed', 'no-run', 'plan-unavailable', 'release-not-shipped']

function alarmText(alarm, observed) {
  if (alarm === 'no-run') {
    return 'the `daily-release` workflow did not run for this slot: the window holds no run at all, so nothing could have shipped.'
  }
  if (alarm === 'workflow-failed') {
    const failed = observed.filter((run) => run.conclusion !== 'success')
    const named = failed
      .map((run) => `run ${run.id} concluded \`${run.conclusion === '' ? 'no conclusion' : run.conclusion}\``)
      .join(', ')
    return `the \`daily-release\` workflow ran for this slot and did not finish green: ${named}. The gate may never have been asked, so this is the workflow, not the rule.`
  }
  if (alarm === 'plan-unavailable') {
    return 'the `daily-release` workflow ran successfully, but its `release-plan` artifact could not be read — so a declined night cannot be told from a miss, and the miss is reported.'
  }
  return 'the `daily-release` workflow ran successfully and the planner said release, yet no release was published inside the window.'
}

/** The plan the daily-release run publishes, or null when it cannot be read. */
function planOf(plan) {
  if (plan === null || typeof plan !== 'object') return null
  if (typeof plan.shouldRelease !== 'boolean') return null
  return {
    shouldRelease: plan.shouldRelease,
    reason: typeof plan.reason === 'string' ? plan.reason : '',
    total: Number.isFinite(Number(plan.total)) ? Number(plan.total) : 0,
    features: Number.isFinite(Number(plan.features)) ? Number(plan.features) : 0,
    fragments: Number.isFinite(Number(plan.fragments)) ? Number(plan.fragments) : 0,
  }
}

/**
 * Read `release-plan.json` out of the zip the artifact download answers (#1222).
 *
 * Pure and dependency-free: the publish job uploads the plan as the
 * `release-plan` artifact, GitHub serves artifacts as a zip, and this is the
 * smallest reader that gets the JSON out of one. Anything unreadable answers
 * null, which the decision treats as "the plan is not known" — a miss, never a
 * silent decline.
 */
export function planFromArtifactZip(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  const entry = zipEntry(buffer, 'release-plan.json')
  if (entry === null) return null
  let parsed
  try {
    parsed = JSON.parse(entry.toString('utf8'))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (typeof parsed.shouldRelease !== 'boolean') return null
  return planOf(parsed)
}

function zipEntry(buffer, wanted) {
  if (buffer.length < 22) return null
  const floor = Math.max(0, buffer.length - 65_557)
  let eocd = -1
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) return null
  const count = buffer.readUInt16LE(eocd + 10)
  let central = buffer.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    if (central + 46 > buffer.length || buffer.readUInt32LE(central) !== 0x02014b50) return null
    const method = buffer.readUInt16LE(central + 10)
    const compressed = buffer.readUInt32LE(central + 20)
    const nameLength = buffer.readUInt16LE(central + 28)
    const extraLength = buffer.readUInt16LE(central + 30)
    const commentLength = buffer.readUInt16LE(central + 32)
    const localAt = buffer.readUInt32LE(central + 42)
    const name = buffer.toString('utf8', central + 46, central + 46 + nameLength)
    if (name === wanted || name.endsWith(`/${wanted}`)) {
      if (localAt + 30 > buffer.length || buffer.readUInt32LE(localAt) !== 0x04034b50) return null
      const start = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28)
      const data = buffer.subarray(start, start + compressed)
      if (method === 0) return data
      if (method === 8) return inflateRawSync(data)
      return null
    }
    central += 46 + nameLength + extraLength + commentLength
  }
  return null
}

function cardBody({ window, checkedAt, observed, alarm }) {
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
    `Alarm: ${alarmText(alarm, observed)}`,
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
 * `action` one of `invalid-clock`, `too-early`, `shipped`, `already-open`,
 * `declined` or `missed`; only `missed` carries `issue: { title, body }`, and it
 * also names its `alarm` (`workflow-failed`, `no-run`, `plan-unavailable` or
 * `release-not-shipped`). `declined` is a successful run whose `release-plan`
 * said `shouldRelease: false` (#1222).
 */
export function decideSlotWatchdog(input = {}) {
  const { now = '', graceMinutes = GRACE_MINUTES, releases = [], runs = [], issues = [], plan = null } = input
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
  const failed = observed.filter((run) => run.conclusion !== 'success')
  const readPlan = planOf(plan)

  // A night the planner declined says so: a successful run whose own plan says
  // `shouldRelease: false` is the gate working, not a release going missing.
  if (observed.length > 0 && failed.length === 0 && readPlan !== null && readPlan.shouldRelease === false) {
    return {
      ...base,
      action: 'declined',
      reason: `the planner declined this slot: ${readPlan.reason === '' ? 'no reason recorded' : readPlan.reason}`,
      planReason: readPlan.reason,
      observedRuns: observed,
    }
  }

  const alarm =
    observed.length === 0
      ? 'no-run'
      : failed.length > 0
        ? 'workflow-failed'
        : readPlan === null
          ? 'plan-unavailable'
          : 'release-not-shipped'

  return {
    ...base,
    action: 'missed',
    reason: `no release was published for the ${window.day} UTC day by ${window.graceEnds}`,
    alarm,
    observedRuns: observed,
    issue: {
      title: `release-watchdog: the ${window.day} ${window.slot.slice(11, 16)}Z slot shipped no release`,
      body: cardBody({ window, checkedAt: base.checkedAt, observed, alarm }),
    },
  }
}
