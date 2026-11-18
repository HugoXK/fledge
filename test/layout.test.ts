import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { layout } from '../src/views/layout.js'
import { dashboardPage, settingsPage } from '../src/views/pages.js'
import type { SetupState } from '../src/views/checklist.js'
import { declarationsFor, lastValue, parseRules } from './cssRules.js'
import { makeUser, testConfig } from './helpers.js'

const cssText = (): string => readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const jsText = (): string => readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

// Measured with the render method recorded in the fixture; node:test has no layout engine.
const headerHeights = JSON.parse(readFileSync(new URL('./fixtures/header-heights.json', import.meta.url), 'utf8')) as {
  headroom: number
  renders: { breakpoint: string; media: string | null; viewport: string; measured: number }[]
}

function render(path: string, options: { admin?: boolean; active?: string; locale?: 'zh' | 'en' } = {}): string {
  const store = new Store(':memory:')
  const user = makeUser(store, { admin: options.admin === true })
  return layout({ title: 'x', viewer: { user, csrfToken: 'csrf-token' }, body: '', config: testConfig(), locale: options.locale ?? 'en', path, active: options.active })
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
  // #700: the URL carries a content version now, so the pin is the path prefix.
  assert.match(html, /<script src="\/assets\/app\.js\?v=[0-9a-f]{8,}" defer><\/script>/, 'the layout must load the updater it depends on')
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

// #451: the safe area is a computed relationship, not a declaration anyone can
// leave behind. These three tests read the sheet the way a browser applies it —
// every matching declaration at a width, in order, the last one winning — so a
// same-specificity shorthand that drops the inset is red, and so is a value
// whose base already swallows every real inset.
type PaddingBox = { top: string; right: string; bottom: string; left: string }

// `max(72px, env(…))` keeps its spaces inside the parentheses, so a shorthand
// splits on whitespace only at depth zero.
function paddingParts(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const character of value) {
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth === 0 && /\s/.test(character)) {
      if (current !== '') parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current !== '') parts.push(current)
  return parts
}

function paddingAt(rules: ReturnType<typeof parseRules>, selector: string, width: number): PaddingBox {
  const padding: PaddingBox = { top: '0', right: '0', bottom: '0', left: '0' }
  for (const declaration of declarationsFor(rules, selector, width)) {
    if (declaration.property === 'padding') {
      const parts = paddingParts(declaration.value)
      const [top = '0', right = top, bottom = top, left = right] = parts
      Object.assign(padding, { top, right, bottom, left })
    } else if (declaration.property === 'padding-bottom') padding.bottom = declaration.value
    else if (declaration.property === 'padding-left') padding.left = declaration.value
    else if (declaration.property === 'padding-right') padding.right = declaration.value
  }
  return padding
}

// What a browser renders once it substitutes the inset. The fix is additive —
// `calc(<base> + env(…))` — because a real home indicator (34px) or a notch
// (44-59px) sits below the 72-80px page rhythm, so `max()` either keeps the
// base or drops the inset (#451). `additive` records the form, so the max()
// version is red even though it mentions the inset.
type InsetResult =
  | { kind: 'px'; value: number; additive: boolean }
  | { kind: 'base'; base: string; additive: boolean }
  | { kind: 'none'; additive: false }

function renderPadding(value: string, side: 'bottom' | 'left' | 'right', inset: number): InsetResult {
  const env = `env\\(\\s*safe-area-inset-${side}\\s*\\)`
  const additive = new RegExp(`^calc\\(\\s*(.+?)\\s*\\+\\s*${env}\\s*\\)$`).exec(value)
  const capped = new RegExp(`^max\\(\\s*(.+?)\\s*,\\s*${env}\\s*\\)$`).exec(value)
  const literal = /^(\d+(?:\.\d+)?)px$/.exec(value.trim())
  const base = additive?.[1] ?? capped?.[1] ?? literal?.[1]
  if (base === undefined) return { kind: 'none', additive: false }
  const numeric = /^(\d+(?:\.\d+)?)px$/.exec(base.trim())
  if (numeric === null) return { kind: 'base', base: base.trim(), additive: additive !== null }
  const number = Number(numeric[1])
  const rendered = additive !== null ? number + inset : capped !== null ? Math.max(number, inset) : number
  return { kind: 'px', value: rendered, additive: additive !== null }
}

const DYNAMIC_VIEWPORT = /(?:dvh|svh|lvh)\b/
// The page frame, the header row and the footer; `.top .nav` is the header's
// full-bleed panel, which spans the viewport at both compact bands.
const FRAME_RULES = ['.wrap', '.top-inner', '.foot', '.top .nav']

test('the page frame keeps the bottom safe area at every width, not only in one band', () => {
  const rules = parseRules(cssText(), 'modern')
  // Both sides of every boundary in the sheet, plus the card's own widths.
  for (const width of [1400, 1200, 961, 960, 900, 768, 641, 640, 390, 360]) {
    const bottom = paddingAt(rules, '.wrap', width).bottom
    assert.match(
      bottom,
      /env\(\s*safe-area-inset-bottom\s*\)/,
      `at ${String(width)}px the winning .wrap padding-bottom is \`${bottom}\`: a same-specificity shorthand replaced the inset, which is the #451 defect`,
    )
    const expectedBase = width > 960 ? 80 : 72
    const withoutInset = renderPadding(bottom, 'bottom', 0)
    assert.equal(
      withoutInset.kind === 'px' ? withoutInset.value : null,
      expectedBase,
      `at ${String(width)}px \`${bottom}\` must still render the ${String(expectedBase)}px rhythm when the device reports no inset`,
    )
    const indicator = renderPadding(bottom, 'bottom', 34)
    assert.ok(
      indicator.kind === 'px' && indicator.additive,
      `at ${String(width)}px \`${bottom}\` must add the inset to the page rhythm; a max() or a plain px keeps the base, so a real 34px home indicator changes nothing`,
    )
    assert.equal(
      indicator.kind === 'px' ? indicator.value : null,
      expectedBase + 34,
      `at ${String(width)}px \`${bottom}\` must render ${String(expectedBase + 34)}px for a 34px home indicator instead of treating the inset as a cap`,
    )
  }
})

test('every dynamic-viewport declaration keeps a static fallback before it', () => {
  const rules = parseRules(cssText(), 'modern')
  let checked = 0
  for (const rule of rules) {
    rule.declarations.forEach((declaration, index) => {
      if (!/^(?:min-)?height$/.test(declaration.property)) return
      if (!DYNAMIC_VIEWPORT.test(declaration.value)) return
      checked += 1
      const earlier = rule.declarations.slice(0, index)
      assert.ok(
        earlier.some((fallback) => fallback.property === declaration.property && !DYNAMIC_VIEWPORT.test(fallback.value)),
        `${rule.selectors.join(', ')}: \`${declaration.property}: ${declaration.value}\` has no earlier fallback for a browser that does not parse the dynamic units`,
      )
    })
  }
  assert.ok(checked >= 4, `the sheet must keep its dynamic-viewport declarations; found ${String(checked)}`)
  assert.equal(lastValue(rules, '.wrap', 'min-height', 1400), 'calc(100dvh - 220px)', 'the page must still follow the dynamic viewport')
  assert.equal(lastValue(rules, '.workspace-frame', 'height', 1400), 'calc(100dvh - var(--header-h))', 'the workspace frame must still follow the dynamic viewport')
  assert.equal(lastValue(rules, '.workspace-frame', 'min-height', 1400), 'min(620px, 80dvh)', 'the workspace floor must not exceed the viewport')
})

test('viewport-fit=cover carries the notch side insets on every full-bleed frame rule', () => {
  const html = render('/dashboard')
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*"/, 'this guard assumes the layout still opts into the notch')
  const rules = parseRules(cssText(), 'modern')
  for (const selector of FRAME_RULES) {
    const blocks = rules.filter((rule) => rule.selectors.includes(selector))
    assert.ok(blocks.length > 0, `${selector} must have a rule to check`)
    let horizontal = 0
    for (const block of blocks) {
      let left = '0'
      let right = '0'
      for (const declaration of block.declarations) {
        if (declaration.property === 'padding') {
          const parts = paddingParts(declaration.value)
          const [top = '0', rightValue = top, bottom = top, leftValue = rightValue] = parts
          void bottom
          right = rightValue
          left = leftValue
        } else if (declaration.property === 'padding-left') left = declaration.value
        else if (declaration.property === 'padding-right') right = declaration.value
      }
      if (left === '0' && right === '0') continue
      horizontal += 1
      const where = block.media === null ? 'at every width' : `under ${block.media}`
      for (const [side, value] of [
        ['right', right],
        ['left', left],
      ] as const) {
        const rendered = renderPadding(value, side, 44)
        assert.ok(
          rendered.additive,
          `${selector} ${where} sets a ${side} padding of \`${value}\`: under viewport-fit=cover it must add env(safe-area-inset-${side}) to the page padding, not cap it with max()`,
        )
        if (rendered.kind === 'px') {
          const base = renderPadding(value, side, 0)
          assert.ok(
            base.kind === 'px' && rendered.value === base.value + 44,
            `${selector} ${where} \`${value}\` must grow by the 44px a notched landscape phone reserves instead of staying at its base`,
          )
        } else {
          assert.match(rendered.base, /var\(--page-pad\)/, `${selector} ${where} \`${value}\` must add the inset to --page-pad`)
        }
      }
    }
    assert.ok(horizontal > 0, `${selector} must set a horizontal padding this guard can check`)
  }
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

// #414: `aria-pressed` is defined for `role="button"`, so on the language links
// assistive technology either ignores it or announces a toggle the link cannot
// honour — `aria-allowed-attr` in axe. The active language is already carried by
// `aria-current="true"`; the highlight has to be keyed on that state instead.
test('the language switch announces the active language with aria-current, not aria-pressed', () => {
  const zh = render('/dashboard', { locale: 'zh' })
  assert.doesNotMatch(zh, /<a[^>]*aria-pressed/, 'aria-pressed is a button state; a link must not claim it')
  assert.match(zh, /<a href="\/lang\/zh\?next=%2Fdashboard"[^>]*aria-current="true"/, 'the active language must still be announced')

  const en = render('/dashboard')
  assert.doesNotMatch(en, /<a[^>]*aria-pressed/, 'the inactive link must not claim the button state either')
  assert.match(en, /<a href="\/lang\/en\?next=%2Fdashboard"[^>]*aria-current="true"/, 'the active language must still be announced')

  // The highlight is the only mark of the current language in the stylesheet, so
  // dropping the attribute without moving the selector would silently lose it.
  const rules = parseRules(cssText(), 'modern')
  const current = declarationsFor(rules, '.lang a[aria-current="true"]', 1280)
  const background = current.find((declaration) => declaration.property === 'background')
  const color = current.find((declaration) => declaration.property === 'color')
  assert.ok(background !== undefined, '.lang a[aria-current="true"] must carry the highlight background')
  assert.ok(color !== undefined, '.lang a[aria-current="true"] must carry the accent colour')
  assert.equal(lastValue(rules, '.lang a[aria-pressed="true"]', 'background', 1280), null, 'no rule may keep keying the highlight on the button state')
})

// #867: a control whose whole visible content is one typed glyph — `×` on the
// two close buttons, `!` on an info tip, `✓` on a finished setup step — is drawn
// in whatever face the platform picks, so the same button is a different weight
// and baseline on macOS and Windows, and a Chinese reader sees Latin punctuation
// inside a Chinese sentence. The rule is about controls, not prose: the `×` in a
// review count and the `→` in `Settings → Model` are copy and stay (#871).
const CONTROL_GLYPHS = ['×', '✕', '✓', '★', '!', '•', '⚠']

interface RenderedControl {
  tag: string
  attrs: string
  inner: string
}

function renderedControls(html: string): RenderedControl[] {
  return [...html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((match) => ({
    tag: match[1] ?? '',
    attrs: match[2] ?? '',
    inner: match[3] ?? '',
  }))
}

// What the control shows once tags are stripped: an SVG contributes no text.
function controlText(inner: string): string {
  return inner
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, '')
}

function iconAttributes(inner: string): void {
  assert.match(inner, /^<svg [^>]*viewBox="0 0 24 24"/, 'an icon must be an inline SVG on the shared 24px grid')
  assert.match(inner, /aria-hidden="true"/, 'an icon is decorative; the words that name the control stay in aria-label')
  assert.match(inner, /focusable="false"/, 'an SVG must not become a tab stop in Internet Explorer')
  assert.match(inner, /stroke="currentColor"/, 'an icon inherits its colour; it must not add a literal')
  assert.doesNotMatch(inner, /(?:fill|stroke)="#/, 'no colour literal may reach the markup')
}

test('no control is a typed glyph, and every drawn icon keeps its label', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'glyph-867', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf-token' }
    const settings = settingsPage({ config, locale: 'en', viewer, tokens: [], sessions: [], currentSessionHash: '', providers: [] })
    const setup: SetupState = {
      repos: 0,
      roleChosen: true,
      providerConfigured: false,
      modelConfigured: false,
      // Platform quota on, own model missing, balance under the comfort figure:
      // that is the branch whose advice carries the `Settings → Model` copy the
      // prose assertion below pins.
      platformAvailable: true,
      platformQuotaRemainingCny: 10,
      platformQuotaUnlimited: false,
      platformQuotaComfortCny: 50,
      instanceReady: false,
      jobs: 0,
      firstJobStatus: null,
      firstPrUrl: null,
      repoHref: null,
    }
    const dashboard = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [], setup })
    // A banner is the only way the dismiss button is on screen, and it is one of
    // the four sites this card replaces.
    const shell = layout({ title: 'x', viewer, body: '', config, locale: 'en', path: '/dashboard', active: 'dashboard', notifications: [{ level: 'error', text: 'a banner the reader can dismiss' }] })
    const rendered: Array<[string, string]> = [['/settings', settings], ['/dashboard', dashboard], ['the shell', shell]]

    for (const [name, html] of rendered) {
      const controls = renderedControls(html)
      assert.ok(controls.length > 0, `the ${name} page rendered no control to check`)
      for (const control of controls) {
        const text = controlText(control.inner)
        assert.ok(
          !CONTROL_GLYPHS.includes(text),
          `the ${name} page's <${control.tag}>${control.attrs.slice(0, 40)} is the bare glyph ${JSON.stringify(text)}; a control must draw its mark as SVG`,
        )
        if (text === '' && control.inner.includes('<svg')) {
          assert.match(control.attrs, /aria-label="[^"]+"|title="[^"]+"/, `the ${name} page's icon-only <${control.tag}> has no aria-label or title`)
        }
      }
    }

    // The three content sites draw their mark: banner dismiss, info tip, and the
    // finished step of the checklist. The dialog close shares the banner's icon.
    const dismiss = [...shell.matchAll(/<button[^>]*class="banner-dismiss"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1] ?? '')
    assert.ok(dismiss.length > 0, 'the shell rendered no dismissible banner')
    for (const inner of dismiss) iconAttributes(inner)

    const tips = [...settings.matchAll(/<button[^>]*class="info-tip"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1] ?? '')
    assert.ok(tips.length > 0, 'the settings page rendered no info tip')
    for (const inner of tips) iconAttributes(inner)
    assert.match(settings, /class="info-tip"[^>]*aria-expanded="false"/, 'the info tip keeps its expanded state')

    // A finished step draws a check and no longer types one; a pending step still
    // shows its number, because the number is the order, not a mark.
    const done = [...dashboard.matchAll(/<li class="setup-step is-done[^"]*"[\s\S]*?<span class="setup-mark"[^>]*>([\s\S]*?)<\/span>/g)].map((match) => match[1] ?? '')
    assert.ok(done.length > 0, 'the dashboard rendered no finished setup step')
    for (const inner of done) {
      iconAttributes(inner)
      assert.doesNotMatch(inner, /✓/, 'a finished step must draw its check, not type one')
    }
    const pending = [...dashboard.matchAll(/<li class="setup-step(?! is-done)[^"]*"[\s\S]*?<span class="setup-mark"[^>]*>([\s\S]*?)<\/span>/g)].map((match) => match[1] ?? '')
    assert.ok(pending.some((inner) => /^\d+$/.test(inner)), 'a pending step still shows its index')

    // Prose is copy, not an icon: the breadcrumb arrow in the setup advice stays,
    // and the multiplication sign still builds a review count. A test that forbade
    // every glyph character would force the copy change this card does not own
    // (#871), so the rule is about controls, not about characters in sentences.
    assert.match(dashboard, /Settings → Model/, 'the breadcrumb arrow in the setup advice is copy and must stay')
    assert.match(readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8'), /×\$\{model\.reviews\}/, 'the multiplication sign still builds a review count')
  } finally {
    store.close()
  }
})
