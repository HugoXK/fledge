import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { repoPage } from '../src/views/pages.js'
import { WORK_ITEM_STATES, workItemStateLabel } from '../src/lib/workItems.js'
import type { Translate } from '../src/i18n.js'
import { makeUser, testConfig } from './helpers.js'

// #136: above 640px the tables go back to being tables, and a wide one — the
// delivery board at /repos/:id measures 952px in a 686px window at 768 — sits
// in a `.table-scroll` whose only cue is an 8px thumb in `--line-strong` on
// `--panel`. That pair is 1.5:1, below the 3:1 non-text floor, the track is
// unset, and nothing is declared for Firefox, so a column that is off-screen
// looks like a column that does not exist.
//
// The issue's D2 fixes the shape: either an always-present classic scrollbar
// (Form A) or an always-present edge cue (Form B). This PR picks Form A, so the
// pins below read the stylesheet: the track must be a real token at >= 3:1
// against `--panel`, the thumb >= 3:1 against the track, and both the WebKit
// pseudo-elements and the standard `scrollbar-width`/`scrollbar-color` pair
// must be declared. They are pins on declarations, not proof of pixels; the
// issue's matrix is the measurement of record for that half.
//
// The band is 641-960 inclusive and nothing outside it may move: 640 still
// belongs to the #116/#130 card layout and 961 is the desktop table.

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

const BAND_WIDTHS = [641, 768, 800, 960]
const OUTSIDE_WIDTHS = [360, 640, 961, 1280]

type Declaration = { property: string; value: string }
type StyleRule = { selectors: string[]; declarations: Declaration[]; media: string | null }

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

function declarationsOf(body: string): Declaration[] {
  const declarations: Declaration[] = []
  for (const part of body.split(';')) {
    const separator = part.indexOf(':')
    if (separator === -1) continue
    const property = part.slice(0, separator).trim().toLowerCase()
    const value = part.slice(separator + 1).trim()
    if (property === '') continue
    declarations.push({ property, value })
  }
  return declarations
}

function parseRules(source: string, media: string | null = null): StyleRule[] {
  const css = stripComments(source)
  const rules: StyleRule[] = []
  let index = 0
  let prelude = ''
  while (index < css.length) {
    const character = css[index] ?? ''
    if (character === '{') {
      let depth = 1
      let end = index + 1
      while (end < css.length && depth > 0) {
        if (css[end] === '{') depth += 1
        else if (css[end] === '}') depth -= 1
        end += 1
      }
      const body = css.slice(index + 1, end - 1)
      const head = prelude.trim()
      if (head.startsWith('@')) {
        const atRule = head.slice(1).trim()
        if (atRule.startsWith('media')) rules.push(...parseRules(body, atRule.slice('media'.length).trim()))
      } else {
        const selectors = head.split(',').map((selector) => selector.trim()).filter((selector) => selector !== '')
        rules.push({ selectors, declarations: declarationsOf(body), media })
      }
      prelude = ''
      index = end
      continue
    }
    if (character === ';') {
      prelude = ''
      index += 1
      continue
    }
    prelude += character
    index += 1
  }
  return rules
}

const rules = parseRules(cssSource)

function conditionHolds(condition: string, width: number): boolean {
  const parts = condition.split(/\s+and\s+/).map((part) => part.trim()).filter((part) => part !== '')
  for (const part of parts) {
    const max = /^\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(part)
    if (max !== null) {
      if (!(width <= Number(max[1]))) return false
      continue
    }
    const min = /^\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/.exec(part)
    if (min !== null) {
      if (!(width >= Number(min[1]))) return false
      continue
    }
    const other = /^\(\s*(min|max)-width\s*:/.test(part)
    if (other) return false
  }
  return true
}

function appliesAt(rule: StyleRule, width: number): boolean {
  return rule.media === null || conditionHolds(rule.media, width)
}

function lastValue(selector: string, property: string, width: number): string | null {
  let value: string | null = null
  for (const rule of rules) {
    if (!appliesAt(rule, width)) continue
    if (!rule.selectors.includes(selector)) continue
    for (const declaration of rule.declarations) {
      if (declaration.property === property) value = declaration.value
    }
  }
  return value
}

function compact(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, ' ').trim().toLowerCase()
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
  const digits = raw.length === 3 ? raw.split('').map((channel) => channel + channel).join('') : raw
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

const tokens = rootTokens(cssSource)

// A declaration must name a token, not a literal: the token block is the only
// place a colour may be written (test/uiTokens.test.ts enforces the other half).
function tokenFor(value: string | null, property: string, width: number): { name: string; hex: string } {
  assert.ok(value !== null, `${property} must be declared at ${String(width)}px`)
  const named = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value.trim())
  assert.ok(named !== null, `${property} must resolve through a token, got "${value}"`)
  const name = named[1] ?? ''
  const hex = tokens.get(name)
  assert.ok(hex !== undefined, `${name} is used but not declared in the :root token block`)
  return { name, hex }
}

test('a scrolled table above 640px carries an always-present classic scrollbar', () => {
  for (const width of BAND_WIDTHS) {
    assert.equal(lastValue('.table-scroll', 'overflow-x', width), 'auto', `at ${String(width)}px the scroller must stay a scroller`)

    // Form A needs the cross-engine pair, not only the WebKit pseudo-element:
    // without these, Firefox paints its platform default and the track vanishes.
    const widthValue = lastValue('.table-scroll', 'scrollbar-width', width)
    assert.ok(
      widthValue === 'thin' || widthValue === 'auto',
      `at ${String(width)}px scrollbar-width must be thin or auto, got ${String(widthValue)}`,
    )

    const track = tokenFor(lastValue('.table-scroll::-webkit-scrollbar-track', 'background', width), '::-webkit-scrollbar-track background', width)
    const thumb = tokenFor(lastValue('.table-scroll::-webkit-scrollbar-thumb', 'background', width), '::-webkit-scrollbar-thumb background', width)

    // The pair has to agree: a standard declaration pointing at a colour the
    // pseudo-elements do not paint is a second, untested scrollbar.
    assert.equal(
      compact(lastValue('.table-scroll', 'scrollbar-color', width)),
      `var(${thumb.name}) var(${track.name})`,
      `at ${String(width)}px scrollbar-color must be "${thumb.name} ${track.name}" (thumb then track)`,
    )

    // Non-text contrast (WCAG 2.1 AA, 1.4.11): the track has to be visible
    // against the panel it sits on, and the thumb has to be visible against the
    // track it moves along. 1.5:1 is the defect this issue reports.
    const trackRatio = contrast(track.hex, tokens.get('--panel') ?? '#000000')
    assert.ok(
      trackRatio >= 3,
      `at ${String(width)}px the ${track.name} track is ${trackRatio.toFixed(2)}:1 against --panel; the floor is 3:1`,
    )
    const thumbRatio = contrast(thumb.hex, track.hex)
    assert.ok(
      thumbRatio >= 3,
      `at ${String(width)}px the ${thumb.name} thumb is ${thumbRatio.toFixed(2)}:1 against the ${track.name} track; the floor is 3:1`,
    )

    // A "track" painted with the page or panel colour is not a track.
    assert.notEqual(track.hex.toLowerCase(), (tokens.get('--bg') ?? '').toLowerCase(), 'the track may not be --bg')
    assert.notEqual(track.hex.toLowerCase(), (tokens.get('--panel') ?? '').toLowerCase(), 'the track may not be --panel')
  }
})

test('the scrollbar affordance lives in the 641-960 band and nowhere else', () => {
  for (const width of OUTSIDE_WIDTHS) {
    assert.equal(lastValue('.table-scroll', 'scrollbar-color', width), null, `scrollbar-color must not apply at ${String(width)}px`)
    assert.equal(lastValue('.table-scroll', 'scrollbar-width', width), null, `scrollbar-width must not apply at ${String(width)}px`)
    assert.equal(lastValue('.table-scroll::-webkit-scrollbar-track', 'background', width), null, `the track must not apply at ${String(width)}px`)
    // 640 keeps #116/#130's card layout and 961+ keeps the desktop table, whose
    // thumb stays the shipped --line-strong.
    assert.equal(compact(lastValue('.table-scroll::-webkit-scrollbar-thumb', 'background', width)), 'var(--line-strong)', `the desktop thumb must stay --line-strong at ${String(width)}px`)
  }
})

test('the delivery board keeps every state filter reachable at every band width', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'board-band', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_band', userId: user.id, owner: 'o', name: 'band', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    for (const locale of ['en', 'zh'] as const) {
      const page = repoPage({
        config,
        locale,
        viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
        repo,
        jobs: [],
        workItems: [],
      })
      const board = /<section class="card" id="board">([\s\S]*?)<\/section>/.exec(page)
      assert.ok(board !== null, `${locale} page must keep the #board section`)
      const markup = board[1] ?? ''
      // The board's header row is the only filter for the list below it: every
      // state must still be a link, and the row must still be a table row, at
      // every width — the CSS change may not remove one to make the table fit.
      const links = [...markup.matchAll(/<a class="link" href="\/repos\/[^"]*\?workState=([a-z_]+)#work">/g)].map((match) => match[1])
      assert.deepEqual(links, [...WORK_ITEM_STATES], `${locale} board must keep one filter link per state, in order`)
      assert.equal((markup.match(/<th>/g) ?? []).length, WORK_ITEM_STATES.length, `${locale} board must keep one th per state`)
      assert.match(markup, /class="table-scroll"/, 'the board stays inside the scroller the affordance is attached to')
      const t: Translate = (zh, en) => (locale === 'zh' ? zh : en)
      for (const state of WORK_ITEM_STATES) {
        assert.ok(
          markup.includes(`>${workItemStateLabel(t, state)}</a>`),
          `${locale} board must link the ${state} column with its translated label`,
        )
      }
    }
  } finally {
    store.close()
  }
})
