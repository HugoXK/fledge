import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #544, second slice: the planner is reachable by a person. These are the two
// surfaces a maintainer touches — the JSON preview and the console page — and
// they must agree because both call the same planner.
async function fixture() {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'schedule-owner', status: 'approved' })
  const { cookie } = sessionFor(built, user)
  return { built, cookie }
}

function previewUrl(params: Record<string, string>): string {
  return `/api/schedule/preview?${new URLSearchParams(params).toString()}`
}

test('the JSON preview returns the next weekday 09:00 in the requested zone', async () => {
  const { built, cookie } = await fixture()
  try {
    const response = await built.app.inject({
      method: 'GET',
      url: previewUrl({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai', count: '3', from: '2026-11-16T00:00:00Z' }),
      headers: { cookie },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as {
      times: Array<{ at: string; local: string; offset: string; timezone: string; skipped: string[] }>
      truncated: boolean
      schedule: { kind: string; expression: string; timezone: string }
    }
    assert.equal(body.schedule.kind, 'cron')
    assert.equal(body.schedule.expression, '0 9 * * 1-5')
    assert.equal(body.schedule.timezone, 'Asia/Shanghai')
    assert.deepEqual(body.times.map((time) => time.at), ['2026-11-16T01:00:00.000Z', '2026-11-17T01:00:00.000Z', '2026-11-18T01:00:00.000Z'])
    assert.deepEqual(body.times.map((time) => time.local), ['2026-11-16 09:00', '2026-11-17 09:00', '2026-11-18 09:00'])
    assert.deepEqual(body.times.map((time) => time.offset), ['GMT+8', 'GMT+8', 'GMT+8'])
    assert.deepEqual(body.times.map((time) => time.timezone), ['Asia/Shanghai', 'Asia/Shanghai', 'Asia/Shanghai'])
    assert.deepEqual(body.times.map((time) => time.skipped), [[], [], []])
    assert.equal(body.truncated, false)
  } finally {
    await built.close()
  }
})

test('a spring-forward gap is reported as skipped, not shifted', async () => {
  const { built, cookie } = await fixture()
  try {
    const response = await built.app.inject({
      method: 'GET',
      url: previewUrl({ cron: '0 2 * * *', timezone: 'America/New_York', count: '2', from: '2026-03-07T00:00:00Z' }),
      headers: { cookie },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { times: Array<{ at: string; local: string; skipped: string[] }> }
    // 02:00 exists on 03-07 (EST) and on 03-09 (EDT); 02:00 on 03-08 does not.
    assert.deepEqual(body.times.map((time) => time.at), ['2026-03-07T07:00:00.000Z', '2026-03-09T06:00:00.000Z'])
    assert.deepEqual(body.times.map((time) => time.local), ['2026-03-07 02:00', '2026-03-09 02:00'])
    assert.deepEqual(body.times.map((time) => time.skipped), [[], ['2026-03-08 02:00']])
  } finally {
    await built.close()
  }
})

test('an interval preview has no zone and fires on whole multiples of its length', async () => {
  const { built, cookie } = await fixture()
  try {
    const response = await built.app.inject({
      method: 'GET',
      url: previewUrl({ every: '90s', count: '3', from: '2026-11-16T00:00:00Z' }),
      headers: { cookie },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { schedule: { kind: string; everyMs: number; timezone?: string }; times: Array<{ at: string; local: string | null; offset: string | null; timezone: string | null }>; truncated: boolean }
    assert.equal(body.schedule.kind, 'interval')
    assert.equal(body.schedule.everyMs, 90000)
    assert.equal(body.schedule.timezone, undefined)
    assert.deepEqual(body.times.map((time) => time.at), ['2026-11-16T00:01:30.000Z', '2026-11-16T00:03:00.000Z', '2026-11-16T00:04:30.000Z'])
    assert.deepEqual(body.times.map((time) => time.local), [null, null, null])
    assert.deepEqual(body.times.map((time) => time.offset), [null, null, null])
    assert.deepEqual(body.times.map((time) => time.timezone), [null, null, null])
    assert.equal(body.truncated, false)
  } finally {
    await built.close()
  }
})

test('a window that ends before the count is reported as truncated', async () => {
  const { built, cookie } = await fixture()
  try {
    const response = await built.app.inject({
      method: 'GET',
      url: previewUrl({ cron: '0 9 * * *', timezone: 'UTC', count: '5', from: '2026-11-16T00:00:00Z', end_at: '2026-11-17T12:00:00Z' }),
      headers: { cookie },
    })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { times: Array<{ at: string }>; truncated: boolean }
    assert.deepEqual(body.times.map((time) => time.at), ['2026-11-16T09:00:00.000Z', '2026-11-17T09:00:00.000Z'])
    assert.equal(body.truncated, true)
  } finally {
    await built.close()
  }
})

test('each refusal names the operation that is wrong', async () => {
  const { built, cookie } = await fixture()
  try {
    const zone = await built.app.inject({ method: 'GET', url: previewUrl({ cron: '0 9 * * *', timezone: '+05:00' }), headers: { cookie } })
    assert.equal(zone.statusCode, 400)
    const zoneBody = zone.json() as { error: string }
    assert.ok(zoneBody.error.includes('+05:00'))
    assert.ok(zoneBody.error.includes('fixed UTC offset'))
    assert.ok(zoneBody.error.includes('IANA'))

    const expression = await built.app.inject({ method: 'GET', url: previewUrl({ cron: '0 9 * *', timezone: 'UTC' }), headers: { cookie } })
    assert.equal(expression.statusCode, 400)
    const expressionBody = expression.json() as { error: string }
    assert.ok(expressionBody.error.includes('five fields'))
    assert.ok(expressionBody.error.includes('0 9 * *'))

    const range = await built.app.inject({ method: 'GET', url: previewUrl({ cron: '0 9 * * *', timezone: 'UTC', count: '0' }), headers: { cookie } })
    assert.equal(range.statusCode, 400)
    const rangeBody = range.json() as { error: string }
    assert.ok(rangeBody.error.includes('count'))
    assert.ok(rangeBody.error.includes('between 1 and 20'))

    const both = await built.app.inject({ method: 'GET', url: previewUrl({ cron: '0 9 * * *', every: '1h', timezone: 'UTC' }), headers: { cookie } })
    assert.equal(both.statusCode, 400)
    assert.ok((both.json() as { error: string }).error.includes('not both'))

    const neither = await built.app.inject({ method: 'GET', url: previewUrl({ timezone: 'UTC' }), headers: { cookie } })
    assert.equal(neither.statusCode, 400)
    assert.ok((neither.json() as { error: string }).error.includes('give "cron"'))
    assert.ok((neither.json() as { error: string }).error.includes('"every"'))
  } finally {
    await built.close()
  }
})

test('the console page shows the same local times and keeps the form filled', async () => {
  const { built, cookie } = await fixture()
  try {
    const page = await built.app.inject({
      method: 'GET',
      url: `/schedule?${new URLSearchParams({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai', count: '3', from: '2026-11-16T00:00:00Z' }).toString()}`,
      headers: { cookie },
    })
    assert.equal(page.statusCode, 200)
    assert.ok(page.body.includes('2026-11-16 09:00'))
    assert.ok(page.body.includes('2026-11-17 09:00'))
    assert.ok(page.body.includes('Asia/Shanghai'))
    assert.ok(page.body.includes('name="cron"'))
    assert.ok(page.body.includes('value="0 9 * * 1-5"'))
  } finally {
    await built.close()
  }
})

test('the console page explains a bad expression instead of returning a bare 400', async () => {
  const { built, cookie } = await fixture()
  try {
    const page = await built.app.inject({
      method: 'GET',
      url: `/schedule?${new URLSearchParams({ cron: '0 9 * *', timezone: 'UTC' }).toString()}`,
      headers: { cookie },
    })
    assert.equal(page.statusCode, 400)
    assert.ok(page.body.includes('five fields'))
    assert.ok(page.body.includes('name="cron"'))
    assert.ok(page.body.includes('value="0 9 * *"'))
  } finally {
    await built.close()
  }
})

// The pure half: the two refusals and the two DST shapes the route tests cannot
// pin without a page, asserted against the planner directly.
test('an interval that carries a timezone is refused by name, not silently ignored', async () => {
  const { parsePreviewQuery } = await import('../src/schedules/preview.js')
  const refused = parsePreviewQuery({ every: '1d', timezone: 'Asia/Shanghai' }, Date.parse('2026-11-16T00:00:00Z'))
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.ok(refused.reason.includes('interval has no timezone'))
    assert.ok(refused.reason.includes('"timezone"'))
  }
  const accepted = parsePreviewQuery({ every: '1d' }, Date.parse('2026-11-16T00:00:00Z'))
  assert.equal(accepted.ok, true)
})

test('a whole local day that never existed is reported as skipped, not shifted', async () => {
  const { parsePreviewQuery, previewSchedule } = await import('../src/schedules/preview.js')
  const parsed = parsePreviewQuery({ cron: '0 9 * * *', timezone: 'Pacific/Apia', count: '3', from: '2011-12-28T00:00:00Z' }, 0)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const result = previewSchedule(parsed.request)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.times.map((time) => time.at), ['2011-12-28T19:00:00.000Z', '2011-12-29T19:00:00.000Z', '2011-12-30T19:00:00.000Z'])
  assert.deepEqual(result.times.map((time) => time.local), ['2011-12-28 09:00', '2011-12-29 09:00', '2011-12-31 09:00'])
  assert.deepEqual(result.times.map((time) => time.skipped), [[], [], ['2011-12-30 09:00']])
})

test('a fall-back wall time that happens twice is previewed once, at the earlier instant', async () => {
  const { parsePreviewQuery, previewSchedule } = await import('../src/schedules/preview.js')
  const parsed = parsePreviewQuery({ cron: '30 1 * * *', timezone: 'America/New_York', count: '3', from: '2026-10-31T00:00:00Z' }, 0)
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const result = previewSchedule(parsed.request)
  assert.equal(result.ok, true)
  if (!result.ok) return
  // 01:30 occurs at 05:30Z and again at 06:30Z on 2026-11-01; only the earlier one
  // is a run, and the next run is the following day.
  assert.deepEqual(result.times.map((time) => time.at), ['2026-10-31T05:30:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
  assert.deepEqual(result.times.map((time) => time.offset), ['GMT-4', 'GMT-4', 'GMT-5'])
})

test('the preview refuses a count outside 1..20 and a window it cannot walk', async () => {
  const { previewSchedule } = await import('../src/schedules/preview.js')
  const { parseSchedule } = await import('../src/schedules/next.js')
  const schedule = parseSchedule({ cron: '0 9 * * *', timezone: 'UTC' })
  assert.equal(schedule.ok, true)
  if (!schedule.ok) return
  const tooMany = previewSchedule({ schedule: schedule.schedule, from: Date.parse('2026-11-16T00:00:00Z'), count: 21 })
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) assert.ok(tooMany.reason.includes('count 21 must be a whole number between 1 and 20'))
  const windowed = parseSchedule({ everyMs: 3_600_000, startAt: Date.parse('2026-11-16T00:00:00Z'), endAt: Date.parse('2026-11-16T03:00:00Z') })
  assert.equal(windowed.ok, true)
  if (!windowed.ok) return
  const result = previewSchedule({ schedule: windowed.schedule, from: Date.parse('2026-11-16T00:00:00Z'), count: 5 })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.times.map((time) => time.at), ['2026-11-16T01:00:00.000Z', '2026-11-16T02:00:00.000Z'])
  assert.equal(result.truncated, true)
})
