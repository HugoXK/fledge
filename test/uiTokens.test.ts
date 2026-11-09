import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

function rootTokens(source: string): Map<string, string> {
  const match = /:root\s*\{([^}]*)\}/.exec(source)
  assert.ok(match !== null, 'public/app.css must keep a :root token block')
  const tokens = new Map<string, string>()
  for (const declaration of (match[1] ?? '').split(';')) {
    const separator = declaration.indexOf(':')
    if (separator === -1) continue
    const name = declaration.slice(0, separator).trim()
    const value = declaration.slice(separator + 1).trim()
    if (name.startsWith('--')) tokens.set(name, value)
  }
  return tokens
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

// 2. Colour lives in the token block only. rgba() stays legal outside it: an
//    alpha tint cannot name a solid token without losing the transparency.
test('no colour literal escapes the token block', () => {
  const withoutRoot = cssSource.replace(/:root\s*\{[^}]*\}/g, '')
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
