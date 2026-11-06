import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const viewSources = {
  'src/views/layout.ts': readFileSync(new URL('../src/views/layout.ts', import.meta.url), 'utf8'),
  'src/views/pages.ts': readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8'),
}

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

// Every pair below is a colour/background combination the rendered UI really uses.
// `--muted-2` carries the small text (10-13px): .fine, <small>, .count, .foot,
// table headers and .account-exit. WCAG 2.1 AA needs 4.5:1 for text below 18.66px bold.
const TEXT_ON_SURFACE: Array<{ text: string; surfaces: string[]; where: string }> = [
  { text: '--text', surfaces: ['--bg', '--bg-soft', '--panel', '--panel-2'], where: 'body copy, card headings' },
  { text: '--muted', surfaces: ['--bg', '--bg-soft', '--panel', '--panel-2'], where: '.muted paragraphs, table cells' },
  { text: '--muted-2', surfaces: ['--bg', '--bg-soft', '--panel', '--panel-2'], where: '.fine, <small>, .count, .foot (10-13px)' },
  { text: '--accent', surfaces: ['--bg', '--panel'], where: 'links, .badge.kind, .link' },
  { text: '--good', surfaces: ['--panel'], where: '.badge.good, .link.good' },
  { text: '--warn', surfaces: ['--panel'], where: '.badge.busy, .pill-warn' },
  { text: '--danger', surfaces: ['--panel'], where: '.badge.bad, .fine.bad, .link.bad' },
]

test('every text token keeps WCAG AA contrast on the surface it is painted on', () => {
  const tokens = rootTokens(cssSource)
  const failures: string[] = []
  for (const pair of TEXT_ON_SURFACE) {
    const foreground = tokens.get(pair.text)
    assert.ok(foreground !== undefined, `missing token ${pair.text}`)
    for (const surface of pair.surfaces) {
      const background = tokens.get(surface)
      assert.ok(background !== undefined, `missing surface token ${surface}`)
      const ratio = contrast(foreground, background)
      if (ratio < 4.5) {
        failures.push(`${pair.text} on ${surface} = ${ratio.toFixed(2)}:1 (needs 4.5) — ${pair.where}`)
      }
    }
  }
  assert.deepEqual(failures, [], `contrast below WCAG AA:\n${failures.join('\n')}`)
})

test('primary button ink stays readable on the button fill', () => {
  const tokens = rootTokens(cssSource)
  const ink = tokens.get('--accent-ink')
  const fill = tokens.get('--accent-strong')
  assert.ok(ink !== undefined && fill !== undefined, 'missing --accent-ink or --accent-strong')
  assert.ok(contrast(ink, fill) >= 4.5, `--accent-ink on --accent-strong is ${contrast(ink, fill).toFixed(2)}:1`)
})

test('the token block carries a 4px spacing scale, a type scale, radius and motion tokens', () => {
  const tokens = rootTokens(cssSource)
  const missing: string[] = []
  const spaceSteps = [1, 2, 3, 4, 5, 6, 7, 8]
  for (const step of spaceSteps) {
    const value = tokens.get(`--space-${step}`)
    if (value === undefined) {
      missing.push(`--space-${step}`)
      continue
    }
    const px = /^(\d+(?:\.\d+)?)px$/.exec(value)
    if (px === null) missing.push(`--space-${step} must be a px value, got ${value}`)
    else if (Number(px[1]) % 4 !== 0) missing.push(`--space-${step} = ${value} is off the 4px scale`)
  }
  const sizes = spaceSteps.map((step) => Number((tokens.get(`--space-${step}`) ?? '0').replace('px', '')))
  if (sizes.some((value, index) => index > 0 && value <= (sizes[index - 1] ?? 0))) {
    missing.push('--space-1..8 must increase')
  }
  for (const name of ['--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-2xl']) {
    if (tokens.get(name) === undefined) missing.push(name)
  }
  for (const name of ['--radius-sm', '--radius-md', '--radius-lg']) {
    if (tokens.get(name) === undefined) missing.push(name)
  }
  for (const name of ['--motion-fast', '--motion-base']) {
    if (tokens.get(name) === undefined) missing.push(name)
  }
  assert.deepEqual(missing, [], `missing design tokens: ${missing.join(', ')}`)
})

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

test('templates do not inline layout styles', () => {
  const offenders: string[] = []
  for (const [file, source] of Object.entries(viewSources)) {
    source.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(/style="([^"]*)"/g)) {
        const declaration = match[1] ?? ''
        // A custom property is the one allowed channel: it lets the server pass a
        // computed value (a meter percentage) without shipping layout CSS.
        if (!/^\s*--[a-z0-9-]+\s*:/.test(declaration)) offenders.push(`${file}:${index + 1} style="${declaration.slice(0, 60)}"`)
      }
    })
  }
  assert.deepEqual(offenders, [], `inline styles in templates:\n${offenders.join('\n')}`)
})
