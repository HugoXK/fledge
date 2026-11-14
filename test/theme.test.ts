// #657: the console has a light palette but no chooser. The page hardcoded
// `<meta name="color-scheme" content="dark">`, the sticky header painted a dark
// literal, and no document ever carried `data-theme`, so the
// `:root[data-theme="light"]` block was unreachable. The preference is request
// state like the language and the density: a cookie the server reads while it
// renders, so a client-side flip cannot paint the dark page first.
//
// Everything here is read from what the server sends or from the real
// stylesheet, never from a literal that would survive a deleted rule.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'
import { conditionHolds, parseRules } from './cssRules.js'

const CSS = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const DOC = readFileSync(new URL('../docs/ui.md', import.meta.url), 'utf8')
const rules = parseRules(CSS)

function tokenFrom(selector: string, media: string | null, token: string): string {
  for (const rule of rules) {
    if (rule.media !== media) continue
    if (!rule.selectors.includes(selector)) continue
    const found = rule.declarations.find((entry) => entry.property === token)
    if (found !== undefined) return found.value
  }
  assert.fail(`${selector} does not declare ${token}`)
}

const DARK_BG = tokenFrom(':root', null, '--bg')
const LIGHT_BG = tokenFrom(':root[data-theme="light"]', null, '--bg')

function metas(html: string): Array<Record<string, string>> {
  const found: Array<Record<string, string>> = []
  for (const tag of html.match(/<meta [^>]*>/g) ?? []) {
    const attributes: Record<string, string> = {}
    for (const match of tag.matchAll(/([a-z-]+)="([^"]*)"/g)) attributes[match[1] ?? ''] = match[2] ?? ''
    if (attributes.name === 'color-scheme' || attributes.name === 'theme-color') found.push(attributes)
  }
  return found
}

async function documentWith(cookie: string | null, url = '/dashboard'): Promise<string> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'theme-owner', status: 'approved' })
    const session = sessionFor(built, user)
    const headers: Record<string, string> = { cookie: cookie === null ? session.cookie : `${session.cookie}; ${cookie}` }
    const response = await built.app.inject({ method: 'GET', url, headers })
    assert.equal(response.statusCode, 200, `${url} should render for an approved owner`)
    return response.body
  } finally {
    await built.close()
  }
}

test('#657: /theme/:mode saves the choice, refuses an unknown mode and an off-site next', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    for (const mode of ['system', 'light', 'dark']) {
      const response = await built.app.inject({ method: 'GET', url: `/theme/${mode}?next=/dashboard` })
      assert.equal(response.statusCode, 302, `/theme/${mode} must redirect back to the page it was chosen on`)
      assert.equal(response.headers.location, '/dashboard')
      assert.match(String(response.headers['set-cookie']), new RegExp(`fledge_theme=${mode}`), `${mode} must be saved in the cookie the render reads`)
      // The preference is read while rendering, so the cookie must not be script-readable.
      assert.match(String(response.headers['set-cookie']), /HttpOnly/i)
    }

    const unknown = await built.app.inject({ method: 'GET', url: '/theme/sepia?next=/dashboard' })
    assert.equal(unknown.statusCode, 404, 'an unknown theme is refused, never silently treated as the default')

    const offsite = await built.app.inject({ method: 'GET', url: '/theme/light?next=https%3A%2F%2Fevil.example%2Fsteal' })
    assert.equal(offsite.statusCode, 302)
    assert.equal(offsite.headers.location, '/', 'next goes through the same same-origin contract as /lang and /density')
  } finally {
    await built.close()
  }
})

test('#657: nothing saved renders the system preference as two media-scoped theme-color metas', () => {
  return documentWith(null).then((html) => {
    assert.match(html, /<html[^>]*data-theme="system"/, 'an inherited preference must be on the document, so the stylesheet can tell three choices from two')
    const tags = metas(html)
    const scheme = tags.filter((tag) => tag.name === 'color-scheme')
    assert.deepEqual(scheme.map((tag) => tag.content), ['light dark'], 'system keeps both schemes: the OS has not been overridden')
    const colours = tags.filter((tag) => tag.name === 'theme-color')
    assert.equal(colours.length, 2, 'system needs one theme-color per scheme, not one resolved value')
    assert.deepEqual(
      colours.map((tag) => [tag.media, tag.content]).sort(),
      [['(prefers-color-scheme: dark)', DARK_BG], ['(prefers-color-scheme: light)', LIGHT_BG]].sort(),
      'each system theme-color must match the palette background it announces',
    )
  })
})

test('#657: an explicit choice pins data-theme, color-scheme and one theme-color', async () => {
  const light = await documentWith('fledge_theme=light')
  assert.match(light, /<html[^>]*data-theme="light"/, 'the chosen theme must be on the document, not only in a class the client adds later')
  const lightTags = metas(light)
  assert.deepEqual(lightTags.filter((tag) => tag.name === 'color-scheme').map((tag) => tag.content), ['light'])
  assert.deepEqual(lightTags.filter((tag) => tag.name === 'theme-color').map((tag) => tag.content), [LIGHT_BG], 'a pinned scheme announces one colour')

  const dark = await documentWith('fledge_theme=dark')
  assert.match(dark, /<html[^>]*data-theme="dark"/)
  const darkTags = metas(dark)
  assert.deepEqual(darkTags.filter((tag) => tag.name === 'color-scheme').map((tag) => tag.content), ['dark'])
  assert.deepEqual(darkTags.filter((tag) => tag.name === 'theme-color').map((tag) => tag.content), [DARK_BG])

  const unknown = await documentWith('fledge_theme=sepia')
  assert.match(unknown, /<html[^>]*data-theme="system"/, 'an unknown stored value falls back to the system preference')
})

test('#657: theme and density are two independent preferences on one document', async () => {
  const html = await documentWith('fledge_theme=light; fledge_density=compact')
  assert.match(html, /<html[^>]*data-theme="light"/, 'the theme rewrite must not drop the density attribute')
  assert.match(html, /<html[^>]*data-density="compact"/, 'the density rewrite must not drop the theme attribute')
  assert.match(html, /<meta name="color-scheme" content="light" \/>/, 'the pinned scheme survives alongside a saved density')
})

test('#657: the header carries three 44px choices, marks the chosen one and is bilingual', async () => {
  for (const [locale, labels] of [['zh', ['自动', '浅色', '深色']], ['en', ['Auto', 'Light', 'Dark']]] as const) {
    const html = await documentWith(`fledge_theme=dark; fledge_lang=${locale}`)
    const group = /<div class="theme"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
    assert.notEqual(group, '', `${locale}: the header must render a theme group`)
    for (const mode of ['system', 'light', 'dark']) {
      assert.match(group, new RegExp(`href="/theme/${mode}\\?next=`), `${locale}: ${mode} is one link away, with no JavaScript`)
    }
    for (const label of labels) assert.ok(group.includes(label), `${locale}: the choices must be labelled ${labels.join('/')}`)
    const current = [...group.matchAll(/data-theme-btn="([^"]+)" aria-current="true"/g)].map((match) => match[1])
    assert.deepEqual(current, ['dark'], `${locale}: exactly the saved choice is marked current`)
    // It rides inside the navigation panel, so the phone row gains no child and
    // cannot overflow at 360px.
    const nav = /<nav class="nav" id="main-nav"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? ''
    assert.ok(nav.includes('class="theme"'), `${locale}: the chooser must live inside #main-nav so the compact panel carries it`)
  }
})

test('#657: the header and the account pill paint palette tokens, not dark literals', () => {
  const top = rules.find((rule) => rule.selectors.includes('.top') && rule.media === null)
  assert.ok(top !== undefined, '.top is missing from the stylesheet')
  const background = top.declarations.find((entry) => entry.property === 'background')?.value ?? ''
  assert.match(background, /var\(--header-bg\)/, `the sticky header must paint a palette token, got ${background}`)

  const account = rules.find((rule) => rule.selectors.includes('.account') && rule.media === null)
  assert.ok(account !== undefined, '.account is missing from the stylesheet')
  const chip = account.declarations.find((entry) => entry.property === 'background')?.value ?? ''
  assert.match(chip, /var\(--chip-bg\)/, `the account pill must paint a palette token, got ${chip}`)

  for (const [label, selector, media] of [
    ['dark', ':root', null],
    ['light media', ':root:not([data-theme="dark"])', '(prefers-color-scheme: light)'],
    ['light attribute', ':root[data-theme="light"]', null],
  ] as const) {
    for (const token of ['--header-bg', '--chip-bg']) {
      const value = tokenFrom(selector, media, token)
      assert.match(value, /^rgba\(/, `${token} in ${label} must stay translucent, got ${value}`)
      assert.equal(value, tokenFrom(selector, media, token), `${token} in ${label} must be declared once`)
    }
  }
})

test('#657: each choice keeps the 44px touch floor and the compact panel keeps the row intact', () => {
  const theme = rules.filter((rule) => rule.selectors.some((selector) => selector.startsWith('.theme')))
  assert.ok(theme.length > 0, 'no .theme rule at all')
  const link = theme.find((rule) => rule.selectors.includes('.theme a'))
  assert.ok(link !== undefined, '.theme a is missing')
  for (const property of ['min-width', 'min-height']) {
    assert.equal(
      link.declarations.find((entry) => entry.property === property)?.value,
      'var(--touch)',
      `.theme a must keep the ${property} touch floor`,
    )
  }
  // The selected state has to be visible without colour alone: the current
  // choice carries a border and a weight change as well.
  const current = theme.find((rule) => rule.selectors.some((selector) => selector.includes('aria-current="true"')))
  assert.ok(current !== undefined, 'the selected theme must have a visible rule of its own')
  const visible = current.declarations.map((entry) => entry.property)
  assert.ok(visible.includes('background') || visible.includes('color'), 'the selected state must paint something')

  // The control must not add a child to the phone row: the panel it rides in is
  // hidden until the toggle opens it, so 360px keeps the #133 fixed row.
  const panel = rules.find((rule) => rule.selectors.includes('.top .nav') && rule.media === '(max-width: 960px)')
  assert.ok(panel !== undefined, 'the compact nav panel rule is missing')
  assert.equal(conditionHolds('(max-width: 960px)', 360), true)
  assert.equal(panel.declarations.find((entry) => entry.property === 'display')?.value, 'none', 'the panel stays collapsed until the toggle opens it')
  const themeRules = theme.filter((rule) => rule.media !== null && conditionHolds(rule.media, 360))
  for (const rule of themeRules) {
    assert.doesNotMatch(
      rule.selectors.join(' '),
      /\.top-inner/,
      'the theme control must not become a row child at 360px',
    )
  }
})

test('#657: docs/ui.md names the two palette tokens and the three-way preference', () => {
  for (const token of ['--header-bg', '--chip-bg']) assert.ok(DOC.includes(token), `docs/ui.md must document ${token}`)
  assert.match(DOC, /fledge_theme/, 'docs/ui.md must name the cookie the render reads')
  for (const mode of ['system', 'light', 'dark']) assert.match(DOC, new RegExp(`\\b${mode}\\b`), `docs/ui.md must name the ${mode} choice`)
})
