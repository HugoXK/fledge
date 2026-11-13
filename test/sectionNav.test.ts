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

// public/ is served as a classic script, so the shipped file is executed in a
// bare context rather than imported, which runs exactly what the browser runs.
// The page loads section-nav.js before app.js and the two share one global, so
// the context models that shape: `window` is the global object itself, and the
// rule publishes itself on it. The rule is where the marker's decision lives, so
// this is the behavioural half of the suite.
//
// The publication is also the answer to the CodeQL finding at :17 and :35:
// package.json says "type": "module", so a static reader sees this file as a
// module, where a top-level function that no module-local code names is dead
// code. Naming the rule on `window` is the caller, and it is the same statement
// the browser relies on -- behaviour is unchanged, because a classic script's
// top-level functions were already properties of window.
const sandbox = vm.createContext({}) as Record<string, unknown>
vm.runInContext('window = globalThis', sandbox)
vm.runInContext(sectionNavScript, sandbox)
const page = sandbox.window as { SectionNav?: { currentSection?: unknown; scrollBandTop?: unknown } }
const currentSection = page.SectionNav?.currentSection as (state: SectionState) => string | null
const scrollBandTop = page.SectionNav?.scrollBandTop as (viewportHeight: number, scrollMarginTop: number) => number
assert.equal(typeof currentSection, 'function', 'public/section-nav.js must publish currentSection on window.SectionNav')
assert.equal(typeof scrollBandTop, 'function', 'public/section-nav.js must publish scrollBandTop on window.SectionNav')

// The anchor offset as the browser computes it: the sticky header plus the nav.
// scroll-margin-top is `calc(var(--header-h) + var(--nav-h))`, so both numbers
// are read back from the stylesheet instead of being written a second time
// here -- a literal 65/69 kept passing after the header moved to one token and
// the tests would have gone on asserting a bar the page no longer drew.
const pixelToken = (name: string): number => {
  const values = [...css.matchAll(new RegExp(`${name}:\\s*(\\d+)px`, 'g'))].map((match) => Number(match[1]))
  assert.ok(values.length > 0, `public/app.css must declare ${name} in px`)
  assert.equal(new Set(values).size, 1, `${name} must not disagree between breakpoints: ${values.join(', ')}px`)
  return values[0] ?? 0
}
const scrollMargin = pixelToken('--header-h') + pixelToken('--nav-h')

function render(picker: 'settings' | 'admin'): string {
  const store = new Store(':memory:')
  const user = makeUser(store, { admin: picker === 'admin' })
  const viewer = { user, csrfToken: 'csrf-token' }
  const config = testConfig()
  // main added the session list and its current-row marker to the settings page;
  // the nav has to keep working over the page as it renders today.
  if (picker === 'settings') return settingsPage({ config, locale: 'en', viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [] })
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

// The other direction: a card can exist in the page with no chip naming it,
// which no chip->card assertion can see. main's #423 added `#sessions` that way
// and the marker went on saying "API tokens" while the reader was in Sessions.
function cardIds(html: string): string[] {
  const ids: string[] = []
  for (const tag of html.matchAll(/<([a-zA-Z][\w:-]*)([^<>]*)>/g)) {
    const attrs = tag[2] ?? ''
    const classes = (/\sclass="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/)
    if (!classes.includes('card')) continue
    const id = /\sid="([^"]*)"/.exec(attrs)?.[1]
    if (id !== undefined) ids.push(id)
  }
  return ids
}

test('a card is any element whose class list contains card, in document order', () => {
  assert.deepEqual(cardIds('<section class="card wide" id="wide"></section>'), ['wide'])
  assert.deepEqual(cardIds('<details class="card narrow mt-24" id="t"></details>'), ['t'])
  assert.deepEqual(cardIds('<div class="card" id="d"></div>'), ['d'])
  assert.deepEqual(cardIds('<div id="first" class="card"></div>'), ['first'])
  assert.deepEqual(
    cardIds('<div class="wide card" data-x="1" id="second"></div><section id="third" class="card narrow"></section>'),
    ['second', 'third'],
  )
  assert.deepEqual(cardIds('<div class="cardinal" id="no"></div><div class="card"><span id="nested"></span></div>'), [])
})

test('every card with an id is named by exactly one chip, in document order', () => {
  for (const picker of ['settings' as const, 'admin' as const]) {
    const html = render(picker)
    const cards = cardIds(html)
    const chips = navTargets(html)
    assert.ok(cards.length > 0, `the ${picker} page has no section.card with an id`)
    assert.deepEqual(chips, cards, `every ${picker} card must have one chip, in the order the page draws them`)
    assert.equal(new Set(chips).size, chips.length, `the ${picker} nav must not repeat a chip`)
  }
})

test('every nav chip resolves to exactly one section in the same rendered page', () => {
  const pages = [
    { picker: 'settings' as const, ids: ['account', 'model-providers', 'notifications', 'tokens', 'sessions'] },
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
  // bar; a hardcoded 56px left an anchored section 4px under the bar in
  // Chromium, so the offset and the bar read the same token, and the arithmetic
  // below reads it from the stylesheet rather than repeating the number.
  assert.match(css, /\.section-nav ~ \.card\[id\]\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--header-h\)\s*\+\s*var\(--nav-h\)\)/)
  assert.equal(pixelToken('--nav-h'), pixelToken('--space-2') * 2 + pixelToken('--touch') + 1, 'the bar token must equal its parts')
})

test('at the document end the last section is current, at every height it was measured', () => {
  // Tops measured in Chromium at 390px wide on the admin page; at the document
  // end the page cannot scroll the audit section into the band, so the rule has
  // to name it from the geometry instead of waiting for an entry.
  const auditTop: Record<number, number> = { 700: 237, 760: 301, 800: 337, 844: 378, 900: 429, 1024: 544 }
  const maxScroll = 1800
  for (const [rawHeight, top] of Object.entries(auditTop)) {
    const height = Number(rawHeight)
    const band = scrollBandTop(height, scrollMargin)
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
  // the last card parks under the sticky bar -- header + nav, read from the
  // stylesheet -- so only the document-end branch can name it.
  const band = scrollBandTop(390, scrollMargin)
  assert.equal(band, scrollMargin + 1, 'the bar sits below 20% of a 390px viewport')
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
  // The verdict's live case: after a tap the target parks at the anchor offset
  // (header + nav, read from the stylesheet) while a raw 20% band starts at
  // 78px, so the scroll handler put the previous chip back. The band is the
  // bar's bottom edge.
  const band = scrollBandTop(390, scrollMargin)
  assert.equal(band, scrollMargin + 1, 'at 390 tall the bar, not 20% of the viewport, sets the band')
  const state = { scrollY: 900, scrollHeight: 2600, viewportHeight: 390 }
  assert.equal(
    currentSection({ ...state, bandTop: band, tops: [{ id: 'users', top: -948 }, { id: 'jobs', top: scrollMargin }] }),
    'jobs',
    "the tapped section parked on the bar's bottom edge is the current one",
  )
  assert.equal(
    currentSection({ ...state, bandTop: 390 * 0.2, tops: [{ id: 'users', top: -948 }, { id: 'jobs', top: scrollMargin }] }),
    'users',
    'the old 20% band is what put the previous chip back, so it must fail here',
  )
  assert.equal(
    currentSection({ ...state, bandTop: band, tops: [{ id: 'users', top: -948 }, { id: 'jobs', top: scrollMargin + 3 }] }),
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
  const state = { bandTop: scrollBandTop(800, scrollMargin), scrollY: 640, scrollHeight: 3000, viewportHeight: 800 }
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
  assert.match(script, /sectionNavRule\.currentSection\(/)
  assert.match(script, /bandTop:\s*sectionNavRule\.scrollBandTop\(window\.innerHeight, anchorOffset\)/)
  assert.doesNotMatch(script, /bandTop:\s*window\.innerHeight \* 0\.2/, 'the raw 20% band is the defect the anchor case names')
  assert.match(script, /addEventListener\('click',\s*\(\)\s*=>\s*setActive\(entry\.target\.id\)\)/)
  assert.match(script, /setAttribute\('aria-current'/)
})

test('app.js reaches the rule through the name the rule publishes, not a bare global', () => {
  // The two files share one global because the page loads them as classic
  // scripts, but nothing in either file said so: app.js read two names that only
  // exist because of how its sibling happens to be served. Naming the contract
  // on `window.SectionNav` is also what gives the rule a caller that survives
  // package.json's "type": "module" -- the CodeQL finding at public/section-nav.js
  // :17 and :35 is exactly "no caller is visible".
  assert.match(script, /window\.SectionNav/, 'public/app.js must take the rule from window.SectionNav')
  assert.doesNotMatch(script, /[^.\w]currentSection\(\{/, 'a bare currentSection( call is the implicit global the finding names')
  assert.doesNotMatch(script, /[^.\w]scrollBandTop\(window\.innerHeight/, 'a bare scrollBandTop( call is the implicit global the finding names')
})
