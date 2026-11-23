import assert from 'node:assert/strict'
import test from 'node:test'
import { Store, type UserRow } from '../src/db.js'
import { dashboardPage } from '../src/views/pages.js'
import type { ClockState } from '../src/repos/app.js'
import { makeUser, testConfig } from './helpers.js'

// #1198: production sat in `clock: fail` and the console said nothing, so a user
// learned about a refused job only after pressing Run now. The dashboard must
// carry the measurement the admission guard already reads, in both locales, and
// must stay quiet for every state that is not `fail` — a GitHub outage or an
// app-less deployment is not a clock verdict and must not paint a red banner.
//
// The banner also has to be *visible*: the page's existing alert table lives
// inside the collapsed "More" details, so an alert rendered there would satisfy
// a text search while showing nobody anything.

function fixture(): UserRow {
  const store = new Store(':memory:')
  return makeUser(store, { login: 'clock-owner', status: 'approved' })
}

function render(clock: ClockState | undefined, locale: 'zh' | 'en'): string {
  const user = fixture()
  return dashboardPage({
    config: testConfig(),
    locale,
    viewer: { user, csrfToken: 'csrf-token' },
    repos: [],
    jobs: [],
    notifications: [],
    ...(clock === undefined ? {} : { clock }),
  })
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

const failing: ClockState = {
  state: 'fail',
  skewSeconds: 1688,
  measuredAt: '2026-11-20T21:18:44.298Z',
  thresholdSeconds: 120,
}

test('a failing clock puts one critical banner on the dashboard, naming the offset and the threshold', () => {
  for (const locale of ['zh', 'en'] as const) {
    const html = render(failing, locale)
    const banners = html.match(/id="clock-fail"/g) ?? []
    assert.equal(banners.length, 1, `${locale}: expected exactly one clock banner, rendering it ${banners.length} times`)
    assert.equal((html.match(/role="alert"/g) ?? []).length, 1, `${locale}: the clock banner is the page's only alert and announces itself`)
    const opening = html.match(/<div class="banner bad" id="clock-fail"[^>]*>/)?.[0] ?? ''
    assert.match(opening, /role="alert"/, `${locale}: the banner carries role="alert"`)

    const text = textOf(html)
    assert.ok(text.includes('1688'), `${locale}: the banner names the measured offset`)
    assert.ok(text.includes('120'), `${locale}: the banner names the threshold`)
    if (locale === 'zh') {
      assert.ok(text.includes('阈值'), 'zh: the banner labels the threshold in Chinese')
      assert.ok(text.includes('timedatectl set-ntp true'), 'zh: the banner carries the recovery command')
      assert.ok(text.includes('就绪') || text.includes('/readyz'), 'zh: the banner names how recovery is confirmed')
    } else {
      assert.ok(text.includes('threshold'), 'en: the banner labels the threshold in English')
      assert.ok(text.includes('timedatectl set-ntp true'), 'en: the banner carries the recovery command')
      assert.ok(text.includes('/readyz'), 'en: the banner names how recovery is confirmed')
    }
  }
})

test('the clock banner is above the collapsed section, not inside the alert table', () => {
  const html = render(failing, 'en')
  const banner = html.indexOf('id="clock-fail"')
  const secondary = html.indexOf('class="secondary"')
  assert.ok(banner > 0, 'the banner exists')
  assert.ok(secondary > 0, 'the page still has its collapsed secondary section')
  assert.ok(banner < secondary, 'the banner is outside the collapsed "More" section, so it is visible on load')
})

test('no banner for ok, unknown or not-configured', () => {
  const quiet: ClockState[] = [
    { state: 'ok', skewSeconds: 3, measuredAt: '2026-11-20T21:18:44.298Z', thresholdSeconds: 120 },
    { state: 'unknown', skewSeconds: null, measuredAt: null, thresholdSeconds: 120 },
    { state: 'not-configured', skewSeconds: null, measuredAt: null, thresholdSeconds: 120 },
  ]
  for (const clock of quiet) {
    for (const locale of ['zh', 'en'] as const) {
      const html = render(clock, locale)
      assert.equal(html.includes('id="clock-fail"'), false, `${clock.state}/${locale}: a non-fail clock must not paint a banner`)
      assert.equal((html.match(/role="alert"/g) ?? []).length, 0, `${clock.state}/${locale}: no alert is announced`)
    }
  }
})

test('the page is unchanged when the caller has no clock reading', () => {
  for (const locale of ['zh', 'en'] as const) {
    const without = render(undefined, locale)
    const ok = render({ state: 'ok', skewSeconds: 0, measuredAt: '2026-11-20T21:18:44.298Z', thresholdSeconds: 120 }, locale)
    assert.equal(without, ok, `${locale}: an absent clock renders exactly like a healthy one`)
  }
})
