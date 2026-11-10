import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { layout } from '../src/views/layout.js'
import { makeUser, testConfig } from './helpers.js'

// #233: at 641-960px the header kept the desktop wrap. The nav took a full-width
// row of its own and .top stood 215px at 768px — a quarter of a tablet viewport —
// while the phone band below 641px already had a fixed 64px row and a toggle
// (#133/#186). The contract below is the one this repo can hold without a layout
// engine, the same shape #133 uses for the phone: the band declares ONE fixed
// height, and the navigation it collapses is still reachable through the toggle
// the markup already renders at every width.

const cssText = (): string => readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const jsText = (): string => readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

function mediaBlock(css: string, media: string): string {
  const start = css.indexOf(`@media ${media}`)
  assert.ok(start !== -1, `public/app.css has no @media ${media} block`)
  const open = css.indexOf('{', start)
  const body = css.slice(open + 1)
  const end = body.indexOf('\n}')
  assert.ok(end !== -1, `the @media ${media} block is not closed`)
  return body.slice(0, end)
}

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`(?:^|\\n)[ \\t]*${escaped} \\{([^}]*)\\}`))
  assert.ok(match !== null, `public/app.css has no rule for ${selector}`)
  return match[1] ?? ''
}

type StyleRule = { selector: string; body: string; media: string | null }

// A text assertion on the band is what let a hidden toggle ship: the band said
// `display: inline-flex` and the base rule further down the file won the
// cascade. This walks the stylesheet in source order — the same order the
// browser uses between two selectors of equal specificity — and returns the
// winning value at a width. Test's chromium at the previous tip is the
// instrument for the pixel half; this is the half that can live here.
function styleRules(css: string): StyleRule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: StyleRule[] = []
  const walk = (text: string, media: string | null): void => {
    let buf = ''
    let i = 0
    while (i < text.length) {
      if (text[i] !== '{') {
        buf += text[i] ?? ''
        i += 1
        continue
      }
      const head = buf.trim()
      buf = ''
      let depth = 1
      let j = i + 1
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth += 1
        else if (text[j] === '}') depth -= 1
        j += 1
      }
      const body = text.slice(i + 1, j - 1)
      if (head.startsWith('@media')) walk(body, head.slice('@media'.length).trim())
      else if (!head.startsWith('@')) out.push({ selector: head, body, media })
      i = j
    }
  }
  walk(src, null)
  return out
}

function mediaMatches(query: string, width: number): boolean {
  const match = /^\(max-width:\s*(\d+)px\)$/.exec(query)
  assert.ok(match !== null, `the toggle pin cannot evaluate the media query "${query}"`)
  return width <= Number(match[1] ?? 0)
}

function displayAt(rules: StyleRule[], width: number): string | undefined {
  let winner: string | undefined
  for (const item of rules) {
    if (item.selector !== '.nav-toggle') continue
    if (item.media !== null && !mediaMatches(item.media, width)) continue
    const declared = /(?:^|;)\s*display:\s*([a-z-]+)/.exec(item.body)?.[1]
    if (declared !== undefined) winner = declared
  }
  return winner
}

function render(): string {
  const store = new Store(':memory:')
  const user = makeUser(store, { admin: true })
  return layout({ title: 'x', viewer: { user, csrfToken: 'csrf-token' }, body: '', config: testConfig(), locale: 'en', path: '/dashboard' })
}

test('the 641-960px band declares a header budget below 100px', () => {
  const band = mediaBlock(cssText(), '(max-width: 960px)')
  const declared = /--header-h:\s*(\d+)px/.exec(band)?.[1]
  assert.ok(declared !== undefined, 'the tablet band must re-declare --header-h; without it the no-JS offset keeps the wide header value')
  const fallback = Number(declared)
  assert.ok(
    fallback < 100,
    `--header-h in the 641-960 band is ${fallback}px; #233 bounds the header at 768px below 100px`,
  )

  const row = rule(band, '.top-inner')
  const height = /(?:^|;)\s*height:\s*(\d+)px/.exec(row)?.[1]
  assert.ok(height !== undefined, 'the tablet header must declare a fixed .top-inner height, not a content-driven one')
  assert.ok(
    Number(height) + 1 < 100,
    `the fixed row is ${height}px plus the 1px .top border = ${Number(height) + 1}px, which is not below the 100px budget`,
  )
  assert.match(row, /flex-wrap:\s*nowrap/, 'the row may not wrap: a second row is what made the header 215px')
  // The fallback has to cover the fixed row with the same headroom the phone
  // band promises (#133): one 20px line of body text under the header.
  assert.ok(fallback >= Number(height) + 1 + 20, `${fallback}px of no-JS fallback leaves less than 20px over the ${Number(height) + 1}px header`)
})

test('the tablet band collapses the navigation behind the toggle the markup already renders', () => {
  const band = mediaBlock(cssText(), '(max-width: 960px)')
  assert.match(
    rule(band, '.nav-toggle'),
    /display:\s*inline-flex/,
    'the tablet band must show the menu toggle; the base rule hides it and nothing else in this band turns it on',
  )
  const nav = rule(band, '.top .nav')
  assert.match(nav, /display:\s*none/, 'the navigation must be collapsed by default in the tablet band')
  assert.match(
    nav,
    /position:\s*absolute/,
    'the open menu must overlay the page, so .top keeps its collapsed height and the sticky offset does not move',
  )
  assert.match(
    band,
    /\.top\[data-nav-open="true"\]\s+\.nav\s*\{[^}]*display:\s*flex/,
    'the toggle must reveal the same navigation it hides',
  )

  const html = render()
  assert.match(html, /<button[^>]*data-nav-toggle[^>]*aria-expanded="false"[^>]*aria-controls="main-nav"/, 'the toggle the band shows must be one the layout renders')
  assert.match(html, /<nav class="nav" id="main-nav"/, 'the panel the band positions must be the navigation the layout renders')
  for (const href of ['/console', '/dashboard', '/settings', '/admin']) {
    assert.match(html, new RegExp(`href="${href}"`), `the tablet panel must still reach ${href}`)
  }
})

test('the toggle wins the cascade in the 641-960 band, not only the band text', () => {
  // Test's chromium at the previous tip (641/768/960, zh and en, menu closed):
  // .nav-toggle computed display: none — only brand, 中/EN and 退出 were visible
  // — so the menu was unreachable on a tablet while phones at 360/640 were fine.
  // The band's rule and the base `.nav-toggle { display: none }` have the same
  // specificity, so the later one wins; the base rule sat below the band and
  // above the 640px block, which is exactly why only the phone worked.
  const rules = styleRules(cssText())
  for (const width of [641, 768, 960]) {
    assert.equal(
      displayAt(rules, width),
      'inline-flex',
      `at ${width}px the winning .nav-toggle display is not inline-flex: with equal specificity the last declaration wins, so the base hide rule has to sit above the compact bands, not between them`,
    )
  }
  for (const width of [360, 640]) {
    assert.equal(displayAt(rules, width), 'inline-flex', `the phone band at ${width}px must keep the visible toggle it already had`)
  }
  for (const width of [961, 1280]) {
    assert.equal(displayAt(rules, width), 'none', `at ${width}px the toggle must stay hidden: the panel it opens does not exist outside the compact bands`)
  }
})

test('no control in the tablet band falls below the 44px touch floor', () => {
  const css = cssText()
  const band = mediaBlock(css, '(max-width: 960px)')
  assert.match(rule(band, '.nav-toggle'), /min-(height|width):\s*var\(--touch\)/, '.nav-toggle must keep its --touch floor')
  assert.match(rule(band, '.top .nav a'), /min-height:\s*var\(--touch\)/, 'panel rows are the destinations: each needs the 44px floor')
  for (const selector of ['.lang a', '.account-exit']) {
    assert.match(rule(css, selector), /min-(height|width):\s*var\(--touch\)/, `${selector} stays visible in the tablet band and must keep its --touch floor`)
  }
})

test('the script closes the panel at the breakpoint the stylesheet collapses at', () => {
  const script = jsText()
  const jsBand = /matchMedia\('\(max-width: (\d+)px\)'\)/.exec(script)?.[1]
  assert.ok(jsBand !== undefined, 'public/app.js must still close the panel when the viewport leaves the compact band')
  assert.equal(
    jsBand,
    '960',
    `public/app.js closes the panel on a ${jsBand}px media query while the stylesheet collapses the header at 960px; a reader who widens the window past the band would keep an open panel over a header with no toggle`,
  )
  // The band this file pins is the one that carries the compact row, so moving
  // either number alone fails: read it back out of the stylesheet.
  const band = mediaBlock(cssText(), `(max-width: ${jsBand}px)`)
  assert.match(rule(band, '.top .nav'), /display:\s*none/, 'the media query the script listens on must be the band that collapses the header')
})
