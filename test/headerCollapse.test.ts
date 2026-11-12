import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { layout } from '../src/views/layout.js'
import { makeUser, testConfig } from './helpers.js'
import { runApp } from './stubDom.js'

// #133: on a phone the sticky header filled a quarter to a third of the
// viewport (125 / 194.9 / 255.9px measured at 360 in #94 and the phone matrix)
// because nothing collapsed. The contract below is the one the issue can hold
// without a layout engine: the header is a FIXED height at phone widths, so no
// wrapping, locale or font-size change can grow it, and every destination the
// open header lists today is still reachable through one toggle.

const cssText = (): string => readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const jsText = (): string => readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped} \\{([^}]*)\\}`))
  assert.ok(match !== null, `public/app.css has no rule for ${selector}`)
  return match[1] ?? ''
}

function mediaBlock(css: string, media: string): string {
  const start = css.indexOf(`@media ${media}`)
  assert.ok(start !== -1, `public/app.css has no @media ${media} block`)
  const open = css.indexOf('{', start)
  const body = css.slice(open + 1)
  const end = body.indexOf('\n}')
  assert.ok(end !== -1, `the @media ${media} block is not closed`)
  return body.slice(0, end)
}

function render(): string {
  const store = new Store(':memory:')
  const user = makeUser(store, { admin: true })
  return layout({ title: 'x', viewer: { user, csrfToken: 'csrf-token' }, body: '', config: testConfig(), locale: 'en', path: '/dashboard' })
}

test('the collapsed header offers one menu toggle that owns the navigation', () => {
  const html = render()
  const toggle = /<button[^>]*data-nav-toggle[^>]*>/.exec(html)?.[0]
  assert.ok(toggle !== undefined, 'the header must render a menu toggle; without one the nav is unreachable once it is collapsed')
  assert.match(toggle, /aria-expanded="false"/, 'the toggle must start collapsed and say so')
  assert.match(toggle, /aria-controls="main-nav"/, 'the toggle must name the element it opens')
  assert.match(toggle, /type="button"/, 'the toggle is a button, not a form submit')
  assert.match(html, /<nav class="nav" id="main-nav"/, 'the navigation must carry the id the toggle controls')
  for (const href of ['/console', '/dashboard', '/settings', '/admin']) {
    assert.match(html, new RegExp(`href="${href}"`), `the collapsed menu must still reach ${href}`)
  }
})

test('at phone widths the header is a fixed height, not a wrapped block', () => {
  const css = cssText()
  const phone = mediaBlock(css, '(max-width: 640px)')
  assert.match(phone, /\.top-inner\s*\{[^}]*height:\s*\d+px/, 'the phone header must declare a fixed height so no wrap can grow it')
  assert.match(phone, /\.top-inner\s*\{[^}]*flex-wrap:\s*nowrap/, 'the running title may not wrap into extra rows on a phone')
  assert.match(phone, /--header-h:\s*\d+px/, 'the phone breakpoint must re-declare --header-h for its own collapsed height')
  const declared = Number(/--header-h:\s*(\d+)px/.exec(phone)?.[1])
  assert.ok(declared <= 90, `the phone --header-h fallback is ${declared}px; the issue bounds the collapsed header at 90px`)

  const nav = /\.top \.nav\s*\{([^}]*)\}/.exec(phone)?.[1] ?? ''
  assert.match(nav, /display:\s*none/, 'the navigation must be collapsed by default on a phone')
  assert.match(nav, /position:\s*absolute/, 'the open menu must overlay the page, so the sticky header keeps its collapsed height instead of growing while the menu is open')
  assert.match(phone, /\.top\[data-nav-open="true"\]\s+\.nav\s*\{[^}]*display:\s*flex/, 'the toggle must reveal the same navigation it hides')
})

test('the toggle script keeps aria-expanded, Escape and the sticky offset honest', () => {
  const script = jsText()
  // A guard, not the evidence: these assertions pin tokens, and a token is not
  // behaviour (this regex passes on `data-nav-open-typo`). The behaviour test
  // below runs the shipped script; both are kept.
  assert.match(script, /data-nav-toggle/, 'public/app.js must wire the menu toggle')
  assert.match(script, /aria-expanded/, 'the toggle state lives in aria-expanded, not only in a class')
  assert.match(script, /Escape/, 'a keyboard user must be able to close the menu')
  assert.match(script, /data-nav-open/, 'the open state must reach the header element the CSS keys on')
  // The offset must stay the collapsed height while the menu is open: the
  // observed element is the header box, and the menu is absolutely positioned.
  assert.match(script, /querySelector\(['"]\.top['"]\)/, 'the observed header stays .top')
})

test('the toggle opens and closes the panel, closes on Escape and on a link, and never moves the sticky offset', () => {
  // #133 acceptance 5, in the instrument it names: the shipped script runs in a
  // stub DOM, so a token that is never wired fails here even though the source
  // still contains it.
  const app = runApp({ resizeObserver: true, headerHeight: 65 })
  assert.equal(app.ariaExpanded(), 'false', 'the toggle starts collapsed')
  assert.equal(app.navOpen(), null, 'the header starts without the open state')
  assert.equal(app.properties.get('--header-h'), '65px', 'the offset follows the measured header')

  app.clickToggle()
  assert.equal(app.ariaExpanded(), 'true', 'a click must open the panel and say so')
  assert.equal(app.navOpen(), 'true', 'the open state must reach .top, which is what the CSS keys on')
  assert.equal(app.properties.get('--header-h'), '65px', 'an open panel overlays the page: the sticky offset must not move')

  app.clickToggle()
  assert.equal(app.ariaExpanded(), 'false', 'a second click must close it')
  assert.equal(app.navOpen(), null, 'closing must remove the open state, not leave a stale attribute')

  app.clickToggle()
  assert.equal(app.ariaExpanded(), 'true')
  app.pressEscape()
  assert.equal(app.ariaExpanded(), 'false', 'Escape must close the menu')
  assert.equal(app.navOpen(), null)
  assert.equal(app.focused(), 1, 'Escape must return focus to the toggle, not drop it on the body')
  app.pressEscape()
  assert.equal(app.focused(), 1, 'Escape while closed must not move focus')

  app.clickToggle()
  assert.equal(app.ariaExpanded(), 'true')
  app.clickPanelLink()
  assert.equal(app.ariaExpanded(), 'false', 'following a link in the panel must close it')

  app.clickToggle()
  assert.equal(app.ariaExpanded(), 'true')
  app.changeMedia()
  assert.equal(app.ariaExpanded(), 'false', 'leaving the phone band must close the menu')
})

test('an engine whose matchMedia result has only addListener still wires the rest of the page', () => {
  // Safari <= 13.1 has matchMedia and MediaQueryList#addListener but no
  // #addEventListener; an unguarded call throws and the rest of the IIFE never
  // runs. The [data-auto-group] wiring below the menu block is the observable.
  const legacy = runApp({ media: 'legacy' })
  assert.equal(legacy.autoSelectDisabled(), true, 'the widgets after the menu block must still wire without addEventListener')
  legacy.clickToggle()
  assert.equal(legacy.ariaExpanded(), 'true', 'the toggle must work on an engine with only addListener')
  legacy.changeMedia()
  assert.equal(legacy.ariaExpanded(), 'false', 'the legacy listener must still close the menu when the band changes')

  // An engine with neither method must not throw either.
  const bare = runApp({ media: 'none' })
  assert.equal(bare.autoSelectDisabled(), true, 'a matchMedia result with no listener API must not abort the script')
  bare.clickToggle()
  assert.equal(bare.ariaExpanded(), 'true')
})


test('the toggle is hidden above the phone band, where its panel does not exist', () => {
  const css = cssText()
  // The toggle is emitted for every viewer at every width (src/views/layout.ts),
  // so a base rule outside every breakpoint must hide it; only the phone block
  // turns it on. Every other assertion in this file reads inside the phone
  // block, which is how a visible toggle that cannot act shipped green.
  const phoneStart = css.indexOf('@media (max-width: 640px)')
  assert.ok(phoneStart !== -1, 'public/app.css has no @media (max-width: 640px) block')
  const base = /\n\.nav-toggle\s*\{([^}]*)\}/.exec(css)
  assert.ok(base !== null, 'public/app.css must carry a base .nav-toggle rule outside the phone block')
  assert.ok((base?.index ?? 0) < phoneStart, 'the .nav-toggle base rule must sit outside (above) the phone block')
  assert.match(base?.[1] ?? '', /display:\s*none/, 'outside the compact bands the toggle must not render: the panel it opens does not exist there')
})

test('the 420px band takes chrome off the row, never a control, so 360 fits with a scrollbar', () => {
  // At innerWidth 360 with a classic 15px scrollbar the row has 345px, minus
  // the 420 band's two 10px paddings and three 8px gaps: 301px for the mark,
  // the toggle, the language switch and the account. The wordmark is the one
  // child that can leave without taking a destination or a 44px target with it.
  const css = cssText()
  const block = mediaBlock(css, '(max-width: 420px)')
  assert.match(block, /\.brand > span:not\(\.mark\)\s*\{[^}]*display:\s*none/, 'below 420 the wordmark must leave the row, not a control')
  assert.match(block, /\.top-inner\s*\{[^}]*gap:\s*8px/, 'the row gaps must tighten below 420 for the 360px case')
  assert.match(
    block,
    /\.top-inner\s*\{[^}]*padding:\s*0 calc\(10px \+ env\(safe-area-inset-right\)\) 0 calc\(10px \+ env\(safe-area-inset-left\)\)/,
    'the row padding must tighten to 10px below 420 for the 360px case, with the notch insets added on top (#451)',
  )
  // Everything that stays keeps its 44px floor: the escape hatch here is the
  // wordmark, not a smaller tap target. The toggle's full rule lives in the
  // phone block; the base rule only hides it above 641.
  const phone = mediaBlock(css, '(max-width: 640px)')
  assert.match(rule(phone, '.nav-toggle'), /min-(height|width):\s*var\(--touch\)/, '.nav-toggle must keep its --touch floor')
  for (const selector of ['.lang a', '.account-exit']) {
    assert.match(rule(css, selector), /min-(height|width):\s*var\(--touch\)/, `${selector} must keep its --touch floor`)
  }
  // The mark alone is not a link name, so the brand carries one of its own.
  assert.match(render(), /<a class="brand" href="\/" aria-label="Fledge"/, 'the mark-only brand needs an accessible name of its own')
})
