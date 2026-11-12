import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { Store } from '../src/db.js'
import { adminPage, settingsPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const sectionNavScript = readFileSync(new URL('../public/section-nav.js', import.meta.url), 'utf8')

interface SectionState {
  tops: { id: string; top: number }[]
  bandTop: number
  scrollY: number
  scrollHeight: number
  viewportHeight: number
}

// public/ is served as a classic script -- it declares the rule as a global and
// the page calls it -- so the shipped file is run in a bare context rather than
// imported, which executes exactly what the browser executes. The rule is where
// the marker's decision lives, so this is the behavioural half of the suite.
const sandbox: Record<string, unknown> = {}
vm.runInNewContext(sectionNavScript, sandbox)
const currentSection = sandbox.currentSection as (state: SectionState) => string | null
const scrollBandTop = sandbox.scrollBandTop as (viewportHeight: number, scrollMarginTop: number) => number
assert.equal(typeof currentSection, 'function', 'public/section-nav.js must declare currentSection')
assert.equal(typeof scrollBandTop, 'function', 'public/section-nav.js must declare scrollBandTop')

// The anchor offset as the browser computes it: the sticky header plus the nav
// (65/69 header + 61px nav at 390/844-wide and desktop). scroll-margin-top is
// the single source of that number, so the tests read it back instead of
// writing a second copy of it.
const scrollMargin = { mobile: 65 + 61, desktop: 69 + 61 }

function render(picker: 'settings' | 'admin'): string {
  const store = new Store(':memory:')
  const user = makeUser(store, { admin: picker === 'admin' })
  const viewer = { user, csrfToken: 'csrf-token' }
  const config = testConfig()
  if (picker === 'settings') return settingsPage({ config, locale: 'en', viewer, tokens: [], providers: [] })
  return adminPage({
    config,
    locale: 'en',
    viewer,
    users: [user],
    jobs: [],
    jobsPage: 1,
    jobsTotal: 0,
    audit: [],
    auditPage: 1,
    auditTotal: 0,
    perPage: 10,
    superadmin: true,
  })
}

function navTargets(html: string): string[] {
  const nav = /<nav class="section-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)
  assert.ok(nav !== null, 'the page has no .section-nav')
  return [...(nav[1] ?? '').matchAll(/href="#([^"]+)"/g)].map((match) => match[1] ?? '')
}

function idCounts(html: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
    const id = match[1] ?? ''
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

test('every nav chip resolves to exactly one section in the same rendered page', () => {
  const pages = [
    { picker: 'settings' as const, ids: ['account', 'model-providers', 'notifications', 'tokens'] },
    { picker: 'admin' as const, ids: ['release', 'release-chain', 'backups', 'pending', 'users', 'jobs', 'audit'] },
  ]
  for (const page of pages) {
    const html = render(page.picker)
    assert.deepEqual(navTargets(html), page.ids, `the ${page.picker} nav points somewhere else`)
    const counts = idCounts(html)
    for (const id of page.ids) {
      assert.equal(counts.get(id), 1, `the ${page.picker} page must carry id="${id}" exactly once, not ${counts.get(id) ?? 0}`)
    }
  }
})

test('the section nav sticks under the header and offsets its targets by its own height', () => {
  const rule = /\.section-nav\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule !== null, 'public/app.css has no .section-nav rule')
  assert.match(rule[1] ?? '', /position:\s*sticky/)
  assert.match(rule[1] ?? '', /top:\s*var\(--header-h\)/)
  // 8px + 8px padding, the 44px touch target and the 1px bottom rule make the
  // bar 61px tall; a hardcoded 56px left an anchored section 4px under the bar
  // in Chromium, so the offset reads the same token the bar is built from.
  assert.match(css, /--nav-h:\s*61px/)
  assert.match(css, /\.section-nav ~ \.card\[id\]\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--header-h\)\s*\+\s*var\(--nav-h\)\)/)
  // The bar is 8+8 padding, the 44px target and the 1px bottom rule; the offset
  // and the bar read the same token, so the two numbers cannot drift apart again.
  const token = (name: string): number => Number(new RegExp(`${name}:\\s*(\\d+)px`).exec(css)?.[1])
  assert.equal(token('--nav-h'), token('--space-2') * 2 + token('--touch') + 1)
})

test('at the document end the last section is current, at every height it was measured', () => {
  // Tops measured in Chromium at 390px wide on the admin page; at the document
  // end the page cannot scroll the audit section into the band, so the rule has
  // to name it from the geometry instead of waiting for an entry.
  const auditTop: Record<number, number> = { 700: 237, 760: 301, 800: 337, 844: 378, 900: 429, 1024: 544 }
  const maxScroll = 1800
  for (const [rawHeight, top] of Object.entries(auditTop)) {
    const height = Number(rawHeight)
    const band = scrollBandTop(height, scrollMargin.mobile)
    const id = currentSection({
      tops: [{ id: 'jobs', top: -60 }, { id: 'audit', top }],
      bandTop: band,
      scrollY: maxScroll,
      scrollHeight: maxScroll + height,
      viewportHeight: height,
    })
    assert.equal(id, 'audit', `at 390x${height} the audit card is on screen (top ${top}, band top ${band}) so it must be current`)
  }
})

test('at 844x390 the document end still marks the last section', () => {
  // The review's landscape case: 390px tall, 20% of the viewport is 78px while
  // the last card parks under a 126px bar, so only the document-end branch can
  // name it.
  const band = scrollBandTop(390, scrollMargin.mobile)
  assert.equal(band, 127, 'the bar (126px offset) sits below 20% of a 390px viewport')
  assert.equal(
    currentSection({
      tops: [{ id: 'jobs', top: -300 }, { id: 'audit', top: 60 }],
      bandTop: band,
      scrollY: 2210,
      scrollHeight: 2600,
      viewportHeight: 390,
    }),
    'audit',
  )
})

test('a chip tapped at 844x390 keeps the marker on its section', () => {
  // The verdict's live measurement: after a tap the target parks at 126px
  // (header 65 + nav 61), while a raw 20% band starts at 78px, so the scroll
  // handler put the previous chip back. The band is the bar's bottom edge.
  const band = scrollBandTop(390, scrollMargin.mobile)
  assert.equal(band, 127, 'at 390 tall the bar, not 20% of the viewport, sets the band')
  const state = { scrollY: 900, scrollHeight: 2600, viewportHeight: 390 }
  assert.equal(
    currentSection({ ...state, bandTop: band, tops: [{ id: 'users', top: -948 }, { id: 'jobs', top: 126 }] }),
    'jobs',
    "the tapped section parked on the bar's bottom edge is the current one",
  )
  assert.equal(
    currentSection({ ...state, bandTop: 390 * 0.2, tops: [{ id: 'users', top: -948 }, { id: 'jobs', top: 126 }] }),
    'users',
    'the old 20% band is what put the previous chip back, so it must fail here',
  )
  assert.equal(
    currentSection({ ...state, bandTop: band, tops: [{ id: 'users', top: -948 }, { id: 'jobs', top: 130 }] }),
    'users',
    'a section still below the bar has not become current',
  )
})

test('390 tall with a 121px anchor offset still marks the tapped section', () => {
  // Chief's pinned form: band = max(20% of 390, 121 + 1) = 122, so the target
  // parked at the 121px offset counts as passed at rest.
  const band = scrollBandTop(390, 121)
  assert.equal(band, 122)
  assert.equal(
    currentSection({
      tops: [{ id: 'users', top: -948 }, { id: 'jobs', top: 121 }],
      bandTop: band,
      scrollY: 900,
      scrollHeight: 2600,
      viewportHeight: 390,
    }),
    'jobs',
  )
})

test('a section taller than the band stays current until the next one takes its place', () => {
  const state = { bandTop: scrollBandTop(800, scrollMargin.desktop), scrollY: 640, scrollHeight: 3000, viewportHeight: 800 }
  assert.equal(
    currentSection({ ...state, tops: [{ id: 'account', top: -420 }, { id: 'tokens', top: 1500 }] }),
    'account',
    'the reader is still inside the tall account section',
  )
  assert.equal(
    currentSection({ ...state, tops: [{ id: 'account', top: -900 }, { id: 'tokens', top: 120 }] }),
    'tokens',
    'the next section has passed the band top, so it is current',
  )
  assert.equal(
    currentSection({ ...state, tops: [{ id: 'account', top: 40 }, { id: 'tokens', top: 900 }] }),
    'account',
    'nothing has passed the band top at the page start, so the first section is current',
  )
})

test('the page loads the rule before the script that uses it, and a tap marks its own chip', () => {
  const html = render('settings')
  const ruleAt = html.indexOf('src="/assets/section-nav.js"')
  const appAt = html.indexOf('src="/assets/app.js"')
  assert.ok(ruleAt !== -1 && appAt !== -1 && ruleAt < appAt, 'section-nav.js must load before app.js')
  assert.match(script, /currentSection\(/)
  assert.match(script, /bandTop:\s*scrollBandTop\(window\.innerHeight, anchorOffset\)/)
  assert.doesNotMatch(script, /bandTop:\s*window\.innerHeight \* 0\.2/, 'the raw 20% band is the defect the anchor case names')
  assert.match(script, /addEventListener\('click',\s*\(\)\s*=>\s*setActive\(entry\.target\.id\)\)/)
  assert.match(script, /setAttribute\('aria-current'/)
})
