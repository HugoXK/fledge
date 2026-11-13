import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { lastValue as lastValueIn, parseRules } from './cssRules.js'

// On a phone, /console and /repos/:id scroll sideways while the page shows
// nothing at the right edge. Two independent selectors widen the document:
//
// A. `.list` is a grid with no track minimum and `.list-row` — the grid item —
//    has no `min-width: 0`, so its automatic minimum is its content's
//    min-content width and the row lays out wider than its card.
// B. `.info-tip::after` is an absolutely positioned 270px box anchored at the
//    icon's left edge. It stays in the document's scrollable overflow while
//    `opacity: 0`, so the page is wider than the viewport with nothing visible.
//
// Both pins read the stylesheet only, so they are deterministic. They do not
// prove the pixel result: the PR carries the browser matrix (11 routes x 10
// widths x 2 locales) as its evidence for that half.

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

// Every width the issue measured as broken, including the 641-960 band that is
// broken on its own and 960 where the band ends.
const NARROW_WIDTHS = [360, 390, 421, 430, 480, 640, 641, 768, 800, 960]
const DESKTOP_WIDTH = 1280

// Both frames read the stylesheet through the modern view: these pins describe
// the browser that parses `@supports (padding: env(…))`, and they keep the
// values they pinned before #492 moved the additive declarations into it.
const rules = parseRules(cssSource, 'modern')

function lastValue(selector: string, property: string, width: number): string | null {
  return lastValueIn(rules, selector, property, width)
}

// `minmax(0, 1fr)` and `minmax(0,1fr)` are the same declaration; compare shape,
// not spacing.
function compact(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, '').toLowerCase()
}

test('a list row cannot take its content min-content width as a floor below 960px', () => {
  for (const width of NARROW_WIDTHS) {
    const track = compact(lastValue('.list', 'grid-template-columns', width))
    const rowFloor = compact(lastValue('.list-row', 'min-width', width))
    const capped = track === 'minmax(0,1fr)' || rowFloor === '0'
    assert.ok(
      capped,
      `at ${String(width)}px the console list still has no zero floor: .list grid-template-columns is ${String(track)} and .list-row min-width is ${String(rowFloor)}; a grid item's automatic minimum is its min-content width, so the row widens the document past the viewport`,
    )
  }
})

test('the info tooltip cannot put a fixed-width box past the right edge below 960px', () => {
  for (const width of NARROW_WIDTHS) {
    const left = compact(lastValue('.info-tip::after', 'left', width))
    const right = compact(lastValue('.info-tip::after', 'right', width))
    const boxWidth = compact(lastValue('.info-tip::after', 'width', width))
    const position = compact(lastValue('.info-tip::after', 'position', width))
    // The defect is exactly this pair: a 270px box anchored at the icon's left
    // edge. It must be gone below the desktop layout.
    assert.equal(
      left === '0' && boxWidth === '270px',
      false,
      `at ${String(width)}px .info-tip::after still anchors a ${String(boxWidth)} box at the icon's left edge; it stays in the document's scrollable overflow while invisible`,
    )
    // The mechanism that lands is the viewport-anchored bar: a fixed box cannot
    // contribute to the document's scrollable overflow, and both insets keep the
    // whole hint on screen whatever the icon's distance from the edge.
    const viewportAnchored = position === 'fixed' && left !== null && left !== 'auto' && right !== null && right !== 'auto'
    assert.ok(
      viewportAnchored,
      `at ${String(width)}px the tooltip needs to leave the icon's containing block, got position ${String(position)}, left ${String(left)}, right ${String(right)}`,
    )
    assert.equal(compact(lastValue('.info-tip::after', 'width', width)), 'auto')
    assert.equal(compact(lastValue('.info-tip::after', 'top', width)), 'auto')
    assert.ok(compact(lastValue('.info-tip::after', 'bottom', width)) !== null)
  }
})

test('the tooltip explanation stays reachable at every width', () => {
  for (const width of [360, 768, DESKTOP_WIDTH]) {
    // Hover and focus reveal the hint only as the no-JavaScript fallback now; the
    // script hands the reveal to `aria-expanded` (test/layout.test.ts pins that
    // split). Deleting the fallback to pass the width check is still not a fix:
    // with no script the hint would be unreachable.
    assert.equal(
      lastValue('html:not([data-js]) .info-tip:hover::after', 'opacity', width),
      '1',
      `at ${String(width)}px hovering must still reveal the tooltip; deleting it to pass the width check is not a fix`,
    )
    assert.equal(lastValue('html:not([data-js]) .info-tip:focus::after', 'opacity', width), '1')
    assert.equal(lastValue('.info-tip[aria-expanded="true"]::after', 'opacity', width), '1', 'the explicit state must reveal the hint whatever the width')
    // `opacity: 1` on a box that is still `display: none` renders nothing: the
    // rest state hides the tooltip to keep it out of the scrollable overflow, so
    // every reveal rule has to restore the box, not only its opacity. #443 split
    // the reveal into a no-JavaScript fallback and the explicit `aria-expanded`
    // state; each arm must restore `display`, or a hint the test calls revealed
    // is a hint nobody can read.
    assert.equal(
      lastValue('html:not([data-js]) .info-tip:hover::after', 'display', width),
      'block',
      `at ${String(width)}px the no-script hover reveal sets opacity but not display, so the tooltip stays invisible`,
    )
    assert.equal(
      lastValue('html:not([data-js]) .info-tip:focus::after', 'display', width),
      'block',
      `at ${String(width)}px the no-script keyboard-focus reveal sets opacity but not display, so the hint is never readable without a mouse`,
    )
    assert.equal(
      lastValue('.info-tip[aria-expanded="true"]::after', 'display', width),
      'block',
      `at ${String(width)}px the explicit aria-expanded reveal sets opacity but not display, so a hint opened by tap or keyboard renders nothing`,
    )
  }
})

test('desktop keeps the rendering it has today', () => {
  // Above 960px nothing about these two selectors may change: 961 is the first
  // width outside the block, 1280 is the widest row the matrix checks.
  for (const width of [961, DESKTOP_WIDTH]) {
    assert.equal(lastValue('.list', 'grid-template-columns', width), null)
    assert.equal(lastValue('.list-row', 'min-width', width), null)
    assert.equal(compact(lastValue('.info-tip::after', 'left', width)), '0')
    assert.equal(compact(lastValue('.info-tip::after', 'width', width)), '270px')
    assert.equal(lastValue('.info-tip::after', 'right', width), null)
    assert.equal(compact(lastValue('.info-tip::after', 'position', width)), 'absolute')
  }
})

test('the 640px band keeps its card layout, and the header collapses below 961', () => {
  // The new block is scoped to <=960 and must not disturb #116's card layout at
  // 640: a fix that leaks into a merged band is a conflict with a shipped PR.
  assert.equal(lastValue('.job-table td', 'display', 640), 'block')
  assert.equal(lastValue('.job-table tbody', 'display', 640), 'block')
  assert.equal(lastValue('.job-table', 'grid-template-columns', 640), null)
  assert.equal(lastValue('.job-table .job-cell', 'min-width', 640), '0')
  // --header-h at 640 is #133's collapsed phone header, not #122's wrapped one:
  // the phone band now ends at 641, so the 215px fallback it used to carry there
  // would describe a header that no longer wraps.
  assert.equal(compact(lastValue(':root', '--header-h', 640)), '90px')
  // 641 is one pixel outside #116's block: the table is a table again, and the
  // header is #233's compact tablet header — the same fixed row the phone band
  // carries, because 641-960 used to keep #122's wrapped header (215px at 768).
  assert.equal(lastValue('.job-table td', 'display', 641), null)
  assert.equal(compact(lastValue(':root', '--header-h', 641)), '90px')
  // 960 is the last width inside #233's band; 961 hands the header back to the
  // wide rendering.
  assert.equal(compact(lastValue(':root', '--header-h', 960)), '90px')
  assert.equal(lastValue('.job-table td', 'display', 961), null)
  assert.equal(compact(lastValue(':root', '--header-h', 961)), '90px')
})
