import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { layout } from '../src/views/layout.js'
import { makeUser, testConfig } from './helpers.js'

const cssText = (): string => readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const jsText = (): string => readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

// Measured with the render method recorded in the fixture; node:test has no layout engine.
const headerHeights = JSON.parse(readFileSync(new URL('./fixtures/header-heights.json', import.meta.url), 'utf8')) as {
  headroom: number
  renders: { breakpoint: string; media: string | null; viewport: string; measured: number }[]
}

function render(path: string, options: { admin?: boolean } = {}): string {
  const store = new Store(':memory:')
  const user = makeUser(store, { admin: options.admin === true })
  return layout({ title: 'x', viewer: { user, csrfToken: 'csrf-token' }, body: '', config: testConfig(), locale: 'en', path })
}

function navAnchor(html: string, href: string): string {
  const match = html.match(new RegExp(`<a [^>]*href="${href}"[^>]*>`))
  assert.ok(match !== null, `main navigation has no link to ${href}`)
  return match[0] ?? ''
}

function rule(css: string, selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))
  assert.ok(match !== null, `public/app.css has no rule for ${selector}`)
  return match[1] ?? ''
}

test('the main navigation marks the current page with aria-current', () => {
  const dashboard = render('/dashboard')
  assert.match(navAnchor(dashboard, '/dashboard'), /aria-current="page"/)
  assert.doesNotMatch(navAnchor(dashboard, '/console'), /aria-current/)
  assert.doesNotMatch(navAnchor(dashboard, '/settings'), /aria-current/)

  const consolePage = render('/console')
  assert.match(navAnchor(consolePage, '/console'), /aria-current="page"/)
  assert.doesNotMatch(navAnchor(consolePage, '/dashboard'), /aria-current/)

  const settings = render('/settings')
  assert.match(navAnchor(settings, '/settings'), /aria-current="page"/)
})

test('nested routes keep their section marked and admin is marked for admins', () => {
  assert.match(navAnchor(render('/repos/repo-1/jobs/job-1'), '/dashboard'), /aria-current="page"/)
  const adminMetrics = render('/admin/metrics', { admin: true })
  assert.match(navAnchor(adminMetrics, '/admin'), /aria-current="page"/)
  assert.doesNotMatch(navAnchor(adminMetrics, '/dashboard'), /aria-current/)
})

test('anchors offset by the sticky header height instead of a literal number', () => {
  const css = cssText()
  const anchor = rule(css, '[id]')
  assert.match(anchor, /scroll-margin-top:\s*var\(--header-h\)/, 'scroll-margin-top must follow --header-h')
  assert.match(rule(css, ':root'), /--header-h:\s*\d+px/, ':root must declare --header-h')
  const mobile = css.slice(css.indexOf('@media (max-width: 960px)'))
  const block = mobile.slice(0, mobile.indexOf('@media (max-width: 640px)'))
  assert.match(block, /--header-h:\s*\d+px/, 'the 960px breakpoint must re-declare --header-h for its own fixed row')
})

function mediaBlock(css: string, media: string): string {
  const start = css.indexOf(`@media ${media}`)
  assert.ok(start !== -1, `public/app.css has no @media ${media} block`)
  const open = css.indexOf('{', start)
  const block = css.slice(open + 1)
  const end = block.indexOf('\n}')
  assert.ok(end !== -1, `the @media ${media} block is not closed`)
  return block.slice(0, end)
}

function headerHeight(source: string, where: string): number {
  const match = /--header-h:\s*(\d+(?:\.\d+)?)px/.exec(source)
  assert.ok(match !== null, `${where} must declare --header-h in px`)
  return Number(match[1])
}

function blockFor(css: string, media: string | null): string {
  return media === null ? rule(css, ':root') : mediaBlock(css, media)
}

test('the static --header-h fallback keeps a line of headroom over the measured header', () => {
  const css = cssText()
  assert.equal(headerHeights.headroom, 20, 'the fallback keeps at least one 20px line of body text under the header')
  for (const { breakpoint, media, viewport, measured } of headerHeights.renders) {
    const fallback = headerHeight(blockFor(css, media), breakpoint)
    assert.ok(
      fallback >= measured + headerHeights.headroom,
      `${breakpoint} (${viewport}) declares --header-h: ${fallback}px, which leaves ${(fallback - measured).toFixed(1)}px under the measured ${measured}px header; the fallback needs ${headerHeights.headroom}px`,
    )
  }
})

test('the rendered header drives --header-h, and the layout ships that script', () => {
  const script = jsText()
  assert.match(script, /querySelector\(['"]\.top['"]\)/, 'public/app.js must measure the sticky header, not a copy of its class list')
  assert.match(script, /offsetHeight/, 'the header height must come from offsetHeight of the rendered element')
  assert.match(script, /setProperty\(\s*['"]--header-h['"]/, 'the measurement must be written back to --header-h')
  assert.match(script, /addEventListener\(\s*['"]resize['"]/, 'the header is re-measured when the viewport changes the wrapping')
  const setter = /const\s+syncHeaderOffset\s*=/.test(script)
  assert.ok(setter, 'public/app.js must name the updater syncHeaderOffset')
  assert.ok(
    script.split('syncHeaderOffset').length >= 3,
    'the updater must run once on load and once per resize, not only be defined',
  )

  const html = render('/dashboard')
  assert.match(html, /<script src="\/assets\/app\.js" defer><\/script>/, 'the layout must load the updater it depends on')
})

test('touch targets in the shell follow the --touch token', () => {
  const css = cssText()
  assert.match(rule(css, ':root'), /--touch:\s*44px/, ':root must declare --touch as 44px')
  for (const selector of ['.btn', '.nav a', '.lang a', '.account-exit']) {
    assert.match(rule(css, selector), /min-height:\s*var\(--touch\)/, `${selector} must offer the --touch target instead of repeating the number`)
  }
  // A short label is still a target: these pills are narrower than --touch otherwise.
  for (const selector of ['.nav a', '.lang a', '.account-exit']) {
    assert.match(rule(css, selector), /min-width:\s*var\(--touch\)/, `${selector} must be at least --touch wide, not only tall`)
  }
})
