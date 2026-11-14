import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #677: the page and the JSON preview read the same query, so the form has to
// submit at most one value per name the request reads. All four clock panels
// used to post `time`, Fastify handed the handler an array, the allowlist in
// `previewQuery` drops non-string values, and every schedule fell back to the
// 09:00 default whatever the person picked.
//
// These tests read the rendered form and submit its fields the way a browser
// does, so the reproduction keeps holding if the markup changes. A duplicated
// name shows up as a repeated query key, which is exactly what broke it.

async function fixture() {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'form-owner', status: 'approved' })
  const { cookie } = sessionFor(built, user)
  return { built, cookie }
}

function decode(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_whole, name: string) => entities[name] ?? '')
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)
  return match === null ? undefined : decode(match[1] ?? '')
}

function optionSelected(tag: string): boolean {
  return /\sselected(?=[\s>/])/.test(tag)
}

/** The fields a browser submits for the schedule form, in document order. */
function submittedFields(html: string): Array<[string, string]> {
  const form = /<form\b[^>]*data-schedule-form[^>]*>([\s\S]*?)<\/form>/.exec(html)
  assert.ok(form !== null, 'the schedule page renders its form')
  const markup = form[1] ?? ''
  const fields: Array<[string, string]> = []
  for (const [tag] of markup.matchAll(/<input\b[^>]*>/g)) {
    const name = attr(tag, 'name')
    const type = attr(tag, 'type') ?? 'text'
    if (name === undefined || type === 'submit' || type === 'button' || type === 'reset') continue
    // A browser submits only the checked member of a radio/checkbox group; the
    // schedule form has none today, so skip them rather than guess.
    if (type === 'checkbox' || type === 'radio') continue
    fields.push([name, attr(tag, 'value') ?? ''])
  }
  for (const select of markup.matchAll(/<select\b[^>]*>([\s\S]*?)<\/select>/g)) {
    const name = attr(select[0], 'name')
    if (name === undefined) continue
    const options = [...(select[1] ?? '').matchAll(/<option\b[^>]*>/g)].map(([tag]) => tag)
    const chosen = options.find((tag) => optionSelected(tag)) ?? options[0]
    fields.push([name, chosen === undefined ? '' : (attr(chosen, 'value') ?? '')])
  }
  return fields
}

function asQuery(fields: Array<[string, string]>): string {
  return fields.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')
}

// Open the page as a person would, then submit the form it rendered.
async function submitRenderedForm(path: string): Promise<{ fields: Array<[string, string]>; query: string }> {
  const { built, cookie } = await fixture()
  try {
    const page = await built.app.inject({ method: 'GET', url: path, headers: { cookie } })
    assert.equal(page.statusCode, 200, `${path} renders`)
    const fields = submittedFields(page.body)
    return { fields, query: asQuery(fields) }
  } finally {
    await built.close()
  }
}

async function previewOf(query: string): Promise<{ expression: string; timezone: string }> {
  const { built, cookie } = await fixture()
  try {
    const response = await built.app.inject({ method: 'GET', url: `/api/schedule/preview?${query}`, headers: { cookie } })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as { schedule: { kind: string; expression: string; timezone: string } }
    assert.equal(body.schedule.kind, 'cron')
    return { expression: body.schedule.expression, timezone: body.schedule.timezone }
  } finally {
    await built.close()
  }
}

test('the form submits one value per name, so no field is duplicated', async () => {
  const { fields } = await submitRenderedForm('/schedule?mode=daily&time=10:30')
  const names = fields.map(([name]) => name)
  const duplicated = names.filter((name, index) => names.indexOf(name) !== index)
  assert.deepEqual(duplicated, [], `the form submits a duplicated field: ${duplicated.join(', ')}`)
})

test('the daily form previews the picked time, not the 09:00 default', async () => {
  const { fields, query } = await submitRenderedForm('/schedule?mode=daily&time=10:30')
  assert.ok(fields.length > 0)
  const preview = await previewOf(query)
  assert.equal(preview.expression, '30 10 * * *')
})

test('the weekdays form previews the picked time', async () => {
  const { query } = await submitRenderedForm('/schedule?mode=weekdays&time=06:05')
  const preview = await previewOf(query)
  assert.equal(preview.expression, '5 6 * * 1-5')
})

test('the weekly form previews the picked weekday and time', async () => {
  const { query } = await submitRenderedForm('/schedule?mode=weekly&time=07:15&weekday=3')
  const preview = await previewOf(query)
  assert.equal(preview.expression, '15 7 * * 3')
})

test('the monthly form previews the picked day and time', async () => {
  const { query } = await submitRenderedForm('/schedule?mode=monthly&time=18:45&month_day=15')
  const preview = await previewOf(query)
  assert.equal(preview.expression, '45 18 15 * *')
})

test('the page it renders after the submit shows the picked schedule', async () => {
  const { built, cookie } = await fixture()
  try {
    const page = await built.app.inject({ method: 'GET', url: '/schedule?mode=daily&time=10:30', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    const query = asQuery(submittedFields(page.body))
    const after = await built.app.inject({ method: 'GET', url: `/schedule?${query}`, headers: { cookie } })
    assert.equal(after.statusCode, 200, after.body)
    assert.match(after.body, /<code>30 10 \* \* \*<\/code>/)
  } finally {
    await built.close()
  }
})

test('the documented single-time API call still builds the schedule', async () => {
  const preview = await previewOf('mode=daily&time=10:30&timezone=UTC')
  assert.equal(preview.expression, '30 10 * * *')
})
