import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

function declarations(block: string): Map<string, string> {
  const tokens = new Map<string, string>()
  for (const declaration of block.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator === -1) continue
    const name = declaration.slice(0, separator).trim()
    const value = declaration.slice(separator + 1).trim()
    if (name.startsWith('--')) tokens.set(name, value)
  }
  return tokens
}

function rootTokens(source: string): Map<string, string> {
  const match = /:root\s*\{([^}]*)\}/.exec(source)
  assert.ok(match !== null, 'public/app.css must keep a :root token block')
  return declarations(match[1] ?? '')
}

// The two light palettes are separate blocks: the media query one carries an
// owner, so the declaration parser reads the block the selector names rather
// than whichever `:root` happens to come first.
function paletteTokens(pattern: RegExp, label: string): Map<string, string> {
  const match = pattern.exec(cssSource)
  assert.ok(match !== null, `public/app.css must keep the ${label} token block`)
  return declarations(match[1] ?? '')
}

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

// 1. The scale tokens exist and hold the values the issue asked for: a 4px
//    spacing ramp, a six-step type scale, three radii, two durations and a
//    44px touch floor. A token block without these is a palette, not a system.
test('the token block carries the spacing, type, radius, motion and touch scales', () => {
  const tokens = rootTokens(cssSource)
  const missing: string[] = []
  for (const step of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const value = tokens.get(`--space-${step}`)
    if (value === undefined) {
      missing.push(`--space-${step}`)
      continue
    }
    const px = /^(\d+(?:\.\d+)?)px$/.exec(value)
    if (px === null) missing.push(`--space-${step} must be a px value, got ${value}`)
    else if (Number(px[1]) % 4 !== 0) missing.push(`--space-${step} = ${value} is off the 4px scale`)
  }
  const sizes = [1, 2, 3, 4, 5, 6, 7, 8].map((step) => Number((tokens.get(`--space-${step}`) ?? '0').replace('px', '')))
  if (sizes.some((value, index) => index > 0 && value <= (sizes[index - 1] ?? 0))) missing.push('--space-1..8 must increase')
  for (const name of ['--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-2xl']) {
    if (tokens.get(name) === undefined) missing.push(name)
  }
  for (const name of ['--radius-sm', '--radius-md', '--radius-lg', '--motion-fast', '--motion-base']) {
    if (tokens.get(name) === undefined) missing.push(name)
  }
  if (tokens.get('--touch') !== '44px') missing.push('--touch must be 44px')
  assert.deepEqual(missing, [], `missing design tokens: ${missing.join(', ')}`)
})

// 2. Colour lives in the token blocks only: the dark :root palette and the two
//    light ones (`:root:not([data-theme="dark"])` under prefers-color-scheme and
//    `:root[data-theme="light"]`). rgba() stays legal outside them: an alpha tint
//    cannot name a solid token without losing the transparency.
test('no colour literal escapes the token block', () => {
  const withoutRoot = cssSource.replace(/:root[^{]*\{[^}]*\}/g, '')
  const offenders: string[] = []
  withoutRoot.split('\n').forEach((line, index) => {
    const selectorEnd = line.indexOf('{')
    const declarations = selectorEnd === -1 ? line : line.slice(selectorEnd + 1)
    if (!declarations.includes(':')) return
    for (const match of declarations.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      offenders.push(`public/app.css:${index + 1} ${match[0]} in ${declarations.trim().slice(0, 80)}`)
    }
  })
  assert.deepEqual(offenders, [], `colour literals outside :root:\n${offenders.join('\n')}`)
})

// 3. --muted-2 paints 10-13px text (.fine, <small>, .count, .foot, table
//    headers), so WCAG 2.1 AA needs 4.5:1 on every surface it can land on — and
//    it must stay dimmer than --muted, or the hierarchy the console relies on
//    disappears and both colours end up looking like body text.
test('--muted-2 clears AA on every surface it is painted on and stays below --muted', () => {
  const tokens = rootTokens(cssSource)
  const muted2 = tokens.get('--muted-2')
  assert.ok(muted2 !== undefined, 'missing --muted-2')
  const failures: string[] = []
  for (const surface of ['--panel-2', '--panel', '--bg-soft', '--bg']) {
    const background = tokens.get(surface)
    assert.ok(background !== undefined, `missing surface token ${surface}`)
    const ratio = contrast(muted2, background)
    if (ratio < 4.5) failures.push(`--muted-2 on ${surface} = ${ratio.toFixed(2)}:1 (needs 4.5)`)
  }
  assert.deepEqual(failures, [], `--muted-2 is too dark:\n${failures.join('\n')}`)
  const muted = tokens.get('--muted')
  assert.ok(muted !== undefined, 'missing --muted')
  assert.ok(luminance(channels(muted) ?? [0, 0, 0]) > luminance(channels(muted2) ?? [0, 0, 0]), '--muted-2 must stay dimmer than --muted')

  // #911: a token can be readable on one fill and unreadable on another, so the
  // AA floor also covers the pairs a rule actually paints: --accent-ink on
  // --accent is 1.92:1 in the dark palette, and a 12px mark sat on it. The scan
  // reads the palette with the line-anchored reader on purpose: the :root block
  // carries a semicolon inside a comment, and the whole-block reader drops
  // --accent with it, which is how the pair stayed unseen. Both palettes are
  // checked, because the same rule paints in light too.
  const palettes: Array<[string, Map<string, string>]> = [
    ['dark', lineTokens(cssSource, /:root\s*\{([^}]*)\}/, 'dark')],
    ['light', lineTokens(cssSource, /:root\[data-theme="light"\]\s*\{([^}]*)\}/, '[data-theme="light"]')],
  ]
  const unreadable: string[] = []
  for (const rule of cssSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = rule[2] ?? ''
    const colour = /(?:^|;)\s*color:\s*var\((--[a-z0-9-]+)\)/.exec(body)
    const background = /(?:^|;)\s*background(?:-color)?:\s*var\((--[a-z0-9-]+)\)/.exec(body)
    if (colour === null || background === null) continue
    const selector = (rule[1] ?? '').trim().split('\n').pop()?.trim() ?? ''
    for (const [name, palette] of palettes) {
      const foreground = palette.get(colour[1] ?? '')
      const surface = palette.get(background[1] ?? '')
      if (foreground === undefined || surface === undefined) continue
      if (channels(foreground) === null || channels(surface) === null) continue
      const ratio = contrast(foreground, surface)
      if (ratio < 4.5) unreadable.push(`${name} ${selector}: ${colour[1]} on ${background[1]} = ${ratio.toFixed(2)}:1 (needs 4.5)`)
    }
  }
  assert.deepEqual(unreadable, [], `text below AA on the fill it is painted on:\n${unreadable.join('\n')}`)
})

// 4. The token contract is documented, not only implemented: one row per token
//    plus the naming and contrast rules a new component has to follow.
test('docs/ui.md documents the token table, the naming rules and the contrast rule', () => {
  const doc = readFileSync(new URL('../docs/ui.md', import.meta.url), 'utf8')
  const tokens = rootTokens(cssSource)
  const absent = [...tokens.keys()].filter((name) => !doc.includes(name))
  assert.deepEqual(absent, [], `docs/ui.md does not mention: ${absent.join(', ')}`)
  assert.match(doc, /^\|\s*Group\s*\|/m, 'docs/ui.md needs a token table with a header row')
  assert.match(doc, /命名规则|Naming rules/i, 'docs/ui.md needs a naming-rules section')
  assert.match(doc, /对比度|Contrast/i, 'docs/ui.md needs a contrast section')
})

test('docs/architecture.md links to the UI token contract', () => {
  const architecture = readFileSync(new URL('../docs/architecture.md', import.meta.url), 'utf8')
  assert.match(architecture, /\(ui\.md\)|docs\/ui\.md/, 'docs/architecture.md must point at docs/ui.md')
})

// 5. The workspace frame is a --header-h consumer like the anchors: it must
//    subtract the measured header, not a private constant, while the 620px floor
//    that keeps short viewports usable stays in the rule.
test('the workspace frame derives its height from --header-h and keeps its 620px floor', () => {
  const rule = /\.workspace-frame\s*\{([^}]*)\}/.exec(cssSource)
  assert.ok(rule !== null, 'public/app.css must keep a .workspace-frame rule')
  const body = rule[1] ?? ''
  const height = /(?:^|;)\s*height:\s*([^;]+);/.exec(body)
  assert.ok(height !== null, '.workspace-frame must declare a height')
  const value = (height[1] ?? '').trim()
  assert.match(value, /^calc\(\s*100vh\s*-\s*var\(\s*--header-h\s*\)\s*\)$/, `.workspace-frame height must be calc(100vh - var(--header-h)), got ${value}`)
  assert.doesNotMatch(value, /\d+px/, 'the frame must not subtract a private pixel constant')
  assert.match(body, /min-height:\s*620px/, 'the 620px floor must stay')
})

// 6. The resting field boundary is the only thing that shows where a text field
//    begins: the fill itself is 1.04:1 against the panel in dark and 1.00:1 in
//    light, so WCAG 2.2 1.4.11 wants 3:1 from the border (#596). The boundary
//    gets its own token because --line paints every card, table and divider;
//    the field rule must consume the token, not the surface hairline.
test('the resting field boundary clears the 3:1 non-text minimum in every palette', () => {
  const palettes: Array<[string, Map<string, string>]> = [
    ['dark :root', rootTokens(cssSource)],
    ['prefers-color-scheme light', paletteTokens(/:root:not\(\[data-theme="dark"\]\)\s*\{([^}]*)\}/, 'prefers-color-scheme light')],
    ['[data-theme="light"]', paletteTokens(/:root\[data-theme="light"\]\s*\{([^}]*)\}/, '[data-theme="light"]')],
  ]
  const failures: string[] = []
  for (const [name, tokens] of palettes) {
    const boundary = tokens.get('--field-line')
    if (boundary === undefined) {
      failures.push(`${name}: no --field-line token`)
      continue
    }
    // The border sits on the field's edge: the fill is on one side and the card
    // the form is drawn on is on the other, so each pair is a 1.4.11 pair.
    for (const surface of ['--field', '--panel', '--panel-2', '--bg']) {
      const background = tokens.get(surface)
      if (background === undefined) {
        failures.push(`${name}: missing ${surface}`)
        continue
      }
      const ratio = contrast(boundary, background)
      if (ratio < 3) failures.push(`${name}: --field-line on ${surface} = ${ratio.toFixed(2)}:1 (needs 3:1)`)
    }
  }
  assert.deepEqual(failures, [], `the field boundary is below the non-text minimum:\n${failures.join('\n')}`)

  const fieldRule = /(?:^|\n)\s*input,\s*textarea,\s*select\s*\{([^}]*)\}/.exec(cssSource)
  assert.ok(fieldRule !== null, 'public/app.css must keep the shared input, textarea, select rule')
  assert.match(fieldRule[1] ?? '', /border:\s*1px solid var\(--field-line\)/, 'the shared field rule must draw its boundary with --field-line, not --line')
})

// The token blocks carry prose comments, and a comment may contain a semicolon;
// a line-anchored reader is what sees every token in the block rather than the
// whole-block split the older assertions use.
function lineTokens(source: string, pattern: RegExp, label: string): Map<string, string> {
  const match = pattern.exec(source)
  assert.ok(match !== null, `public/app.css must keep the ${label} token block`)
  const tokens = new Map<string, string>()
  for (const line of (match[1] ?? '').split('\n')) {
    const declaration = /^\s*(--[a-z0-9-]+):\s*([^;]+);/.exec(line)
    if (declaration !== null) tokens.set(declaration[1] ?? '', (declaration[2] ?? '').trim())
  }
  return tokens
}

// 7. #547: the flight-deck foundation. The console is not a warm-cream template
//    and not a periwinkle/lime one: a cool mineral paper, pine/sage action, a
//    brass decorative note, a serif wordmark over system-sans body text, a
//    square 4/6/8/10 radius scale and no uppercase labels or card shadows.
test('the flight-deck palette replaces the warm and periwinkle templates', () => {
  const dark = lineTokens(cssSource, /:root\s*\{([^}]*)\}/, 'dark')
  const light = lineTokens(cssSource, /:root\[data-theme="light"\]\s*\{([^}]*)\}/, '[data-theme="light"]')
  const expected: Array<[string, Map<string, string>, string, string]> = [
    ['--bg', dark, '#0b100e', 'graphite-green'],
    ['--panel', dark, '#101814', 'section panel'],
    ['--text', dark, '#e9efe9', 'cool text'],
    ['--accent', dark, '#8fbfa8', 'sage accent'],
    ['--brand', dark, '#c49a5a', 'brass brand'],
    ['--brand-2', dark, '#8fb39a', 'sage brand'],
    ['--good', dark, '#8fbfa8', 'sage good'],
    ['--warn', dark, '#d6a75b', 'amber warn'],
    ['--bg', light, '#eef1ea', 'cool paper'],
    ['--panel', light, '#f8faf5', 'cool panel'],
    ['--text', light, '#18201b', 'ink'],
    ['--accent', light, '#2f6b57', 'pine accent'],
  ]
  const wrong = expected
    .filter(([token, palette, value]) => palette.get(token) !== value)
    .map(([token, palette, value, label]) => `${label} ${token} = ${palette.get(token) ?? 'missing'}, expected ${value}`)
  assert.deepEqual(wrong, [], `the flight-deck palette is not in place:\n${wrong.join('\n')}`)

  // Both earlier templates are gone from every palette, not only replaced in dark.
  const retired = [
    '#0d0c0b', '#161412', '#f3ede4', '#d97745', '#7fae9a', '#e0b36a', '#ad5530', '#f6f1e7', '#fffdf8', '#1d1a16',
    '#7b95ff', '#4c66f5', '#5f78ff', '#2b4fd0', '#1d3cb8', '#2646c4', '#b8f34a', '#6ee7a8', '#67e8c7', '#3f7a12', '#0e7a5c',
  ]
  const stale: string[] = []
  for (const [name, palette] of [['dark', dark], ['light', light]] as const) {
    for (const [token, value] of palette) {
      if (retired.includes(value.toLowerCase())) stale.push(`${name} ${token} = ${value}`)
    }
  }
  assert.deepEqual(stale, [], `an earlier template is still in the palette:\n${stale.join('\n')}`)

  // A cool accent is the point: the current warm template had red above blue.
  for (const [name, palette] of [['dark', dark], ['light', light]] as const) {
    const rgb = channels(palette.get('--accent') ?? '#000000') ?? [0, 0, 0]
    assert.ok(rgb[2] > rgb[0], `${name} --accent = ${palette.get('--accent')} is not cool (b must exceed r)`)
  }

  // The flight-deck radius scale: square sections, small controls, 999 only for
  // a circle. The card shell is square and does not take --radius.
  assert.equal(dark.get('--radius-xs'), '4px', '--radius-xs must be 4px')
  assert.equal(dark.get('--radius-sm'), '6px', '--radius-sm must be 6px')
  assert.equal(dark.get('--radius-md'), '8px', '--radius-md must be 8px')
  assert.equal(dark.get('--radius'), '10px', '--radius must be 10px')
  assert.equal(dark.get('--radius-lg'), '10px', '--radius-lg must be 10px')

  // Serif display for h1, the wordmark and the hero heading; mono stays.
  const display = dark.get('--display') ?? ''
  assert.match(display, /serif/i, '--display must name a serif stack')
  assert.match(dark.get('--mono') ?? '', /mono/i, '--mono must stay a mono stack')
  const h1 = /(?:^|\n)h1\s*\{([^}]*)\}/.exec(cssSource)
  assert.ok(h1 !== null, 'public/app.css must keep an h1 rule')
  assert.match(h1[1] ?? '', /font-family:\s*var\(--display\)/, 'h1 must use the display face')
  const brand = /(?:^|\n)\.brand\s*\{([^}]*)\}/.exec(cssSource)
  assert.ok(brand !== null, 'public/app.css must keep a .brand rule')
  assert.match(brand[1] ?? '', /font-family:\s*var\(--display\)/, '.brand must use the display face')
  const hero = /(?:^|\n)\.hero-copy h1\s*\{([^}]*)\}/.exec(cssSource)
  assert.ok(hero !== null, 'public/app.css must keep a .hero-copy h1 rule')
  assert.match(hero[1] ?? '', /font-family:\s*var\(--display\)/, '.hero-copy h1 must use the display face')

  // Body 14px/1.55 and the 12-13px meta steps the direction names.
  const body = /(?:^|\n)body\s*\{([^}]*)\}/.exec(cssSource)
  assert.ok(body !== null, 'public/app.css must keep a body rule')
  assert.match(body[1] ?? '', /font:\s*14px\/1\.55\s+-apple-system,/, 'body must be 14px/1.55 in the system sans face')
  assert.equal(dark.get('--text-xs'), '12px', '--text-xs must stay 12px')
  assert.equal(dark.get('--text-sm'), '13px', '--text-sm must stay 13px')

  // No uppercase eyebrows and no 80px bloom: sentences and a hairline do the work.
  assert.doesNotMatch(cssSource, /text-transform:\s*uppercase/, 'the template eyebrows must not stay uppercase')
  for (const [name, palette] of [['dark', dark], ['light', light]] as const) {
    const shadow = palette.get('--shadow') ?? ''
    assert.match(shadow, /^0 \d+px \d+px rgba\(/, `${name} --shadow must stay a soft rgba shadow, got ${shadow}`)
    const parts = /^0 (\d+)px (\d+)px/.exec(shadow) ?? []
    assert.ok(Number(parts[1] ?? '99') <= 8 && Number(parts[2] ?? '99') <= 24, `${name} --shadow is ${shadow}; the flight deck allows at most 0 8px 24px`)
  }
  const consumers = cssSource.split('\n').filter((line) => line.includes('box-shadow: var(--shadow)'))
  assert.ok(consumers.length > 0, 'the popover and dialog rules must keep reading --shadow')
  assert.ok(!/\.card\b[^\n]*box-shadow: var\(--shadow\)/.test(cssSource), 'a card keeps a 1px border instead of a drop shadow')

  // The old templates also lived in rgba tints; those are part of the template too.
  const oldTints = /rgba\(\s*(123|184|103|240|255|110|182|217|127|224|232)\s*,\s*(149|243|232|198|138|231|156|119|174|179|138)\s*,\s*(255|74|199|116|138|168|255|69|154|106|125)\s*,/g
  const tints = [...cssSource.matchAll(oldTints)].map((match) => match[0])
  assert.deepEqual(tints, [], `an earlier template tint survives outside the tokens:\n${tints.join('\n')}`)
})

// 8. The flight-deck palette still has to be readable: body and secondary text clear
//    4.5:1 on every surface, the button ink clears it on the accent and on the
//    stronger hover step, and the components read their colours from the tokens
//    rather than literals.
test('the flight-deck palette clears AA for text and control pairs in both schemes', () => {
  const dark = lineTokens(cssSource, /:root\s*\{([^}]*)\}/, 'dark')
  const light = lineTokens(cssSource, /:root\[data-theme="light"\]\s*\{([^}]*)\}/, '[data-theme="light"]')
  const failures: string[] = []
  for (const [name, palette] of [['dark', dark], ['light', light]] as const) {
    const surfaces = ['--bg', '--bg-soft', '--panel', '--panel-2', '--surface-sunken', '--surface-inset', '--surface-raised', '--field']
    for (const surface of surfaces) {
      const background = palette.get(surface)
      const text = palette.get('--text')
      assert.ok(background !== undefined && text !== undefined, `${name}: missing ${surface} or --text`)
      const ratio = contrast(text, background)
      if (ratio < 4.5) failures.push(`${name}: --text on ${surface} = ${ratio.toFixed(2)}:1`)
    }
    for (const surface of ['--bg', '--panel', '--panel-2']) {
      const ink = palette.get('--accent')
      assert.ok(ink !== undefined, `${name}: missing --accent`)
      const ratio = contrast(ink, palette.get(surface) ?? '#000')
      if (ratio < 4.5) failures.push(`${name}: --accent on ${surface} = ${ratio.toFixed(2)}:1`)
    }
    for (const background of ['--accent-strong', '--accent-hover']) {
      const ratio = contrast(palette.get('--accent-ink') ?? '#000', palette.get(background) ?? '#000')
      if (ratio < 4.5) failures.push(`${name}: --accent-ink on ${background} = ${ratio.toFixed(2)}:1`)
    }
  }
  assert.deepEqual(failures, [], `the flight-deck palette is below AA:\n${failures.join('\n')}`)

  // Components take their colour from the tokens, so a future palette change is
  // one block and not a hunt through the component rules.
  const checks: Array<[RegExp, string]> = [
    [/\.btn\s*\{[^}]*background:\s*var\(--accent-strong\)/, '.btn background'],
    [/\.badge\s*\{[^}]*background:\s*var\(--badge-bg\)/, '.badge background'],
    [/th\s*\{[^}]*color:\s*var\(--muted-2\)/, 'table header colour'],
    [/\*:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/, 'focus ring'],
    [/input,\s*textarea,\s*select\s*\{[^}]*border:\s*1px solid var\(--field-line\)/, 'field boundary'],
  ]
  for (const [pattern, label] of checks) {
    assert.match(cssSource, pattern, `${label} must read a token, not a literal`)
  }
})
