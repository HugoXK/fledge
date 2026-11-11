import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { landingPage } from '../src/views/pages.js'
import { testConfig } from './helpers.js'

// #229: the views carried 25 inline `style="` attributes (24 lines, one line with
// two `flex:1`), 13 of them `flex:1`, and the stylesheet carried 41 raw
// `border-radius` values between 6 and 999px. Both are decisions nobody made:
// four authors, two pixels apart. The pins below are the ones this repo can hold
// without a browser — the source count the issue names, the token set, and the
// shells the templates are allowed to use. The rendered half (no horizontal
// overflow at 360/390/430) stays in test/viewportOverflow.test.ts, which reads
// the same stylesheet at those widths.

const pagesSource = (): string => readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
const cssText = (): string => readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

type Rule = { selector: string; body: string; media: string | null }

function rules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Rule[] = []
  const stack: { prelude: string }[] = []
  let pending = ''
  for (const token of src.split(/([{}])/)) {
    if (token === '{') {
      stack.push({ prelude: pending.trim() })
      pending = ''
    } else if (token === '}') {
      const closed = stack.pop()
      if (closed !== undefined && !closed.prelude.startsWith('@')) {
        const ancestors = [...stack].reverse()
        const media = ancestors.find((entry) => entry.prelude.startsWith('@media'))?.prelude ?? null
        out.push({ selector: closed.prelude, body: pending, media })
      }
      pending = ''
    } else {
      pending += token
    }
  }
  return out
}

function declarations(body: string): { property: string; value: string }[] {
  const out: { property: string; value: string }[] = []
  for (const part of body.split(';')) {
    const separator = part.indexOf(':')
    if (separator === -1) continue
    const property = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (property !== '' && value !== '') out.push({ property, value })
  }
  return out
}

function rule(selector: string, media: string | null = null): string {
  const match = rules(cssText()).find((entry) => entry.selector.split(',').map((part) => part.trim()).includes(selector) && entry.media === media)
  assert.ok(match !== undefined, `public/app.css has no top-level rule for ${selector}`)
  return match.body
}

test('the views carry no inline layout style, only the quota meter width', () => {
  const source = pagesSource()
  const found = source.match(/style="/g) ?? []
  assert.equal(found.length, 1, `src/views/pages.ts carries ${found.length} inline style attributes; #229 leaves exactly one, the quota meter's data-driven width`)
  const quotaWidth = /<span style="width:\$\{quota\.unlimited/.exec(source)
  assert.ok(quotaWidth !== null, 'the one remaining inline style must be the quota meter width, which is data, not layout')
  assert.match(source, /<div class="meter"><span style="width:/, 'and it must be the meter fill, not a box the layout engine measures')

  for (const file of ['layout', 'states']) {
    const text = readFileSync(new URL(`../src/views/${file}.ts`, import.meta.url), 'utf8')
    assert.equal((text.match(/style="/g) ?? []).length, 0, `src/views/${file}.ts must not carry an inline style`)
  }

  // The rendered check that costs nothing: the landing page is the one route
  // that builds the token form, which used to carry `margin:24px 0 0` inline.
  const html = landingPage(testConfig(), null, true, 'en')
  assert.doesNotMatch(html, /style="/, 'no rendered route may carry an inline layout style after #229')
  assert.match(html, /<details class="card narrow mt-24"/, 'the token form keeps its offset through the named utility, not an attribute')
})

test('the offsets and widths the templates need exist as named utilities', () => {
  const css = cssText()
  const expected: [string, RegExp][] = [
    ['.grow', /flex:\s*1 1 0;[\s\S]*min-width:\s*0/],
    ['.mt-12', /margin-top:\s*12px/],
    ['.mt-14', /margin-top:\s*14px/],
    ['.mt-16', /margin-top:\s*16px/],
    ['.mt-24', /margin-top:\s*24px/],
    ['.mb-6', /margin-bottom:\s*6px/],
    ['.mb-12', /margin-bottom:\s*12px/],
    ['.more-note', /margin:\s*12px 0 0/],
    ['.text-right', /text-align:\s*right/],
    ['.w-90', /width:\s*90px/],
  ]
  for (const [selector, shape] of expected) {
    assert.match(rule(selector), shape, `${selector} must exist in public/app.css with the value the templates expect`)
    assert.ok(css.includes(selector), `${selector} must be declared`)
  }
  // .grow is a flex child that may grow, so it must also refuse to push its row
  // past the viewport: that is the narrow-width half of moving flex:1 into a class.
  assert.match(rule('.grow'), /min-width:\s*0/, '.grow needs min-width: 0, or a long field can widen the document at 360px')
})

test('one radius scale, and every corner in the stylesheet takes a step of it', () => {
  const root = rule(':root')
  const scale = new Map<string, string>()
  for (const { property, value } of declarations(root)) {
    if (property === '--radius' || property.startsWith('--radius-')) scale.set(property, value)
  }
  assert.deepEqual(
    [...scale.entries()].sort(),
    [
      ['--radius', '16px'],
      ['--radius-lg', '18px'],
      ['--radius-md', '12px'],
      ['--radius-pill', '999px'],
      ['--radius-sm', '8px'],
      ['--radius-xs', '6px'],
    ],
    'the radius scale is one list in :root',
  )
  for (const { selector, body } of rules(cssText())) {
    for (const { property, value } of declarations(body)) {
      if (property !== 'border-radius') continue
      const rest = value
        .replace(/var\(--radius(?:-(?:xs|sm|md|lg|pill))?\)/g, '')
        .replace(/50%/g, '')
        .replace(/0/g, '')
        .replace(/\s+/g, '')
      assert.equal(rest, '', `${selector} uses a border-radius of ${value}, which is not a step of the radius scale; #229 leaves no raw corner value`)
    }
  }
})

test('one interactive accent: brand and mint never colour a control', () => {
  const interactive = ['.btn', '.btn:hover', '.btn-ghost', '.link', 'a', '.nav a.on', 'input:focus', '.chip:hover', '.pill']
  const decorative = ['.mark', '.grid3 .card:nth-child(2)', '.grid3 .card:nth-child(3)', '.stat:nth-child(2)', '.stat:nth-child(3)', '.meter span']
  const all = rules(cssText())
  for (const selector of interactive) {
    const match = all.find((entry) => entry.selector.split(',').map((part) => part.trim()).includes(selector))
    if (match === undefined) continue
    assert.doesNotMatch(
      match.body,
      /var\(--(mint|brand|brand-2)\)/,
      `${selector} is a control and may not use the decorative brand or mint colours; the interactive accent is --accent`,
    )
  }
  for (const { selector, body } of all) {
    if (!/var\(--(mint|brand|brand-2)\)/.test(body)) continue
    assert.ok(
      decorative.some((allowed) => selector.split(',').map((part) => part.trim()).includes(allowed)) || selector === ':root',
      `${selector} uses a decorative accent; #229 keeps brand and mint to the wordmark, the feature and stat accents and the meter, never a control`,
    )
  }
  assert.match(rule('.btn'), /background:\s*var\(--accent-strong\)/, 'the primary button takes the interactive accent')
})

test('cards, lists and tables keep one shell each', () => {
  const source = pagesSource()
  const cardClasses = new Set([...source.matchAll(/class="card( [a-z-]+)?"/g)].map((match) => (match[1] ?? '').trim()).filter((value) => value !== ''))
  assert.deepEqual(
    [...cardClasses].sort(),
    ['chief-card', 'feature', 'inbox', 'narrow', 'notices', 'provider-card'],
    'a card is .card plus a documented modifier; a new shell is a decision this issue did not open',
  )

  const listClasses = new Set([...source.matchAll(/class="(list[a-z-]*)"/g)].map((match) => match[1] ?? ''))
  const known = new Set(['list', 'list-row', 'list-main', 'list-title', 'list-title-link', 'list-meta'])
  for (const value of listClasses) assert.ok(known.has(value), `${value} is a new list shell; #229 keeps the one .list/.list-row pair`)

  const tables = source.match(/<table/g) ?? []
  const wrapped = source.match(/class="table-scroll[^"]*"><table/g) ?? []
  assert.equal(tables.length, wrapped.length, `every one of the ${tables.length} tables must sit in a .table-scroll wrapper`)
})
