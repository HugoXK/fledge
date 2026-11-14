// #544, second slice: the planner, reachable by a person.
//
// `src/schedules/next.ts` owns the rules. This module is the surface around
// them: it turns form or query input into a request, validates it with a reason
// naming the field that is wrong, and walks the next N occurrences so the JSON
// preview and the console page cannot disagree.
//
// It also owns one refusal the planner does not: an interval has no timezone, so
// an interval that arrives with one is refused here by name. `next.ts` ignores
// an unknown `timezone` key on the interval form; that is harmless for code that
// builds a schedule itself, but this module is where a person can hand in both
// and would otherwise be shown a local-looking time that is not bound to a zone.

import { nextOccurrence, parseSchedule, type Schedule, type WallTime } from './next.js'

const MAX_COUNT = 20
const DEFAULT_COUNT = 5
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

export interface PreviewTime {
  /** The instant, as ISO 8601 UTC. */
  at: string
  /** The same instant in milliseconds, for a caller that wants to diff runs. */
  atMs: number
  /** The zone's wall clock, `YYYY-MM-DD HH:mm`; null for the interval form. */
  local: string | null
  /** The zone offset at that instant, e.g. `GMT+8`; null for the interval form. */
  offset: string | null
  /** The IANA zone the wall clock is read in; null for the interval form. */
  timezone: string | null
  /** Local times that did not exist on the way here, skipped and not shifted. */
  skipped: string[]
}

export interface PreviewRequest {
  schedule: Schedule
  from: number
  count: number
}

export type PreviewQuery = { ok: true; request: PreviewRequest } | { ok: false; reason: string }

export type PreviewResult =
  | { ok: true; schedule: Schedule; from: string; count: number; times: PreviewTime[]; truncated: boolean }
  | { ok: false; reason: string }

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

function digitsOnly(text: string): boolean {
  return text !== '' && [...text].every((character) => character >= '0' && character <= '9')
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function wallText(wall: WallTime): string {
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)} ${pad(wall.hour, 2)}:${pad(wall.minute, 2)}`
}

// `15m`, `2h`, `90s`, `1d`. The planner takes milliseconds, so the unit is
// resolved here and the planner's own range refusal still applies afterwards.
function parseEvery(text: string): { ok: true; everyMs: number } | { ok: false; reason: string } {
  const unit = text.slice(-1).toLowerCase()
  const amountText = text.slice(0, -1)
  if (!Object.hasOwn(UNIT_MS, unit)) {
    return refuse(`every "${text}" has no supported unit; write a whole number followed by s, m, h or d, such as 15m`)
  }
  if (!digitsOnly(amountText)) return refuse(`every "${text}" must be a whole number with a unit, such as 15m`)
  const amount = Number(amountText)
  if (amount < 1) return refuse(`every "${text}" must be at least one unit`)
  return { ok: true, everyMs: amount * (UNIT_MS[unit] ?? 0) }
}

// A date and time without an offset is ambiguous: `2026-11-16T09:00` means
// different instants in Shanghai and New York. The form asks for an offset so the
// preview never guesses which one the person meant.
function parseInstant(text: string, label: string): { ok: true; value: number } | { ok: false; reason: string } {
  const separator = text.indexOf('T')
  const afterDate = separator === -1 ? '' : text.slice(separator + 1)
  const hasOffset =
    afterDate.endsWith('Z') || afterDate.endsWith('z') || afterDate.includes('+') || afterDate.includes('-')
  if (!hasOffset) {
    return refuse(`${label} "${text}" must be an ISO 8601 instant with an offset, such as 2026-11-16T09:00:00+08:00`)
  }
  const value = Date.parse(text)
  if (!Number.isFinite(value)) return refuse(`${label} "${text}" is not a valid instant`)
  return { ok: true, value }
}

function parseCount(text: string): { ok: true; count: number } | { ok: false; reason: string } {
  if (!digitsOnly(text)) return refuse(`count "${text}" must be a whole number between 1 and ${MAX_COUNT}`)
  const count = Number(text)
  if (count < 1 || count > MAX_COUNT) return refuse(`count "${text}" must be a whole number between 1 and ${MAX_COUNT}`)
  return { ok: true, count }
}

/**
 * Query/form input to a preview request, refusing by name:
 * `cron` XOR `every`, an IANA `timezone` for cron only, ISO `start_at`/`end_at`/
 * `from` with an offset, and `count` in 1..20. `now` is the default `from`, so
 * the result is a pure function of its arguments.
 */
export function parsePreviewQuery(query: Record<string, string | undefined>, now: number): PreviewQuery {
  const cron = (query.cron ?? '').trim()
  const every = (query.every ?? '').trim()
  const timezone = (query.timezone ?? '').trim()
  const startAtText = (query.start_at ?? '').trim()
  const endAtText = (query.end_at ?? '').trim()
  const fromText = (query.from ?? '').trim()
  const countText = (query.count ?? '').trim()

  if (cron !== '' && every !== '') {
    return refuse('give either "cron" or "every", not both: two schedules make the preview ambiguous')
  }
  if (cron === '' && every === '') {
    return refuse('give "cron" (a five-field expression) or "every" (an interval such as 15m)')
  }

  let startAt: number | null = null
  if (startAtText !== '') {
    const parsed = parseInstant(startAtText, 'start_at')
    if (!parsed.ok) return parsed
    startAt = parsed.value
  }
  let endAt: number | null = null
  if (endAtText !== '') {
    const parsed = parseInstant(endAtText, 'end_at')
    if (!parsed.ok) return parsed
    endAt = parsed.value
  }
  let from = now
  if (fromText !== '') {
    const parsed = parseInstant(fromText, 'from')
    if (!parsed.ok) return parsed
    from = parsed.value
  }
  let count = DEFAULT_COUNT
  if (countText !== '') {
    const parsed = parseCount(countText)
    if (!parsed.ok) return parsed
    count = parsed.count
  }

  if (every !== '') {
    // An interval is absolute time; it has no zone. Accepting one silently is how
    // a maintainer comes to believe a 24-hour interval follows Asia/Shanghai.
    if (timezone !== '') {
      return refuse(`an interval has no timezone; remove "timezone" or give a cron expression instead`)
    }
    const parsedEvery = parseEvery(every)
    if (!parsedEvery.ok) return parsedEvery
    const parsed = parseSchedule({ everyMs: parsedEvery.everyMs, startAt, endAt })
    if (!parsed.ok) return refuse(parsed.reason)
    return { ok: true, request: { schedule: parsed.schedule, from, count } }
  }

  const parsed = parseSchedule({ cron, timezone, startAt, endAt })
  if (!parsed.ok) return refuse(parsed.reason)
  return { ok: true, request: { schedule: parsed.schedule, from, count } }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'shortOffset',
  })
  formatters.set(timezone, formatter)
  return formatter
}

function wallAt(timezone: string, instant: number): { local: string; offset: string } {
  const parts = formatterFor(timezone).formatToParts(new Date(instant))
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  const local = `${read('year').padStart(4, '0')}-${read('month').padStart(2, '0')}-${read('day').padStart(2, '0')} ${read('hour').padStart(2, '0')}:${read('minute').padStart(2, '0')}`
  return { local, offset: read('timeZoneName') }
}

/**
 * The next `count` instants strictly after `from`, each with the local wall clock
 * in its zone (the interval form has none) and the wall times that were skipped
 * on the way there. `truncated` means the window ended before `count`.
 */
export function previewSchedule(request: PreviewRequest): PreviewResult {
  const { schedule, count } = request
  if (!Number.isFinite(request.from)) return refuse('from must be a finite instant')
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return refuse(`count ${String(count)} must be a whole number between 1 and ${MAX_COUNT}`)
  }
  const times: PreviewTime[] = []
  let cursor = request.from
  for (let index = 0; index < count; index += 1) {
    const occurrence = nextOccurrence(schedule, cursor)
    if (occurrence.at === null) break
    const at = occurrence.at
    const zone = schedule.kind === 'cron' ? schedule.timezone : null
    const wall = zone === null ? null : wallAt(zone, at)
    times.push({
      at: new Date(at).toISOString(),
      atMs: at,
      local: wall === null ? null : wall.local,
      offset: wall === null ? null : wall.offset,
      timezone: zone,
      skipped: occurrence.skipped.map(wallText),
    })
    cursor = at
    // The window can close between two runs; asking again is what notices it, so
    // the loop asks once more than it fills.
  }
  return {
    ok: true,
    schedule,
    from: new Date(request.from).toISOString(),
    count,
    times,
    truncated: times.length < count,
  }
}

export const PREVIEW_MAX_COUNT = MAX_COUNT
