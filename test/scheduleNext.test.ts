import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTime, parseSchedule, type Schedule } from '../src/schedules/next.js'

// #544, first slice: the scheduling core. A schedule is a five-field cron
// expression or a fixed interval, and one shared `nextTime` turns it into the
// next instant. Preview and worker both call it, so the DST rules are tested
// here rather than in whichever caller happens to poll.
//
// The two DST cases use America/New_York 2026: spring forward on 03-08 (02:00
// local does not exist) and fall back on 11-01 (01:00-02:00 local happens
// twice). Expected instants are written as ISO strings with an explicit offset,
// so the test never re-derives the rule it is checking.

function parse(input: Parameters<typeof parseSchedule>[0]): Schedule {
  const result = parseSchedule(input)
  if (!result.ok) throw new Error(`the schedule was refused: ${result.reason}`)
  return result.schedule
}

test('a daily cron keeps the repository wall-clock time across the zone offset', () => {
  const schedule = parse({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
  const fridayEvening = Date.parse('2026-11-13T10:00:00+08:00')
  assert.equal(nextTime(schedule, fridayEvening), Date.parse('2026-11-16T09:00:00+08:00'))
})

test('a local time that does not exist in spring-forward is skipped, not moved', () => {
  const schedule = parse({ cron: '30 2 * * *', timezone: 'America/New_York' })
  const beforeTheGap = Date.parse('2026-03-08T00:00:00-05:00')
  const next = nextTime(schedule, beforeTheGap)
  assert.equal(next, Date.parse('2026-03-09T02:30:00-04:00'), '02:30 local on 03-08 does not exist, so the next run is 03-09')
  assert.notEqual(next, Date.parse('2026-03-08T03:30:00-04:00'), 'the shift is not silently applied')
})

test('a local time that happens twice in fall-back fires once, at the earlier instant', () => {
  const schedule = parse({ cron: '30 1 * * *', timezone: 'America/New_York' })
  const first = nextTime(schedule, Date.parse('2026-11-01T00:00:00Z'))
  assert.equal(first, Date.parse('2026-11-01T05:30:00Z'), 'the first 01:30 is the occurrence')
  const second = nextTime(schedule, Date.parse('2026-11-01T06:00:00Z'))
  assert.equal(second, Date.parse('2026-11-02T01:30:00-05:00'), 'a poll inside the repeated hour does not fire 01:30 a second time')
})

test('a fixed interval is aligned to start_at and stops at end_at', () => {
  const schedule = parse({
    everyMs: 15 * 60_000,
    startAt: Date.parse('2026-11-13T00:07:00Z'),
    endAt: Date.parse('2026-11-13T01:00:00Z'),
  })
  assert.equal(nextTime(schedule, Date.parse('2026-11-13T00:00:00Z')), Date.parse('2026-11-13T00:07:00Z'), 'the window starts at start_at')
  assert.equal(nextTime(schedule, Date.parse('2026-11-13T00:07:00Z')), Date.parse('2026-11-13T00:22:00Z'), 'strictly after the previous instant')
  assert.equal(nextTime(schedule, Date.parse('2026-11-13T00:52:00Z')), null, 'the run after 00:52 would be past end_at')
})

test('the validity window bounds a cron schedule without moving its wall-clock time', () => {
  const schedule = parse({
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    startAt: Date.parse('2026-11-16T10:00:00+08:00'),
    endAt: Date.parse('2026-11-18T00:00:00+08:00'),
  })
  assert.equal(nextTime(schedule, Date.parse('2026-11-01T00:00:00Z')), Date.parse('2026-11-17T09:00:00+08:00'), 'the first run is inside the window')
  assert.equal(nextTime(schedule, Date.parse('2026-11-17T09:00:00+08:00')), null, 'the next run would be past end_at')
})

// #605: the cron search began at `start_at` and then rejected the first day with
// `minute <= first.minute` — exactly the occurrence that opens the window. The
// interval form returns `start_at` verbatim (`:305`), so the two forms disagreed
// about one field. These rows pin the boundary: inclusive on the `start_at` side,
// exclusive on the `from` side, because a caller that passes the instant it
// dispatched must not be handed that instant again.

test('a daily occurrence exactly at start_at is inside the window', () => {
  const schedule = parse({
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    startAt: Date.parse('2026-11-17T01:00:00Z'),
  })
  assert.equal(
    nextTime(schedule, Date.parse('2026-11-15T00:00:00Z')),
    Date.parse('2026-11-17T01:00:00Z'),
    'the occurrence that falls exactly on start_at is the first run, not the following day',
  )
})

test('a weekly occurrence exactly at start_at does not lose the first week', () => {
  const schedule = parse({
    cron: '0 9 * * 1',
    timezone: 'Asia/Shanghai',
    startAt: Date.parse('2026-11-16T01:00:00Z'),
  })
  assert.equal(
    nextTime(schedule, Date.parse('2026-11-15T00:00:00Z')),
    Date.parse('2026-11-16T01:00:00Z'),
    'Monday 09:00 at start_at is the first run, not the Monday after it',
  )
})

test('a sub-daily expression returns the occurrence exactly at start_at', () => {
  const schedule = parse({
    cron: '*/5 * * * *',
    timezone: 'Asia/Shanghai',
    startAt: Date.parse('2026-11-17T01:05:00Z'),
  })
  assert.equal(
    nextTime(schedule, Date.parse('2026-11-15T00:00:00Z')),
    Date.parse('2026-11-17T01:05:00Z'),
    'a five-minute expression is not pushed to its second step',
  )
})

test('the start_at boundary is inclusive one millisecond on each side', () => {
  const startAt = Date.parse('2026-11-17T01:00:00Z')
  const before = parse({ cron: '0 9 * * *', timezone: 'Asia/Shanghai', startAt: startAt - 1 })
  assert.equal(
    nextTime(before, Date.parse('2026-11-15T00:00:00Z')),
    startAt,
    'one millisecond earlier still includes the occurrence',
  )
  const after = parse({ cron: '0 9 * * *', timezone: 'Asia/Shanghai', startAt: startAt + 1 })
  assert.equal(
    nextTime(after, Date.parse('2026-11-15T00:00:00Z')),
    Date.parse('2026-11-18T01:00:00Z'),
    'one millisecond later is past it',
  )

  const interval = parse({ everyMs: 60 * 60_000, startAt })
  assert.equal(
    nextTime(interval, Date.parse('2026-11-15T00:00:00Z')),
    startAt,
    'the interval form returns start_at verbatim, as it already did',
  )
})

test('strictly after from still holds when from is an occurrence', () => {
  const occurrence = Date.parse('2026-11-17T01:00:00Z')
  const open = parse({ cron: '0 9 * * *', timezone: 'Asia/Shanghai' })
  assert.equal(
    nextTime(open, occurrence),
    Date.parse('2026-11-18T01:00:00Z'),
    'without start_at, from equal to an occurrence returns the next one',
  )
  const windowed = parse({ cron: '0 9 * * *', timezone: 'Asia/Shanghai', startAt: occurrence })
  assert.equal(
    nextTime(windowed, occurrence),
    Date.parse('2026-11-18T01:00:00Z'),
    'with from equal to both start_at and the occurrence, the next one',
  )
})

// The rows below reach the same boundary through a different input each time, so
// a fix that special-cases `start_at` instead of loosening the first-day filter
// fails one of them rather than passing all of them by accident.

test('a from one millisecond before start_at still lands on the occurrence', () => {
  const startAt = Date.parse('2026-11-17T01:00:00Z')
  const schedule = parse({ cron: '0 9 * * *', timezone: 'Asia/Shanghai', startAt })
  assert.equal(
    nextTime(schedule, startAt - 1),
    startAt,
    'the same boundary reached from the from side must give the same answer',
  )
})

test('a quarter-hour expression keeps its own step at start_at', () => {
  const schedule = parse({
    cron: '*/15 * * * *',
    timezone: 'Asia/Shanghai',
    startAt: Date.parse('2026-11-17T01:15:00Z'),
  })
  assert.equal(
    nextTime(schedule, Date.parse('2026-11-15T00:00:00Z')),
    Date.parse('2026-11-17T01:15:00Z'),
    'a skipped candidate must not advance the search to the next step',
  )
})

test('a list of hours does not advance to the next same-day occurrence', () => {
  const schedule = parse({
    cron: '0 9,15 * * *',
    timezone: 'Asia/Shanghai',
    startAt: Date.parse('2026-11-17T01:00:00Z'),
  })
  assert.equal(
    nextTime(schedule, Date.parse('2026-11-15T00:00:00Z')),
    Date.parse('2026-11-17T01:00:00Z'),
    '09:00 at start_at beats 15:00 the same day',
  )
})

test('the fall-back occurrence at start_at is the earlier instant, not the next day', () => {
  const schedule = parse({
    cron: '30 1 * * *',
    timezone: 'America/New_York',
    startAt: Date.parse('2026-11-01T01:30:00-04:00'),
  })
  assert.equal(
    nextTime(schedule, Date.parse('2026-10-31T00:00:00Z')),
    Date.parse('2026-11-01T05:30:00Z'),
    'the repeated local time at start_at fires once, at the earlier instant',
  )
})

test('an end_at one millisecond after the occurrence leaves it in the window', () => {
  const occurrence = Date.parse('2026-11-17T01:00:00Z')
  const schedule = parse({
    cron: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    startAt: occurrence,
    endAt: occurrence + 1,
  })
  assert.equal(
    nextTime(schedule, Date.parse('2026-11-15T00:00:00Z')),
    occurrence,
    'end_at is exclusive, so one millisecond past the occurrence still admits it',
  )
})

test('an expression the schedule does not support is refused with a reason', () => {
  const cases: Array<[string, string, string]> = [
    ['0 9 * * * *', 'a six-field form means a leading seconds field', 'seconds'],
    ['0 9 * JAN *', 'month names are not supported', 'month'],
    ['*/0 9 * * *', 'a zero step is not a schedule', 'step'],
    ['61 9 * * *', 'an out-of-range minute is refused', 'minute'],
  ]
  for (const [cron, why, needle] of cases) {
    const result = parseSchedule({ cron, timezone: 'UTC' })
    assert.equal(result.ok, false, why)
    if (result.ok) continue
    assert.ok(result.reason.toLowerCase().includes(needle.toLowerCase()), `the refusal names ${needle}: ${result.reason}`)
  }
})

test('an unknown timezone is refused instead of silently treated as UTC', () => {
  const result = parseSchedule({ cron: '0 9 * * *', timezone: 'Mars/Olympus' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.ok(result.reason.includes('Mars/Olympus'), `the refusal names the zone: ${result.reason}`)
})

test('a fixed interval without start_at keeps every gap at exactly the configured length', () => {
  const schedule = parse({ everyMs: 90_000 })
  const from = Date.parse('2026-11-13T00:00:00Z')
  const first = nextTime(schedule, from)
  assert.ok(first !== null, 'an interval without start_at still has a next instant')
  const second = nextTime(schedule, first)
  assert.ok(second !== null)
  const third = nextTime(schedule, second)
  assert.ok(third !== null)
  assert.equal(second - first, 90_000, 'the gap after the first run is the configured interval')
  assert.equal(third - second, 90_000, 'and the next gap is the same')

  const odd = parse({ everyMs: 600_001 })
  const oddFirst = nextTime(odd, from)
  assert.ok(oddFirst !== null)
  const oddSecond = nextTime(odd, oddFirst)
  assert.ok(oddSecond !== null)
  assert.equal(oddSecond - oddFirst, 600_001, 'a sub-minute remainder is not truncated away')
})

test('with both day fields restricted either may match, and neither side alone is the answer', () => {
  const schedule = parse({ cron: '0 0 13 * 5', timezone: 'UTC' })
  assert.equal(
    nextTime(schedule, Date.parse('2026-06-01T00:00:00Z')),
    Date.parse('2026-06-05T00:00:00Z'),
    'a Friday that is not the 13th fires',
  )
  assert.equal(
    nextTime(schedule, Date.parse('2026-06-12T00:00:00Z')),
    Date.parse('2026-06-13T00:00:00Z'),
    'the 13th that is a Saturday fires',
  )
  assert.notEqual(
    nextTime(schedule, Date.parse('2026-06-01T00:00:00Z')),
    Date.parse('2026-11-13T00:00:00Z'),
    'the AND answer is not the schedule',
  )
})

test('a single value with a step spans to the end of the field, as Vixie cron does', () => {
  const schedule = parse({ cron: '5/10 * * * *', timezone: 'UTC' })
  assert.equal(nextTime(schedule, Date.parse('2026-11-13T00:00:00Z')), Date.parse('2026-11-13T00:05:00Z'))
  assert.equal(
    nextTime(schedule, Date.parse('2026-11-13T00:05:00Z')),
    Date.parse('2026-11-13T00:15:00Z'),
    '5/10 is 5,15,25,35,45,55 — not only :05',
  )
  assert.equal(nextTime(schedule, Date.parse('2026-11-13T00:55:00Z')), Date.parse('2026-11-13T01:05:00Z'))
})

test('a fixed UTC offset is refused by name instead of being taken as a zone', () => {
  const result = parseSchedule({ cron: '0 9 * * *', timezone: '+05:00' })
  assert.equal(result.ok, false, 'the contract says an IANA zone, and +05:00 is not one')
  if (!result.ok) {
    assert.ok(result.reason.includes('+05:00'), `the refusal names the value: ${result.reason}`)
    assert.ok(result.reason.includes('IANA'), `the refusal names the requirement: ${result.reason}`)
  }
})

test('a leap-day cron resolves past the window a five-year search would miss', () => {
  const schedule = parse({ cron: '0 0 29 2 *', timezone: 'UTC' })
  assert.equal(
    nextTime(schedule, Date.parse('2096-03-01T00:00:00Z')),
    Date.parse('2104-02-29T00:00:00Z'),
    '2100 is not a leap year, so the next 29 February is 2104',
  )
})

test('the expression is kept for display, so a console can show what it runs', () => {
  const schedule = parse({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
  assert.equal(schedule.kind, 'cron')
  assert.equal(schedule.expression, '0 9 * * 1-5')
  assert.equal(schedule.timezone, 'Asia/Shanghai')
})
