import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { layout } from '../src/views/layout.js'
import { makeUser, testConfig } from './helpers.js'
import { parseRules, type StyleRule } from './cssRules.js'

const cssText = (): string => readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

// The six headings whose Latin tracking is negative at the top level of the
// stylesheet. #474 exists because that tracking is tuned for Latin: a Chinese
// heading is square, already carries its own side bearing, and goes solid at
// -0.02em to -0.045em. The list is written here rather than derived so deleting
// one of those Latin rules is a failing test too, not a silently smaller loop.
const LATIN_HEADINGS = ['h1', 'h2', '.brand', '.hero-copy h1', '.workspace-user h1', '.stat strong']

// The forms `:lang(zh)` can take in front of, or attached to, the same element.
const chineseForms = (selector: string): string[] => [
  `:lang(zh) ${selector}`,
  `html:lang(zh) ${selector}`,
  `${selector}:lang(zh)`,
  `html${selector}:lang(zh)`,
]

function value(rule: StyleRule, property: string): string | null {
  let found: string | null = null
  for (const declaration of rule.declarations) {
    if (declaration.property === property) found = declaration.value
  }
  return found
}

function numbers(rule: StyleRule, property: string): number | null {
  const raw = value(rule, property)
  if (raw === null) return null
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function latinRules(rules: StyleRule[]): StyleRule[] {
  return rules.filter((rule) => rule.media === null && rule.selectors.some((selector) => LATIN_HEADINGS.includes(selector)))
}

function chineseRule(rules: StyleRule[], selector: string): StyleRule | undefined {
  const forms = chineseForms(selector)
  return rules.find((rule) => rule.selectors.some((candidate) => forms.includes(candidate)))
}

// 1. Coverage: every heading that still carries negative tracking for Latin has
// a Chinese counterpart that lifts it to zero-or-positive.
test('every negative-tracking heading has a :lang(zh) rule that lifts its tracking', () => {
  const rules = parseRules(cssText())
  const latin = latinRules(rules)
  const covered = latin.map((rule) => rule.selectors.find((selector) => LATIN_HEADINGS.includes(selector)) ?? '')
  for (const selector of LATIN_HEADINGS) {
    assert.ok(covered.includes(selector), `public/app.css has no top-level rule for ${selector}`)
  }
  const negative = latin.filter((rule) => (numbers(rule, 'letter-spacing') ?? 0) < 0)
  assert.equal(negative.length, 6, 'the six Latin headings are the ones this card measures; a missing one is a changed sheet, not a passing loop')
  for (const rule of negative) {
    const selector = rule.selectors.find((candidate) => LATIN_HEADINGS.includes(candidate)) ?? ''
    const tracking = value(rule, 'letter-spacing') ?? ''
    const zh = chineseRule(rules, selector)
    assert.ok(
      zh !== undefined,
      `${selector} keeps Latin tracking ${tracking} but has no :lang(zh) rule; Chinese headings would stay pulled tight`,
    )
    const lifted = numbers(zh, 'letter-spacing')
    assert.ok(
      lifted !== null && lifted >= 0,
      `${selector}'s :lang(zh) rule must lift letter-spacing to zero or more, found ${value(zh, 'letter-spacing') ?? 'nothing'}`,
    )
  }
})

// 2. The locale changes the texture, never the scale: a Chinese rule may repeat
// the size, but it may not change it.
test('a :lang(zh) heading rule never changes the Latin size', () => {
  const rules = parseRules(cssText())
  for (const rule of latinRules(rules)) {
    const selector = rule.selectors.find((candidate) => LATIN_HEADINGS.includes(candidate)) ?? ''
    const zh = chineseRule(rules, selector)
    if (zh === undefined) continue
    const chineseSize = value(zh, 'font-size')
    if (chineseSize === null) continue
    assert.equal(
      chineseSize,
      value(rule, 'font-size'),
      `${selector}'s :lang(zh) rule declares font-size ${chineseSize}, but the Latin rule's size is what the locale must keep`,
    )
  }
})

// 3. Where the Latin heading sets its own line-height, the Chinese one declares
// one too and it is at least as airy — Chinese lines need the air more.
test('a :lang(zh) heading line-height is as generous as the Latin one', () => {
  const rules = parseRules(cssText())
  let measured = 0
  for (const rule of latinRules(rules)) {
    const selector = rule.selectors.find((candidate) => LATIN_HEADINGS.includes(candidate)) ?? ''
    const latinHeight = numbers(rule, 'line-height')
    if (latinHeight === null) continue
    measured += 1
    const zh = chineseRule(rules, selector)
    assert.ok(zh !== undefined, `${selector} sets line-height ${latinHeight} for Latin and has no :lang(zh) rule`)
    const chineseHeight = numbers(zh, 'line-height')
    assert.ok(
      chineseHeight !== null && chineseHeight >= latinHeight,
      `${selector}'s :lang(zh) line-height must be at least the Latin ${latinHeight}, found ${value(zh, 'line-height') ?? 'nothing'}`,
    )
  }
  assert.ok(measured >= 3, 'the heading rules that set their own line-height are the ones this card measures')
})

// 4. The stack: Chinese gets a CJK-first family so a Latin run inside a Chinese
// sentence stops falling through two Latin faces first. The Latin stack stays.
test('Chinese is set in a CJK-first stack and the Latin stack is untouched', () => {
  const rules = parseRules(cssText())
  const zhBody = rules.find((rule) => rule.selectors.includes('html:lang(zh) body'))
  assert.ok(zhBody !== undefined, 'public/app.css has no html:lang(zh) body rule')
  assert.equal(value(zhBody, 'font'), null, 'the Chinese stack must set font-family only: the base rule is the font shorthand, so re-declaring font would reset size and line-height')
  const family = value(zhBody, 'font-family') ?? ''
  const first = (family.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '')
  assert.ok(
    ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei'].includes(first),
    `the Chinese stack must lead with a CJK face, found ${first === '' ? 'nothing' : first}`,
  )

  // `html, body` resets margin/padding first, so pick the body rule that owns
  // the stack: the one declaring the `font` shorthand at `:215`.
  const base = rules.find((rule) => rule.media === null && rule.selectors.includes('body') && rule.declarations.some((declaration) => declaration.property === 'font'))
  assert.ok(base !== undefined, 'public/app.css has no body rule declaring the font shorthand')
  const shorthand = value(base, 'font') ?? ''
  assert.match(shorthand, /^16px\/[\d.]+ -apple-system,/, 'the base body stack must stay Latin-first with its size and line-height')
})

// 5. The precondition of every rule above: the document has to declare the
// language, or no :lang(zh) rule can match at all.
test('the Chinese render declares its language on the html element', () => {
  const store = new Store(':memory:')
  const user = makeUser(store)
  const html = layout({ title: 'x', viewer: { user, csrfToken: 'csrf-token' }, body: '', config: testConfig(), locale: 'zh', path: '/dashboard' })
  assert.match(html, /<html lang="zh-CN"/)
})
