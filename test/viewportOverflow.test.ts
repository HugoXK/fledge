import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

type Declaration = { property: string; value: string }
type StyleRule = { selectors: string[]; declarations: Declaration[]; media: string | null }

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function declarationsOf(body: string): Declaration[] {
  const declarations: Declaration[] = []
  for (const part of body.split(';')) {
    const separator = part.indexOf(':')
    if (separator === -1) continue
    const property = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (property === '') continue
    declarations.push({ property, value })
  }
  return declarations
}

function parseRules(source: string, media: string | null = null): StyleRule[] {
  const css = stripComments(source)
  const rules: StyleRule[] = []
  let index = 0
  let prelude = ''
  while (index < css.length) {
    const character = css[index] ?? ''
    if (character === '{') {
      let depth = 1
      let end = index + 1
      while (end < css.length && depth > 0) {
        if (css[end] === '{') depth += 1
        else if (css[end] === '}') depth -= 1
        end += 1
      }
      const body = css.slice(index + 1, end - 1)
      const head = prelude.trim()
      if (head.startsWith('@')) {
        const atRule = head.slice(1).trim()
        if (atRule.startsWith('media')) rules.push(...parseRules(body, atRule.slice('media'.length).trim()))
      } else {
        const selectors = head.split(',').map((selector) => selector.trim()).filter((selector) => selector !== '')
        rules.push({ selectors, declarations: declarationsOf(body), media })
      }
      prelude = ''
      index = end
      continue
    }
    if (character === ';') {
      prelude = ''
      index += 1
      continue
    }
    prelude += character
    index += 1
  }
  return rules
}

const rules = parseRules(cssSource)

function conditionHolds(condition: string, width: number): boolean {
  const parts = condition.split(/\s+and\s+/).map((part) => part.trim()).filter((part) => part !== '')
  for (const part of parts) {
    const max = /^\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(part)
    if (max !== null) {
      if (!(width <= Number(max[1]))) return false
      continue
    }
    const min = /^\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(part)
    if (min !== null) {
      if (!(width >= Number(min[1]))) return false
      continue
    }
    const other = /^\(\s*(min|max)-width\s*:/.test(part)
    if (other) return false
  }
  return true
}

function appliesAt(rule: StyleRule, width: number): boolean {
  return rule.media === null || conditionHolds(rule.media, width)
}

function lastValue(selector: string, property: string, width: number): string | null {
  let value: string | null = null
  for (const rule of rules) {
    if (!appliesAt(rule, width)) continue
    if (!rule.selectors.includes(selector)) continue
    for (const declaration of rule.declarations) {
      if (declaration.property === property) value = declaration.value
    }
  }
  return value
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
    assert.equal(
      lastValue('.info-tip:hover::after', 'opacity', width),
      '1',
      `at ${String(width)}px hovering must still reveal the tooltip; deleting it to pass the width check is not a fix`,
    )
    assert.equal(lastValue('.info-tip:focus::after', 'opacity', width), '1')
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

test('the 640px band keeps its card layout and its header height', () => {
  // The new block is scoped to <=960 and must not disturb #116's card layout at
  // 640 nor the measured header height from #117/#122: a fix that leaks into a
  // merged band is a conflict with two shipped PRs.
  assert.equal(lastValue('.job-table td', 'display', 640), 'block')
  assert.equal(lastValue('.job-table tbody', 'display', 640), 'block')
  assert.equal(lastValue('.job-table', 'grid-template-columns', 640), null)
  assert.equal(lastValue('.job-table .job-cell', 'min-width', 640), '0')
  assert.equal(compact(lastValue(':root', '--header-h', 640)), '215px')
  // 641 is one pixel outside #116's block: the table is a table again.
  assert.equal(lastValue('.job-table td', 'display', 641), null)
  assert.equal(compact(lastValue(':root', '--header-h', 641)), '215px')
  // 961 is outside both bands.
  assert.equal(lastValue('.job-table td', 'display', 961), null)
  assert.equal(compact(lastValue(':root', '--header-h', 961)), '90px')
})
