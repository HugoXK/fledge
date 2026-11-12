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
assert.equal(typeof currentSection, 'function', 'public/section-nav.js must declare currentSection')

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

test('the section nav sticks under the header and offsets its targets', () => {
  const rule = /\.section-nav\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule !== null, 'public/app.css has no .section-nav rule')
  assert.match(rule[1] ?? '', /position:\s*sticky/)
  assert.match(rule[1] ?? '', /top:\s*var\(--header-h\)/)
  assert.match(css, /\.section-nav ~ \.card\[id\]\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--header-h\)\s*\+\s*56px\)/)
})

test('at the document end the last section is current, at every height it was measured', () => {
  // Tops measured in Chromium at 390px wide on the admin page; at the document
  // end the page cannot scroll the audit section into the 20%-40% band, so the
  // rule has to name it from the geometry instead of waiting for an entry.
  const auditTop: Record<number, number> = { 700: 237, 760: 301, 800: 337, 844: 378, 900: 429, 1024: 544 }
  const maxScroll = 1800
  for (const [rawHeight, top] of Object.entries(auditTop)) {
    const height = Number(rawHeight)
    const id = currentSection({
      tops: [{ id: 'jobs', top: -60 }, { id: 'audit', top }],
      bandTop: height * 0.2,
      scrollY: maxScroll,
      scrollHeight: maxScroll + height,
      viewportHeight: height,
    })
    assert.equal(id, 'audit', `at 390x${height} the audit card is on screen (top ${top}, band top ${Math.round(height * 0.2)}) so it must be current`)
  }
})

test('a section taller than the band stays current until the next one takes its place', () => {
  const state = { bandTop: 160, scrollY: 640, scrollHeight: 3000, viewportHeight: 800 }
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
  assert.match(script, /addEventListener\('click',\s*\(\)\s*=>\s*setActive\(entry\.target\.id\)\)/)
  assert.match(script, /setAttribute\('aria-current'/)
})
