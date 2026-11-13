// #544, first slice: the scheduling core.
//
// A schedule is a five-field cron expression or a fixed interval, bound to an
// IANA timezone and an optional `[start_at, end_at)` window. `nextTime` is the
// one function that turns a schedule into the next instant, so a preview and the
// worker cannot disagree about when a run is due.
//
// DST is handled explicitly, because a wall-clock loop is where this usually
// goes wrong:
//   - a local time that does not exist (spring forward) is skipped, not shifted;
//   - a local time that happens twice (fall back) fires once, at the earlier
//     instant, and a poll inside the repeated hour does not fire it again.
//
// Not in this slice, by design: occurrence rows, leases, misfire policies,
// budgets and the notification outbox. They build on this function.

export interface CronSchedule {
  kind: 'cron'
  /** The expression exactly as it was accepted, for display. */
  expression: string
  timezone: string
  startAt: number | null
  endAt: number | null
}

export interface IntervalSchedule {
  kind: 'interval'
  everyMs: number
  startAt: number | null
  endAt: number | null
}

export type Schedule = CronSchedule | IntervalSchedule

export type ScheduleInput =
  | { cron: string; timezone: string; startAt?: number | null; endAt?: number | null }
  | { everyMs: number; startAt?: number | null; endAt?: number | null }

export type ScheduleParse = { ok: true; schedule: Schedule } | { ok: false; reason: string }

interface CronFields {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  domWildcard: boolean
  dowWildcard: boolean
}

const MINUTE = 60_000
const DAY = 86_400_000
// A five-field cron repeats within a year except for a few pathological
// combinations (`0 0 30 2 *` never matches). Five years is far past any window a
// repository schedule can carry, and a null answer is honest there.
const MAX_DAYS = 366 * 5
const MAX_INTERVAL = 30 * DAY

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

function isValidTimezone(timezone: string): boolean {
  if (timezone.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

function parseNumber(text: string, label: string, min: number, max: number): { ok: true; value: number } | { ok: false; reason: string } {
  if (!/^\d+$/.test(text)) return fail(`${label} field "${text}" is not a number; named months, weekdays and extensions are not supported`)
  const value = Number(text)
  if (value < min || value > max) return fail(`${label} field "${text}" is outside ${min}-${max}`)
  return { ok: true, value }
}

interface FieldParse {
  ok: boolean
  values: number[]
  wildcard: boolean
  reason: string
}

function parseField(raw: string, label: string, min: number, max: number): FieldParse {
  const denied = (reason: string): FieldParse => ({ ok: false, values: [], wildcard: false, reason })
  const values = new Set<number>()
  const wildcard = raw === '*'
  for (const part of raw.split(',')) {
    if (part === '') return denied(`${label} field "${raw}" has an empty element`)
    const pieces = part.split('/')
    if (pieces.length > 2) return denied(`${label} element "${part}" has more than one step`)
    const rangeText = pieces[0] ?? ''
    const stepText = pieces[1]
    let step = 1
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) return denied(`${label} step in "${part}" must be a positive number`)
      step = Number(stepText)
    }
    let low: number
    let high: number
    if (rangeText === '*') {
      low = min
      high = max
    } else if (rangeText.includes('-')) {
      const bounds = rangeText.split('-')
      if (bounds.length !== 2) return denied(`${label} range "${rangeText}" is not a low-high pair`)
      const lowerText = bounds[0] ?? ''
      const upperText = bounds[1] ?? ''
      const lower = parseNumber(lowerText, label, min, max)
      if (!lower.ok) return denied(lower.reason)
      const upper = parseNumber(upperText, label, min, max)
      if (!upper.ok) return denied(upper.reason)
      if (lower.value > upper.value) return denied(`${label} range "${rangeText}" runs backwards`)
      low = lower.value
      high = upper.value
    } else {
      const single = parseNumber(rangeText, label, min, max)
      if (!single.ok) return denied(single.reason)
      low = single.value
      high = single.value
    }
    for (let value = low; value <= high; value += step) values.add(value)
  }
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return denied(`${label} field "${raw}" selects nothing`)
  return { ok: true, values: sorted, wildcard, reason: '' }
}

function parseCron(expression: string): { ok: true; fields: CronFields } | { ok: false; reason: string } {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    return fail(`a cron expression is five fields, and "${expression}" has ${parts.length === 1 ? 'five fields or more missing' : parts.length}`)
  }
  const minute = parts[0] ?? ''
  const hour = parts[1] ?? ''
  const dayOfMonth = parts[2] ?? ''
  const month = parts[3] ?? ''
  const dayOfWeek = parts[4] ?? ''
  const minutes = parseField(minute, 'minute', 0, 59)
  if (!minutes.ok) return fail(minutes.reason)
  const hours = parseField(hour, 'hour', 0, 23)
  if (!hours.ok) return fail(hours.reason)
  const dom = parseField(dayOfMonth, 'day-of-month', 1, 31)
  if (!dom.ok) return fail(dom.reason)
  const months = parseField(month, 'month', 1, 12)
  if (!months.ok) return fail(months.reason)
  // 7 is Sunday in the cron dialect operators type; normalise it to 0 so the
  // rest of the module only ever sees 0-6 (JS `getUTCDay()` numbering).
  const dow = parseField(dayOfWeek, 'day-of-week', 0, 7)
  if (!dow.ok) return fail(dow.reason)
  const daysOfWeek = [...new Set(dow.values.map((value) => (value === 7 ? 0 : value)))].sort((a, b) => a - b)
  return {
    ok: true,
    fields: {
      minutes: minutes.values,
      hours: hours.values,
      daysOfMonth: dom.values,
      months: months.values,
      daysOfWeek,
      domWildcard: dom.wildcard,
      dowWildcard: dow.wildcard,
    },
  }
}

export function parseSchedule(input: ScheduleInput): ScheduleParse {
  const startAt = input.startAt ?? null
  const endAt = input.endAt ?? null
  if (startAt !== null && !Number.isFinite(startAt)) return fail('start_at must be a finite instant')
  if (endAt !== null && !Number.isFinite(endAt)) return fail('end_at must be a finite instant')
  if (startAt !== null && endAt !== null && endAt <= startAt) return fail('end_at must be after start_at')

  if ('cron' in input) {
    if (!isValidTimezone(input.timezone)) return fail(`timezone "${input.timezone}" is not an IANA zone this runtime knows`)
    const parsed = parseCron(input.cron)
    if (!parsed.ok) return fail(parsed.reason)
    return { ok: true, schedule: { kind: 'cron', expression: input.cron.trim(), timezone: input.timezone, startAt, endAt } }
  }

  const everyMs = input.everyMs
  if (!Number.isFinite(everyMs) || !Number.isInteger(everyMs) || everyMs < MINUTE) {
    return fail(`everyMs ${String(everyMs)} must be a whole number of milliseconds, at least one minute`)
  }
  if (everyMs > MAX_INTERVAL) return fail(`everyMs ${everyMs} is longer than the 30-day maximum interval`)
  return { ok: true, schedule: { kind: 'interval', everyMs, startAt, endAt } }
}

interface WallParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
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
  })
  formatters.set(timezone, formatter)
  return formatter
}

// The zone's wall clock at an instant, as numbers. `hourCycle: 'h23'` is what
// keeps midnight `00` instead of `24`.
function wallPartsAt(timezone: string, instant: number): WallParts {
  const parts = formatterFor(timezone).formatToParts(new Date(instant))
  const read = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type)
    return part === undefined ? 0 : Number(part.value)
  }
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour'), minute: read('minute') }
}

function minuteAligned(instant: number): number {
  return instant - (((instant % MINUTE) + MINUTE) % MINUTE)
}

// The zone offset at an instant: wall clock read as UTC minus the instant.
function offsetAt(timezone: string, instant: number): number {
  const aligned = minuteAligned(instant)
  const parts = wallPartsAt(timezone, aligned)
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - aligned
}

// The earliest instant whose wall clock in the zone is the given local time.
// `undefined` means the local time does not exist that day (the spring-forward
// gap). For a repeated local time the earlier of the two instants wins, which is
// what makes a fall-back run happen once.
function instantForWall(timezone: string, wall: WallParts): number | undefined {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute)
  const offsets = new Set<number>()
  for (const probe of [guess - 26 * 3_600_000, guess, guess + 26 * 3_600_000]) offsets.add(offsetAt(timezone, probe))
  let best: number | undefined
  for (const offset of offsets) {
    const candidate = guess - offset
    const actual = wallPartsAt(timezone, candidate)
    if (actual.year !== wall.year || actual.month !== wall.month || actual.day !== wall.day) continue
    if (actual.hour !== wall.hour || actual.minute !== wall.minute) continue
    if (best === undefined || candidate < best) best = candidate
  }
  return best
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

function addDays(year: number, month: number, day: number, days: number): WallParts {
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * DAY)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: 0, minute: 0 }
}

function dayMatches(fields: CronFields, year: number, month: number, day: number): boolean {
  if (!fields.months.includes(month)) return false
  const domMatches = fields.daysOfMonth.includes(day)
  const dowMatches = fields.daysOfWeek.includes(weekdayOf(year, month, day))
  // Standard cron semantics: with both day fields restricted either may match;
  // with one wildcard the restricted one decides.
  if (fields.domWildcard && fields.dowWildcard) return true
  if (fields.domWildcard) return dowMatches
  if (fields.dowWildcard) return domMatches
  return domMatches || dowMatches
}

function nextInterval(schedule: IntervalSchedule, from: number): number | null {
  const startAt = schedule.startAt
  const endAt = schedule.endAt
  let candidate: number
  if (startAt !== null && from < startAt) {
    candidate = startAt
  } else if (startAt === null) {
    candidate = minuteAligned(from) + schedule.everyMs
  } else {
    candidate = startAt + (Math.floor((from - startAt) / schedule.everyMs) + 1) * schedule.everyMs
  }
  if (endAt !== null && candidate >= endAt) return null
  return candidate
}

function nextCron(schedule: CronSchedule, from: number): number | null {
  const parsed = parseCron(schedule.expression)
  if (!parsed.ok) return null
  const fields = parsed.fields
  const startAt = schedule.startAt
  const endAt = schedule.endAt
  const cursor = startAt !== null && startAt > from ? startAt : from
  if (endAt !== null && cursor >= endAt) return null
  // Strictly after `from`, so a caller that passes the instant it dispatched
  // cannot be handed the same instant again.
  const first = wallPartsAt(schedule.timezone, cursor)
  for (let offset = 0; offset < MAX_DAYS; offset += 1) {
    const day = addDays(first.year, first.month, first.day, offset)
    if (!dayMatches(fields, day.year, day.month, day.day)) continue
    for (const hour of fields.hours) {
      if (offset === 0 && hour < first.hour) continue
      for (const minute of fields.minutes) {
        // On the first day the search starts at `cursor`, so earlier wall times
        // are behind us; on later days the whole day is in play.
        if (offset === 0 && (hour < first.hour || (hour === first.hour && minute <= first.minute))) continue
        const instant = instantForWall(schedule.timezone, { ...day, hour, minute })
        // No instant: the local time does not exist that day. Skipped, not moved.
        if (instant === undefined) continue
        if (instant <= from) continue
        if (startAt !== null && instant < startAt) continue
        if (endAt !== null && instant >= endAt) return null
        return instant
      }
    }
  }
  return null
}

export function nextTime(schedule: Schedule, from: number): number | null {
  if (!Number.isFinite(from)) return null
  return schedule.kind === 'interval' ? nextInterval(schedule, from) : nextCron(schedule, from)
}
