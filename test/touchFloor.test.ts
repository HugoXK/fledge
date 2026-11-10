import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The phone-level control floor of #132, as a stylesheet rule set. Test's phone
// matrix measured the controls at 360 in a 844px viewport; this file executes the
// cascade for the same width so a regression fails here instead of on a phone.
// It does not prove the pixel result — the PR carries the harness measurement for
// that — but it does pin which rules exist, which value they resolve to and, just
// as important, that the inline-prose exception is structural rather than
// accidental.

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const pagesSource = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')

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

function touchFloor(selector: string, width = 360): void {
  assert.equal(lastValue(selector, 'min-height', width), 'var(--touch)', `${selector} carries the height floor`)
  assert.equal(lastValue(selector, 'min-width', width), 'var(--touch)', `${selector} carries the width floor`)
}

test('the touch floor is one token, and it is the 44px the issue measured against', () => {
  assert.equal(lastValue(':root', '--touch', 360), '44px')
})

test('standalone link controls in a table cell reach 44x44 without padding a sentence', () => {
  // `打开`, `支持视图`, `改额度` are one action per cell, so the cell is the
  // container that may be padded. `p`, `li` and `small` links are prose and are
  // exempt (WCAG 2.5.5 inline exception, acceptance 1), which is why this rule
  // names `td` and not `.link` itself.
  touchFloor('td .link')
  assert.equal(lastValue('td .link', 'display', 360), 'inline-flex', 'a floor on an inline box measures nothing')
  assert.equal(lastValue('p .link', 'min-height', 360), null, 'an inline prose link must keep its line box')
  assert.equal(lastValue('small .link', 'min-height', 360), null, 'an inline prose link must keep its line box')
})

test('the approve, reject and mark-all-read buttons are no longer zero-padded words', () => {
  touchFloor('button.link')
  assert.equal(lastValue('button.link', 'display', 360), 'inline-flex')
  assert.notEqual(lastValue('button.link', 'padding', 360), '0')
})

test('the footer links, the ghost buttons and the checkbox rows reach the floor', () => {
  // The footer sets 11.5px, so a height-only floor leaves `文档` 23px wide and
  // `Docs`/`Portal`/`GitHub` between 24 and 37px: acceptance 1 asks for 44x44,
  // so both dimensions are pinned here by the shared helper.
  touchFloor('.foot a')
  assert.equal(lastValue('.foot a', 'display', 360), 'inline-flex', 'a floor on an inline box measures nothing')
  assert.equal(lastValue('.btn', 'min-width', 360), 'var(--touch)', 'a ghost button measured 39px wide in a cell')
  // The 13px checkbox glyph reaches 44px through the label around it, which is
  // the shape `pages.ts` already emits; no new element is added.
  assert.equal(lastValue('label.check', 'min-height', 360), 'var(--touch)')
})

test('a field focused on a phone no longer zooms the page', () => {
  for (const selector of ['input, textarea, select', 'input', 'select', 'textarea']) {
    // The base rule groups them; the phone block must set the same value for the
    // grouped selector so no field is left at the 14px base.
    const value = lastValue(selector, 'font-size', 360)
    if (value === null) continue
    assert.equal(value, '16px', `${selector} resolves to 16px at 360`)
  }
  assert.equal(lastValue('input', 'font-size', 768), '14px', 'the desktop size is unchanged')
})

test('the admin quota and role controls become full-width rows on a phone', () => {
  // No DOM change: the existing wrapper becomes a block-level row below 641px,
  // so `width: 100%` on the field resolves against the cell, not its text.
  assert.equal(lastValue('.admin-inline-form', 'flex-direction', 360), 'column')
  assert.equal(lastValue('.admin-inline-form', 'align-items', 360), 'stretch')
  assert.equal(lastValue('.admin-inline-form', 'flex-direction', 768), null, 'the desktop row is untouched')
  // Stretching the wrapper is not enough. The fields themselves carry a definite
  // 88px / 112px width and a fixed flex basis, and in a column container
  // `flex: 0 0 88px` sizes the height, not the width: the row would stretch and
  // the controls inside it would stay 88x88 and 112x112. The field is asserted at
  // both widths, not the wrapper.
  for (const [selector, desktopWidth] of [['.admin-quota', '88px'], ['.admin-role', '112px']] as const) {
    assert.equal(lastValue(selector, 'width', 360), '100%', `${selector} fills the phone row instead of its measured width`)
    assert.notEqual(lastValue(selector, 'flex', 360), `0 0 ${desktopWidth}`, `${selector} does not keep its fixed basis on a phone`)
    assert.equal(lastValue(selector, 'width', 768), desktopWidth, `${selector} keeps its desktop width`)
    assert.equal(lastValue(selector, 'flex', 768), `0 0 ${desktopWidth}`, `${selector} keeps its desktop basis`)
    // Acceptance 1 has no exemption for these two fields: with 16px text,
    // `6px 8px` padding and a 1px border the height is content-driven at about
    // 33-38px, so the field carries the same 44px floor as every other control.
    assert.equal(lastValue(selector, 'min-height', 360), 'var(--touch)', `${selector} reaches the 44px height on a phone`)
    assert.equal(lastValue(selector, 'min-height', 768), null, `${selector} keeps its desktop height`)
  }
})

test('a link alone in its own paragraph is a target, so the template marks it', () => {
  // Acceptance 1's inline exception covers a link inside a sentence, not a link
  // that is the whole paragraph. `p.fine` also carries prose with links in it,
  // so the floor cannot be a `p.fine a` rule; the template marks the two
  // standalone console rows ("view the other N ...") with one class and the
  // stylesheet floors that class.
  assert.equal(lastValue('.fine-link', 'min-height', 360), 'var(--touch)', 'the marked lone link carries the height floor')
  assert.equal(lastValue('.fine-link', 'min-width', 360), 'var(--touch)', 'the marked lone link carries the width floor')
  assert.equal(lastValue('.fine-link', 'display', 360), 'inline-flex', 'a floor on an inline box measures nothing')

  const consoleRows = pagesSource.split('\n').filter((line) => /查看其余|View the other/.test(line))
  assert.equal(consoleRows.length, 2, 'the issue names two console rows ("view the other N") and this pattern still finds exactly those')
  for (const line of consoleRows) {
    assert.match(line, /<a class="[^"]*\bfine-link\b[^"]*" href=/, 'a link alone in its paragraph carries the class')
  }
  // Not every lone target is floored, and the body says so: the job page renders
  // the `jobLinks` helper into its own paragraph, while the same helper is
  // emitted inline inside a table cell, so closing it needs a class per call
  // site. It is the residue under "Still below the floor"; this assertion fails
  // if that paragraph changes shape and the note goes stale.
  assert.match(pagesSource, /<p class="fine">\$\{jobLinks\(job\)\}<\/p>/, 'the job page keeps one named, unfloored lone paragraph')
  assert.equal(lastValue('p .link', 'min-height', 360), null, 'a sentence link keeps its line box')
})
