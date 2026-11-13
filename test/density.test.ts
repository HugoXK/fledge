// #473: the table header has to stay above the rows it labels, and a desktop
// reader has to be able to fit more than eight audit rows on one screen.
//
// Both halves are computed from what the server sends or from rules parsed out
// of the real stylesheet: the route is an `app.inject` response, the sticky
// header and the density are read from `public/app.css`. Nothing greps for a
// literal that would survive a deleted rule.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'
import { conditionHolds, declarationsFor, parseRules, pxValue, type StyleRule } from './cssRules.js'

const CSS = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

// The top of a `padding` shorthand is its first value; `6px 10px` is 6.
function paddingTop(rules: StyleRule[], selector: string, width: number): number {
  const padding = declarationsFor(rules, selector, width).find((entry) => entry.property === 'padding')?.value
  assert.ok(padding !== undefined, `${selector} has no padding declaration at ${width}px`)
  const top = pxValue(padding.split(/\s+/)[0] ?? '')
  assert.ok(top !== null && top !== undefined, `${selector} padding is not in px: ${padding}`)
  return top
}

test('#473: /density/:mode saves the choice and refuses an unknown mode or an off-site next', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const compact = await built.app.inject({ method: 'GET', url: '/density/compact?next=/dashboard' })
    assert.equal(compact.statusCode, 302)
    assert.equal(compact.headers.location, '/dashboard')
    assert.match(String(compact.headers['set-cookie']), /fledge_density=compact/)

    const comfortable = await built.app.inject({ method: 'GET', url: '/density/comfortable?next=/admin' })
    assert.equal(comfortable.statusCode, 302)
    assert.equal(comfortable.headers.location, '/admin')
    assert.match(String(comfortable.headers['set-cookie']), /fledge_density=comfortable/)

    // An unknown mode is refused rather than silently treated as the default.
    const unknown = await built.app.inject({ method: 'GET', url: '/density/sideways?next=/admin' })
    assert.equal(unknown.statusCode, 404)

    // `next` goes through the same same-origin contract as `/lang/:locale`.
    const offsite = await built.app.inject({ method: 'GET', url: '/density/compact?next=https%3A%2F%2Fevil.example%2Fsteal' })
    assert.equal(offsite.statusCode, 302)
    assert.equal(offsite.headers.location, '/')
  } finally {
    await built.close()
  }
})

test('#473: the rendered document carries the saved density, comfortable when nothing is saved', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'owner', status: 'approved' })
    const { cookie } = sessionFor(built, user)

    const saved = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: `${cookie}; fledge_density=compact` } })
    assert.equal(saved.statusCode, 200)
    assert.match(saved.body, /<html[^>]*data-density="compact"/)

    const fallback = await built.app.inject({ method: 'GET', url: '/dashboard', headers: { cookie } })
    assert.equal(fallback.statusCode, 200)
    assert.match(fallback.body, /<html[^>]*data-density="comfortable"/)
  } finally {
    await built.close()
  }
})

test('#473: the sticky thead and the bounded scrollport are one contract', () => {
  const rules = parseRules(CSS)

  // A `position: sticky` child of an unbounded scroller never sticks, so the
  // scroller must carry a vertical bound that leaves room for the page header.
  const bounded = rules.find((rule) => {
    if (!rule.selectors.includes('.table-scroll')) return false
    const declarations = rule.declarations
    const vertical = declarations.find((entry) => entry.property === 'overflow-y')?.value === 'auto'
    const bound = declarations.find((entry) => entry.property === 'max-height')?.value ?? ''
    return vertical && bound.includes('100dvh') && bound.includes('var(--header-h)')
  })
  assert.ok(
    bounded !== undefined,
    'sticky without a bounded scrollport does nothing: .table-scroll needs overflow-y: auto and a max-height that subtracts var(--header-h) from 100dvh',
  )

  // Two layers already stick above a repository page: the header and the
  // repository subnav. A bound that ignores the subnav parks the thead under it.
  const subnavBound = rules.find((rule) => {
    if (!rule.selectors.includes('.repo-page .table-scroll')) return false
    const bound = rule.declarations.find((entry) => entry.property === 'max-height')?.value ?? ''
    return bound.includes('var(--subnav-h)')
  })
  assert.ok(
    subnavBound !== undefined,
    'a bound that ignores the subnav parks the thead under it: .repo-page .table-scroll must subtract var(--subnav-h)',
  )

  const stickyHeaders = rules.filter((rule) => {
    if (!rule.selectors.some((selector) => /(^|[\s>])thead th$/.test(selector.trim()))) return false
    return rule.declarations.some((entry) => entry.property === 'position' && entry.value === 'sticky')
  })
  assert.ok(stickyHeaders.length > 0, 'no thead th is position: sticky, so the column names still scroll away')
  for (const rule of stickyHeaders) {
    const background = rule.declarations.find((entry) => entry.property === 'background' || entry.property === 'background-color')
    assert.ok(background !== undefined, `a sticky header needs an opaque background: ${rule.selectors.join(', ')}`)
    assert.doesNotMatch(background.value, /transparent|none|rgba\([^)]*,\s*0\s*\)/, `a sticky header must not be see-through: ${rule.selectors.join(', ')}`)
  }
})

test('#473: compact is shorter than comfortable on a table, and a phone keeps its card layout', () => {
  const rules = parseRules(CSS)
  const compactSelector = 'html[data-density="compact"] td'
  const comfortableSelector = 'html[data-density="comfortable"] td'

  const compact = paddingTop(rules, compactSelector, 1280)
  const comfortable = paddingTop(rules, comfortableSelector, 1280)
  assert.ok(
    compact < comfortable,
    `compact density is not shorter than comfortable (${compact}px vs ${comfortable}px)`,
  )

  // Below 641px every table becomes a card, one cell per line, and the 44px
  // touch floor inside those cards is the documented layout (#130). A density
  // rule that reached that band would shrink the cards, not the table.
  const compactRules = rules.filter((rule) => rule.selectors.some((selector) => selector.includes('[data-density="compact"]')))
  assert.ok(compactRules.length > 0, 'no compact density rule at all')
  for (const rule of compactRules) {
    assert.equal(
      conditionHolds(rule.media ?? '', 360),
      false,
      `a compact rule also applies at 360px, where the table is a card stack: ${rule.selectors.join(', ')}`,
    )
  }
})
