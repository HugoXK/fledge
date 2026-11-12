import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseRules } from './cssRules.js'

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const doc = readFileSync(new URL('../docs/ui.md', import.meta.url), 'utf8')
const rules = parseRules(cssSource)

// Colour tokens are the ones a palette has to redefine: every name whose dark
// value is a solid hex colour, plus the shadow (rgba by design). Space, type,
// radius, motion and layout tokens are shared by both palettes.
const colourTokens = [
  '--bg', '--bg-soft', '--panel', '--panel-2', '--surface-sunken', '--surface-inset',
  '--surface-raised', '--field', '--track', '--row-line', '--raised-top', '--raised-bottom',
  '--line', '--line-strong', '--scroll-track', '--scroll-thumb', '--text', '--muted',
  '--muted-2', '--brand', '--brand-2', '--accent', '--accent-strong', '--accent-hover',
  '--accent-ink', '--good', '--warn', '--danger', '--mint', '--blue', '--violet',
  '--mark-ink', '--badge-bg', '--badge-ink', '--lede-ink', '--tip-ink', '--paper',
]
const lightOnlyTokens = new Set(['--shadow'])

function mapOf(selector: string, media: string | null): Map<string, string> {
  const tokens = new Map<string, string>()
  for (const rule of rules) {
    if (rule.media !== media) continue
    if (!rule.selectors.includes(selector)) continue
    for (const declaration of rule.declarations) {
      if (declaration.property.startsWith('--')) tokens.set(declaration.property, declaration.value)
    }
  }
  return tokens
}

const dark = mapOf(':root', null)
const LIGHT_MEDIA = '(prefers-color-scheme: light)'
const mediaLight = mapOf(':root:not([data-theme="dark"])', LIGHT_MEDIA)
const attributeLight = mapOf(':root[data-theme="light"]', null)

function channels(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (hex === null) return null
  const raw = hex[1] ?? ''
  const digits = raw.length === 3 ? raw.split('').map((ch) => ch + ch).join('') : raw
  const slice = (index: number): number => parseInt(digits.slice(index, index + 2), 16)
  return [slice(0), slice(2), slice(4)]
}

function luminance(rgb: [number, number, number]): number {
  const linear = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

function contrast(foreground: string, background: string): number {
  const a = channels(foreground)
  const b = channels(background)
  assert.ok(a !== null, `expected a hex colour, got ${foreground}`)
  assert.ok(b !== null, `expected a hex colour, got ${background}`)
  const ranked = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return ((ranked[0] ?? 0) + 0.05) / ((ranked[1] ?? 0) + 0.05)
}

// 1. The page tells the browser it can paint either scheme, and the explicit
//    theme override pins the scheme the reader asked for, so form controls,
//    scrollbars and selection cannot disagree with the palette around them.
test('the root declares both schemes and each explicit theme pins one', () => {
  const schemes: string[] = []
  for (const rule of rules) {
    if (rule.media !== null) continue
    if (!rule.selectors.includes(':root')) continue
    for (const declaration of rule.declarations) {
      if (declaration.property === 'color-scheme') schemes.push(declaration.value)
    }
  }
  assert.ok(schemes.includes('light dark'), `:root must declare color-scheme: light dark, got ${JSON.stringify(schemes)}`)

  const pinned = new Map<string, string>()
  for (const rule of rules) {
    if (rule.media !== null) continue
    const selector = rule.selectors.find((name) => name.startsWith(':root[data-theme='))
    if (selector === undefined) continue
    for (const declaration of rule.declarations) {
      if (declaration.property === 'color-scheme') pinned.set(selector, declaration.value)
    }
  }
  assert.equal(pinned.get(':root[data-theme="light"]'), 'light', 'the light override must pin color-scheme: light')
  assert.equal(pinned.get(':root[data-theme="dark"]'), 'dark', 'the dark override must pin color-scheme: dark')
})

// 2. The light palette exists twice on purpose: a media query cannot share one
//    declaration block with an attribute selector, and the system preference
//    has to work with JavaScript off. Both copies must define the whole palette
//    with the same token names, so a component cannot look right in one path
//    and wrong in the other.
test('the light palette is complete in the media query and under data-theme="light"', () => {
  const expected = [...colourTokens, ...lightOnlyTokens].sort()
  for (const [name, palette] of [[LIGHT_MEDIA, mediaLight], ['data-theme="light"', attributeLight]] as const) {
    const missing = expected.filter((token) => !palette.has(token))
    assert.deepEqual(missing, [], `${name} is missing: ${missing.join(', ')}`)
    const unknown = [...palette.keys()].filter((token) => !expected.includes(token))
    assert.deepEqual(unknown, [], `${name} declares tokens that are not palette colours: ${unknown.join(', ')}`)
    for (const [token, value] of palette) {
      if (token === '--shadow') {
        assert.match(value, /^0 \d+px \d+px rgba\(/, `--shadow in ${name} must stay a soft rgba shadow, got ${value}`)
        continue
      }
      assert.ok(channels(value) !== null, `${token} in ${name} must be a hex colour, got ${value}`)
      // --accent-ink and --paper are white in both palettes by contract; every
      // other colour has to move, or the block is a copy of the dark palette.
      if (token !== '--accent-ink' && token !== '--paper') {
        assert.notEqual(value, dark.get(token), `${token} in ${name} still carries the dark value ${value}`)
      }
    }
  }
})

// 3. It has to actually be light: surfaces carry a high luminance, ink a low
//    one. A palette copied from the dark block passes a "block exists" scan and
//    this assertion is what catches it.
test('the light palette paints light surfaces with dark ink', () => {
  for (const surface of ['--bg', '--bg-soft', '--panel', '--panel-2', '--field']) {
    const value = attributeLight.get(surface)
    assert.ok(value !== undefined, `missing ${surface}`)
    const ratio = luminance(channels(value) ?? [0, 0, 0])
    assert.ok(ratio > 0.7, `${surface} = ${value} is not a light surface (luminance ${ratio.toFixed(2)})`)
  }
  for (const ink of ['--text', '--muted', '--muted-2']) {
    const value = attributeLight.get(ink)
    assert.ok(value !== undefined, `missing ${ink}`)
    const ratio = luminance(channels(value) ?? [255, 255, 255])
    assert.ok(ratio < 0.35, `${ink} = ${value} is not dark ink (luminance ${ratio.toFixed(2)})`)
  }
  const muted = luminance(channels(attributeLight.get('--muted') ?? '#000') ?? [0, 0, 0])
  const muted2 = luminance(channels(attributeLight.get('--muted-2') ?? '#000') ?? [0, 0, 0])
  assert.ok(muted < muted2, '--muted must stay darker than --muted-2, the dimmer step')
})

// 4. WCAG 2.1 AA in the light palette too: body and secondary text clear 4.5:1
//    on every surface they are painted on, the 10-13px --muted-2 step clears it
//    on the lightest surfaces, and the badge, brand, status and scrollbar pairs
//    keep their stated ratios.
test('the light palette clears WCAG 2.1 AA for text, badges and the scrollbar', () => {
  const palette = attributeLight
  const value = (token: string): string => {
    const found = palette.get(token)
    assert.ok(found !== undefined, `missing ${token}`)
    return found
  }
  const failures: string[] = []
  const check = (label: string, foreground: string, background: string, minimum: number, kind: 'text' | 'ui'): void => {
    const ratio = contrast(foreground, background)
    if (ratio < minimum) failures.push(`${label} = ${ratio.toFixed(2)}:1 (needs ${minimum}:1, ${kind})`)
  }

  const surfaces = ['--bg', '--bg-soft', '--panel', '--panel-2', '--surface-sunken', '--surface-inset', '--surface-raised', '--field']
  for (const surface of surfaces) {
    check(`--text on ${surface}`, value('--text'), value(surface), 4.5, 'text')
  }
  for (const surface of ['--bg', '--bg-soft', '--panel', '--panel-2']) {
    check(`--muted on ${surface}`, value('--muted'), value(surface), 4.5, 'text')
    check(`--muted-2 on ${surface}`, value('--muted-2'), value(surface), 4.5, 'text')
  }
  for (const ink of ['--brand', '--brand-2', '--good', '--warn', '--danger', '--accent', '--violet']) {
    check(`${ink} on --panel`, value(ink), value('--panel'), 4.5, 'text')
    check(`${ink} on --bg`, value(ink), value('--bg'), 4.5, 'text')
  }
  check('--accent-ink on --accent-strong', value('--accent-ink'), value('--accent-strong'), 4.5, 'text')
  check('--badge-ink on --badge-bg', value('--badge-ink'), value('--badge-bg'), 4.5, 'text')
  check('--lede-ink on --panel', value('--lede-ink'), value('--panel'), 4.5, 'text')
  check('--tip-ink on --surface-raised', value('--tip-ink'), value('--surface-raised'), 4.5, 'text')
  check('--scroll-track on --panel', value('--scroll-track'), value('--panel'), 3, 'ui')
  check('--scroll-track on --scroll-thumb', value('--scroll-track'), value('--scroll-thumb'), 3, 'ui')

  assert.deepEqual(failures, [], `the light palette fails accessibility:\n${failures.join('\n')}`)
})

// 5. The media branch must leave an explicit dark choice alone: a reader on a
//    light desktop who picks dark has to get dark, not a half-light page.
test('the media branch does not override an explicit data-theme="dark"', () => {
  const selectors = rules
    .filter((rule) => rule.media === LIGHT_MEDIA)
    .flatMap((rule) => rule.selectors)
  assert.ok(selectors.includes(':root:not([data-theme="dark"])'), 'the media branch must exclude [data-theme="dark"]')
  const paletteImportant = rules
    .filter((rule) => rule.media === LIGHT_MEDIA || rule.selectors.some((name) => name.startsWith(':root[data-theme=')))
    .flatMap((rule) => rule.declarations)
    .filter((declaration) => declaration.value.includes('!important'))
  assert.deepEqual(paletteImportant, [], 'the palette must win by specificity, not !important')
})

// 6. Both palettes are the documented contract, not a stylesheet secret: the
//    token page names the two selectors, the light values and the contrast rule.
test('docs/ui.md documents the light palette and how it is selected', () => {
  assert.match(doc, /prefers-color-scheme:\s*light/, 'docs/ui.md must document the system preference')
  assert.match(doc, /data-theme="light"/, 'docs/ui.md must document the explicit light override')
  assert.match(doc, /data-theme="dark"/, 'docs/ui.md must document the explicit dark override')
  for (const token of ['--bg', '--panel', '--text', '--muted-2', '--accent', '--danger']) {
    assert.ok(doc.includes(token), `docs/ui.md must document ${token}`)
  }
  const lightBg = attributeLight.get('--bg')
  assert.ok(lightBg !== undefined)
  assert.ok(doc.toLowerCase().includes(lightBg.toLowerCase()), `docs/ui.md must list the light --bg value ${lightBg}`)
  assert.match(doc, /light palette|Light palette/i, 'docs/ui.md needs a light-palette section')
})
