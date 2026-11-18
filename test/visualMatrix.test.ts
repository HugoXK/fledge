import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as visualMatrix from '../src/lib/visualMatrix.js'
import { VISUAL_PATHS, VISUAL_WIDTHS, overflowFailure, pageSlug, viewportHeight } from '../src/lib/visualMatrix.js'

test('the matrix covers phones, tablets and desktop widths', () => {
  assert.deepEqual([...VISUAL_WIDTHS], [360, 390, 430, 640, 768, 1024, 1280, 1440, 1920])
  assert.ok(VISUAL_WIDTHS.includes(768))
  assert.ok(VISUAL_WIDTHS.includes(1920))
})

test('the matrix covers the owner, operator and account surfaces', () => {
  for (const path of ['/', '/dashboard', '/settings', '/admin', '/repos/new', '/console']) {
    assert.ok((VISUAL_PATHS as readonly string[]).includes(path), `the matrix is missing ${path}`)
  }
})

test('the viewport height follows the width band', () => {
  assert.equal(viewportHeight(360), 844)
  assert.equal(viewportHeight(768), 1024)
  assert.equal(viewportHeight(1280), 900)
})

// #950: the sweep starts at 360, so a 320-only overflow reached `main` as a
// clean run — the width was never rendered. The fix is a case, not a wider
// cross-product: 320 in `VISUAL_WIDTHS` would put every page nobody measured
// into the failure list. Read through the module object so this file still
// loads on a tree that has no such export.
test('the matrix renders the console at 320, below the sweep that starts at 360', () => {
  const cases = (visualMatrix as unknown as { VISUAL_NARROW_CASES?: readonly { path: string; width: number }[] }).VISUAL_NARROW_CASES
  assert.ok(cases !== undefined, 'the matrix needs a narrow-case list; without one the 320 row cannot exist')
  assert.ok(
    cases.some((entry) => entry.path === '/console' && entry.width === 320),
    'the console has to be measured at 320, the reflow baseline WCAG 1.4.10 names',
  )
  assert.equal(viewportHeight(320), 844, 'a narrow case keeps the phone viewport height')
  assert.ok(!(VISUAL_WIDTHS as readonly number[]).includes(320), '320 stays outside the cross-product so no unmeasured page is swept into it')
})

test('the runner turns a narrow case into a failure, not a screenshot', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(script, /for \(const narrow of VISUAL_NARROW_CASES\)/, 'the runner must visit each narrow case')
  assert.match(
    script,
    /failures\.push\(`\$\{locale\} \$\{narrow\.width\}px \$\{narrow\.path\}: /,
    'a narrow case has to report locale, width and path like every other row',
  )
})

// The narrow band is the spacing half of the same fix. It is CSS text, so the
// contract kept here is the one that matters: a band below the first swept
// width exists and it tightens the four boxes that made the row too wide.
test('the phone header a 320 case renders is the tight band, below every swept width', () => {
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
  const start = css.indexOf('@media (max-width: 359px)')
  assert.ok(start !== -1, 'the header needs a band below 360 where the row has to fit without its spacing')
  const body = css.slice(start, css.indexOf('\n}', start))
  for (const selector of ['.top-inner', '.lang', '.account', '.account-exit']) {
    assert.match(body, new RegExp(`${selector.replace('.', '\\.')}\\s*\\{`), `the 359 band must tighten ${selector}`)
  }
  assert.match(body, /\.top-inner\s*\{[^}]*padding:\s*0 6px/, 'the row keeps its side padding but halves it')
  assert.match(body, /\.account-exit\s*\{[^}]*padding:\s*0;/, 'the sign-out button loses the side padding its min-width already covers')
})

test('the slug names a stable screenshot file', () => {
  assert.equal(pageSlug('/'), 'landing')
  assert.equal(pageSlug('/admin/metrics'), 'admin-metrics')
  assert.equal(pageSlug('/repos/new'), 'repos-new')
})

test('overflow is named by its width or its element', () => {
  assert.equal(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [] }), null)
  assert.match(overflowFailure({ scrollWidth: 392, clientWidth: 390, bad: [] }) ?? '', /scrollWidth/)
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [{ name: 'div.card' }] }) ?? '', /div\.card/)
})

// #453 review: two defects the matrix could not have caught. It signed in before
// visiting `/`, which answers 302 to /dashboard once a session exists, so the
// "landing" screenshot was a second copy of the dashboard; and its `#tokens`
// guard skipped the assertion when the anchor was missing, so it passed on a
// page that had no anchor and no link target. Both are structural, so they are
// pinned here rather than only in the browser job.
test('the matrix captures the landing page signed out, before the development login', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  const landing = script.indexOf('/lang/${locale}?next=/`')
  const login = script.indexOf('/auth/dev')
  assert.ok(landing !== -1, 'the matrix must visit the landing page')
  assert.ok(login !== -1, 'the matrix must still sign in for the owner surfaces')
  assert.ok(landing < login, 'the landing page redirects to /dashboard once signed in, so it has to be captured first')
  assert.match(script, /for \(const path of SIGNED_IN_PATHS\)/, 'the signed-in pass must not revisit the landing page as the dashboard')
  assert.match(script, /const SIGNED_IN_PATHS = VISUAL_PATHS\.filter/, 'the signed-in set has to stay derived from VISUAL_PATHS')
})

test('a missing #tokens anchor fails the matrix instead of skipping the assertion', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.match(
    script,
    /positions\.target === null\) \{\s*failures\.push\(`[^`]*no #tokens anchor/,
    'a settings page without the anchor must be a failure, not a skipped measurement',
  )
})

// #521: `data-allow-overflow` used to be honoured on the attribute alone, so any
// element could leave the matrix by carrying it. The waiver now needs an ancestor
// that is a horizontal scroller with `scrollWidth > clientWidth`, and an element
// that is itself that scroller gets no waiver. The `.table-scroll` exemption had
// no case of its own either, so it is pinned here next to the new rule.
test("a chip's overflow waiver needs a horizontal scroller ancestor", () => {
  const chip = { name: 'a.user-nav-link', waiver: true, scrollerAncestor: true, isScroller: false }
  assert.equal(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [chip] }), null)

  const noScroller = { name: 'a.user-nav-link', waiver: true, scrollerAncestor: false, isScroller: false }
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [noScroller] }) ?? '', /a\.user-nav-link/)

  const scrollerItself = { name: 'div.section-nav', waiver: true, scrollerAncestor: true, isScroller: true }
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [scrollerItself] }) ?? '', /div\.section-nav/)

  const unwaived = { name: 'div.wide-card', scrollerAncestor: true, isScroller: false }
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [unwaived] }) ?? '', /div\.wide-card/)
})

test('an element clipped by a .table-scroll ancestor is not an overflow failure', () => {
  const cell = { name: 'td', clipped: true }
  assert.equal(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [cell] }), null)
  assert.match(overflowFailure({ scrollWidth: 390, clientWidth: 390, bad: [{ name: 'td' }] }) ?? '', /td/)
  assert.match(overflowFailure({ scrollWidth: 392, clientWidth: 390, bad: [cell] }) ?? '', /scrollWidth/)
})

// The rule above is only reachable when the browser pass reports the ancestry, so
// the script side is pinned too: no attribute-only shortcut, and both flags read.
test('the matrix walk reports ancestry instead of trusting the attribute', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(script, /getAttribute\('data-allow-overflow'\) !== null\) continue/)
  assert.match(script, /waiver: element\.hasAttribute\('data-allow-overflow'\)/)
  assert.match(script, /let scrollerAncestor = false/)
})

// #557: `clipped: scroll !== null && scroll !== element` waived every descendant of
// any `.table-scroll` div, so an inert box that merely carried the class name hid
// real overflow inside it. The ancestor now has to prove it scrolls.
test('a .table-scroll ancestor waives only when it can actually scroll', () => {
  const script = readFileSync(new URL('../scripts/visual-matrix.ts', import.meta.url), 'utf8')
  const start = script.indexOf('for (const element of document.querySelectorAll')
  const end = script.indexOf('return { scrollWidth', start)
  assert.ok(start > 0 && end > start, 'the walk must still measure the page')
  const walk = script.slice(start, end)
  assert.doesNotMatch(
    walk,
    /clipped:\s*scroll !== null && scroll !== element/,
    'the class name alone must not waive: the ancestor has to prove it scrolls',
  )
  assert.match(
    walk,
    /scroll\.scrollWidth\s*>\s*scroll\.clientWidth/,
    'the clipping ancestor must overflow its own box before it can hide anything',
  )
  assert.match(
    walk,
    /overflowX === 'auto'|overflowX === 'scroll'/,
    'and it must be a real scroller, not an inert box carrying the class',
  )
})
