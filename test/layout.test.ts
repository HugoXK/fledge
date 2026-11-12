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

function render(path: string, options: { admin?: boolean; active?: string } = {}): string {
  const store = new Store(':memory:')
  const user = makeUser(store, { admin: options.admin === true })
  return layout({ title: 'x', viewer: { user, csrfToken: 'csrf-token' }, body: '', config: testConfig(), locale: 'en', path, active: options.active })
}

function navAnchor(html: string, href: string): string {
  const match = html.match(new RegExp(`<a [^>]*href="${href}"[^>]*>`))
  assert.ok(match !== null, `main navigation has no link to ${href}`)
  return match[0] ?? ''
}

function navBlock(html: string): string {
  const match = html.match(/<nav class="nav" id="main-nav"[\s\S]*?<\/nav>/)
  assert.ok(match !== null, 'main navigation is missing')
  return match[0] ?? ''
}

// #93: at most one nav item may claim `aria-current="page"`, and only when the
// route is that item's own page; a section match is `aria-current="true"`.
function pageAnchors(html: string): string[] {
  return navBlock(html).match(/<a [^>]*aria-current="page"[^>]*>/g) ?? []
}

function rule(css: string, selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))
  assert.ok(match !== null, `public/app.css has no rule for ${selector}`)
  return match[1] ?? ''
}

test('the main navigation marks the page it is on, and only that page', () => {
  for (const [path, href] of [['/dashboard', '/dashboard'], ['/dashboard/', '/dashboard'], ['/console', '/console'], ['/settings', '/settings']] as const) {
    const html = render(path)
    assert.match(navAnchor(html, href), /aria-current="page"/, `${path} does not mark ${href} as the page`)
    assert.equal(pageAnchors(html).length, 1, `${path} claims more than one current page`)
    for (const other of ['/console', '/dashboard', '/settings']) {
      if (other === href) continue
      assert.doesNotMatch(navAnchor(html, other), /aria-current/, `${path} marks ${other} too`)
    }
  }
})

test('nested routes keep their section marked but never claim to be the page', () => {
  const cases = [
    { path: '/repos/repo-1/jobs/job-1', href: '/dashboard' },
    { path: '/repos/r1/workspace', href: '/dashboard' },
    { path: '/dashboard/extra', href: '/dashboard' },
    { path: '/settings/model', href: '/settings' },
    { path: '/admin/metrics', href: '/admin' },
    { path: '/jobs/j1', href: '/dashboard', active: 'dashboard' }
  ]
  for (const item of cases) {
    const html = render(item.path, { admin: true, active: item.active })
    const anchor = navAnchor(html, item.href)
    assert.match(anchor, /class="on"/, `${item.path} lost the section highlight`)
    assert.match(anchor, /aria-current="true"/, `${item.path} does not announce its section`)
    assert.doesNotMatch(anchor, /aria-current="page"/, `${item.path} claims to be the page`)
    assert.equal(pageAnchors(html).length, 0, `${item.path} claims a current page`)
  }

  const adminMetrics = render('/admin/metrics', { admin: true })
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

test('the viewport opts into the notch and the CSS uses dvh and a safe-area inset', () => {
  const html = render('/dashboard')
  assert.match(
    html,
    /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" \/>/,
    'the viewport meta must opt into the notch',
  )
  const css = cssText()
  assert.match(css, /min-height:\s*100dvh/, 'the page must use dvh with the 100vh fallback before it')
  assert.match(css, /height:\s*calc\(100dvh - var\(--header-h\)\)/, 'the workspace frame must follow the dynamic viewport')
  assert.match(css, /env\(safe-area-inset-bottom\)/, 'the page must respect the bottom safe area')
  assert.match(css, /min-height:\s*min\(620px, 80dvh\)/, 'the workspace floor must not exceed the viewport')
})

test('info tips are buttons and destructive forms use the shared dialog', () => {
  const pages = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
  assert.match(pages, /class="info-tip"[^>]*aria-expanded="false"/, 'an info tip must be a real button with an expanded state')
  assert.doesNotMatch(pages, /<span class="info-tip"/, 'the old focus-only span must be gone')
  const html = render('/dashboard')
  assert.match(html, /<dialog id="confirm-dialog" class="confirm-dialog"/, 'the layout must render the shared confirmation dialog')
  assert.match(html, /data-confirm-message/, 'the dialog must have a message slot')
  const script = jsText()
  assert.match(script, /querySelectorAll\(['"]\.info-tip['"]\)/, 'the script must wire the info tips')
  assert.match(script, /showModal/, 'the script must open the native dialog')
  assert.match(script, /data-confirm-message/, 'the script must fill the dialog message')
})

test('a tooltip is revealed by its own expanded state once the script runs, and by CSS alone without it', () => {
  const css = cssText().replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim(),
    body: match[2] ?? '',
  }))
  const parts = rules.flatMap((rule) => rule.selector.split(',').map((part) => ({ selector: part.trim(), body: rule.body })))
  // Without the script the hint has no state to toggle, so hover and focus must
  // still reveal it — but only then. An unconditional `:hover`/`:focus` reveal
  // outranks the script, so a dismissed tooltip stays on screen while the point
  // rests on the control or the button keeps focus (WCAG 1.4.13 d).
  const hoverOrFocus = parts.filter((part) => /\.info-tip:(hover|focus)::after/.test(part.selector))
  assert.ok(hoverOrFocus.length > 0, 'the hover/focus reveal must stay in the sheet as the no-JavaScript fallback')
  for (const part of hoverOrFocus) {
    assert.match(part.selector, /^html:not\(\[data-js\]\) /, `a hover/focus reveal outside the fallback keeps a dismissed tooltip on screen: ${part.selector}`)
  }
  // Once the script runs, the explicit state is the only thing that reveals it.
  const state = parts.find((part) => part.selector === '.info-tip[aria-expanded="true"]::after')
  assert.ok(state !== undefined, 'the explicit expanded state must have its own reveal rule')
  assert.match(state?.body ?? '', /display:\s*block/, 'the state rule must set display, not only opacity')
  assert.match(state?.body ?? '', /opacity:\s*1/, 'the state rule must set opacity')
  assert.match(jsText(), /dataset\.js\s*=\s*['"]1['"]/, 'the script must mark that it runs, or the fallback never hands the tooltip over to the state')
})
