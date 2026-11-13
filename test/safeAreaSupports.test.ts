import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { declarationsFor, parseRules, pxValue, type StyleRule } from './cssRules.js'

// #492: #489 added the safe-area insets additively and kept the old shorthand as
// a "fallback for a browser without env()". That fallback never worked above
// 960px: the declaration it falls back from contains var(), so it is invalid at
// computed-value time and the property lands on its initial value — measured as
// 0px padding on .wrap, .top-inner and .foot at 961px and 1280px in #489's
// verification. The fix gates the additive declarations behind
// `@supports (padding: env(safe-area-inset-top))`, so a browser without env()
// keeps the plain pre-#489 shorthand. These pins read both readers:
//
//   legacy — the block is dropped, exactly what a browser without env() parses;
//   modern — the block is applied, and its declarations resolve after the
//            fallback into one effective rule.
//
// `env()` and not `max()`: Chrome 69–78 and Firefox 65–74 parse env() but not
// max(), so a max() gate would strip the insets those browsers already have.

const cssText = (): string => readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const SHEET = cssText()
const legacy = parseRules(SHEET, 'legacy')
const modern = parseRules(SHEET, 'modern')

type PaddingBox = { top: string; right: string; bottom: string; left: string }

// A shorthand splits on whitespace only at depth zero; `calc()`/`env()` keep
// their spaces inside the parentheses.
function paddingParts(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const character of value) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth === 0 && /\s/.test(character)) {
      if (current !== '') parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current !== '') parts.push(current)
  return parts
}

function paddingAt(rules: StyleRule[], selector: string, width: number): PaddingBox {
  const padding: PaddingBox = { top: '0', right: '0', bottom: '0', left: '0' }
  for (const declaration of declarationsFor(rules, selector, width)) {
    if (declaration.property === 'padding') {
      const parts = paddingParts(declaration.value)
      const [top = '0', right = top, bottom = top, left = right] = parts
      Object.assign(padding, { top, right, bottom, left })
    } else if (declaration.property === 'padding-top') padding.top = declaration.value
    else if (declaration.property === 'padding-right') padding.right = declaration.value
    else if (declaration.property === 'padding-bottom') padding.bottom = declaration.value
    else if (declaration.property === 'padding-left') padding.left = declaration.value
  }
  return padding
}

// The base a `calc(<base> + env(safe-area-inset-<side>))` adds the inset to, or
// null when the value is not that additive form (a plain px, a max(), or a
// declaration that only exists in the other view). The base is a string because
// the sides add to `var(--page-pad)` at the wide widths and to a px in a band.
function additiveBase(value: string, side: 'bottom' | 'left' | 'right'): string | null {
  const env = `env\\(\\s*safe-area-inset-${side}\\s*\\)`
  const match = new RegExp(`^calc\\(\\s*(.+?)\\s*\\+\\s*${env}\\s*\\)$`).exec(value.trim())
  return match === null ? null : (match[1] ?? '').trim()
}

const FRAME = ['.wrap', '.top-inner', '.foot'] as const

test('the legacy view keeps the pre-#489 page padding instead of an invalid declaration', () => {
  // The parser must have the two views at all: a caller asks for the rules under
  // a support condition, and the legacy reader carries none of them.
  assert.ok(
    modern.some((rule) => rule.supports === '(padding: env(safe-area-inset-top))'),
    'the modern view must keep the @supports condition on the rule it applies',
  )
  assert.equal(
    legacy.filter((rule) => rule.supports !== null).length,
    0,
    'the legacy view must contain no @supports rule: a browser without env() never parses the block',
  )

  for (const width of [961, 1280]) {
    const wrap = paddingAt(legacy, '.wrap', width)
    assert.equal(pxValue(wrap.bottom), 80, `at ${String(width)}px the legacy .wrap padding-bottom is \`${wrap.bottom}\`; it must be the 80px pre-#489 rhythm, not 0 or a calc() a no-env browser discards`)
    assert.equal(wrap.right, 'var(--page-pad)', `at ${String(width)}px the legacy .wrap padding-right must stay var(--page-pad)`)
    assert.equal(wrap.left, 'var(--page-pad)', `at ${String(width)}px the legacy .wrap padding-left must stay var(--page-pad)`)

    const top = paddingAt(legacy, '.top-inner', width)
    assert.equal(top.right, 'var(--page-pad)', `at ${String(width)}px the legacy .top-inner padding-right must stay var(--page-pad)`)
    assert.equal(top.left, 'var(--page-pad)', `at ${String(width)}px the legacy .top-inner padding-left must stay var(--page-pad)`)
    assert.equal(pxValue(top.top), 0, `at ${String(width)}px the legacy .top-inner padding-top must stay 0`)

    const foot = paddingAt(legacy, '.foot', width)
    assert.equal(pxValue(foot.bottom), 52, `at ${String(width)}px the legacy .foot padding-bottom is \`${foot.bottom}\`; it must be the 52px pre-#489 rhythm`)
    assert.equal(pxValue(foot.top), 28, `at ${String(width)}px the legacy .foot padding-top must stay 28px`)
    assert.equal(foot.right, 'var(--page-pad)', `at ${String(width)}px the legacy .foot padding-right must stay var(--page-pad)`)
    assert.equal(foot.left, 'var(--page-pad)', `at ${String(width)}px the legacy .foot padding-left must stay var(--page-pad)`)
  }
})

test('the legacy view keeps the band fallbacks below 961px', () => {
  // The <=960 band already worked (its declarations carry no var()), so this is
  // the half the fix must not break while gating the wide declarations.
  for (const width of [960, 768, 390]) {
    const wrapBottom = pxValue(paddingAt(legacy, '.wrap', width).bottom)
    assert.equal(wrapBottom, 72, `at ${String(width)}px the legacy .wrap padding-bottom must be the band's 72px fallback`)
    const footBottom = pxValue(paddingAt(legacy, '.foot', width).bottom)
    assert.equal(footBottom, 44, `at ${String(width)}px the legacy .foot padding-bottom must be the band's 44px fallback`)
  }
  assert.equal(paddingAt(legacy, '.top-inner', 960).right, '16px', 'at 960px the legacy .top-inner keeps the band 16px side padding')
  assert.equal(paddingAt(legacy, '.top-inner', 768).right, '16px', 'at 768px the legacy .top-inner keeps the band 16px side padding')
  assert.equal(paddingAt(legacy, '.top-inner', 390).right, '10px', 'at 390px the legacy .top-inner keeps the 420-band 10px side padding')
})

test('the modern view still adds the real inset at the pinned widths', () => {
  // The positive control: a browser WITH env() must render exactly what
  // test/layout.test.ts:226 pins today — additive, base 80 above 960, 72 below.
  for (const width of [961, 768, 390]) {
    const expectedBase = width > 960 ? 80 : 72
    const wrap = paddingAt(modern, '.wrap', width)
    assert.equal(
      pxValue(additiveBase(wrap.bottom, 'bottom')),
      expectedBase,
      `at ${String(width)}px the modern .wrap padding-bottom is \`${wrap.bottom}\`; it must add env(safe-area-inset-bottom) to the ${String(expectedBase)}px rhythm`,
    )
    const foot = paddingAt(modern, '.foot', width)
    assert.equal(
      pxValue(additiveBase(foot.bottom, 'bottom')),
      width > 960 ? 52 : 44,
      `at ${String(width)}px the modern .foot padding-bottom is \`${foot.bottom}\`; it must add env(safe-area-inset-bottom) to the pre-#489 rhythm`,
    )
    for (const selector of FRAME) {
      const box = paddingAt(modern, selector, width)
      for (const [side, value] of [
        ['right', box.right],
        ['left', box.left],
      ] as const) {
        assert.ok(
          additiveBase(value, side) !== null,
          `at ${String(width)}px the modern ${selector} ${side} padding is \`${value}\`; a notched landscape phone must still get its horizontal inset`,
        )
      }
    }
  }
})
