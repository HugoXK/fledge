import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { dashboardPage, searchPage } from '../src/views/pages.js'
import { renderState, type StateKind } from '../src/views/states.js'
import { makeUser, testConfig } from './helpers.js'

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const pages = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
const questions = readFileSync(new URL('../public/questions.js', import.meta.url), 'utf8')
const chief = readFileSync(new URL('../public/chief.js', import.meta.url), 'utf8')

function rule(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'i').exec(css)
  return match === null ? null : (match[1] ?? null)
}

// 1. Five states, one renderer, one aria contract each.
test('renderState emits data-state and the matching aria contract for all five states', () => {
  const cases = [
    { kind: 'loading' as const, expect: /aria-busy="true"/, role: /role="status"/ },
    { kind: 'empty' as const, expect: /data-state="empty"/, role: /role="status"/ },
    { kind: 'error' as const, expect: /data-state="error"/, role: /role="alert"/ },
    { kind: 'success' as const, expect: /data-state="success"/, role: /role="status"/ },
    { kind: 'disabled' as const, expect: /aria-disabled="true"/, role: /data-state="disabled"/ },
  ]
  for (const entry of cases) {
    const html = renderState({ kind: entry.kind, title: 'T', body: 'B', action: { href: '/x', label: 'Next' } })
    assert.match(html, new RegExp(`data-state="${entry.kind}"`), `${entry.kind} needs data-state`)
    assert.match(html, entry.expect, `${entry.kind} needs its aria marker`)
    assert.match(html, entry.role, `${entry.kind} needs its role`)
    assert.match(html, /class="btn btn-small" href="\/x"/, `${entry.kind} must carry the next action`)
  }
  const loading = renderState({ kind: 'loading', title: 'T', skeletonLines: 2 })
  assert.match(loading, /class="skeleton/, 'a loading state needs skeleton placeholders')
})

// 2. The six list renderers the issue names must go through the shared cell.
test('the named list empty states all render through the shared state cell', () => {
  const cells = pages.match(/stateCell\(/g) ?? []
  assert.ok(cells.length >= 6, `expected at least 6 stateCell sites, found ${cells.length}`)
  const emptyKinds = pages.match(/stateCell\(\d+, \{ kind: 'empty'/g) ?? []
  assert.ok(emptyKinds.length >= 6, `expected the six empty states, found ${emptyKinds.length}`)
  const leftovers = pages.match(/<tr><td colspan="\d+" class="muted">/g) ?? []
  assert.ok(leftovers.length <= 4, `only the admin/metrics tables may keep a plain row, found ${leftovers.length}`)
})

// 3. A failed data read is an error state with a retry, not only a banner.
test('a failed team read renders an error state with a retry action', () => {
  assert.match(pages, /kind: 'error'/, 'pages.ts needs an error state')
  assert.match(pages, /label: t\('重试', 'Try again'\)/, 'the error state needs a retry action')
})

// 4. The states are styled, and a busy region says so to the cursor and to CSS.
test('the state classes and the skeleton exist in the stylesheet', () => {
  const missing = ['.state', '.state-loading', '.state-empty', '.state-error', '.state-success', '.state-disabled', '.skeleton', '[aria-busy="true"]']
    .filter((selector) => rule(selector) === null)
  assert.deepEqual(missing, [], `missing state styles: ${missing.join(', ')}`)
})

// 5. A control that cannot act must look inert wherever it is, not only as a button.
test('a disabled link and an aria-disabled control share the inert style', () => {
  assert.ok(rule('.link[aria-disabled="true"]') !== null, 'missing .link[aria-disabled] style')
  assert.match(css, /a\[aria-disabled="true"\]/, 'anchors need the same disabled style')
  assert.match(pages, /aria-disabled/, 'pager controls must expose aria-disabled')
})

// 6. Every stream reports connecting, lost and recovered instead of silently stopping.
test('the three streams announce their connection state', () => {
  assert.match(pages, /data-inbox-status/, 'the inbox needs a live status node')
  assert.match(pages, /aria-live="polite"/, 'a stream status node must be a live region')
  assert.match(questions, /addEventListener\('error'/, 'questions.js must handle a broken stream')
  assert.match(chief, /addEventListener\('error'/, 'chief.js must handle a broken stream')
  assert.match(chief, /data-chief-status/, 'chief.js must write its status into the live node')
})

// 7. The rendered dashboard, with no data at all, still explains itself.
test('an empty dashboard renders an empty state rather than a blank region', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'empty-ui', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const html = dashboardPage({ config, locale: 'en', viewer, repos: [], jobs: [], notifications: [] })
    assert.match(html, /data-state="empty"/, 'an empty dashboard needs an empty state')
    assert.match(html, /No repositories yet\./, 'the empty state needs a sentence')
    assert.match(html, /no job starts|before any job/i, 'the empty state needs the next step')
  } finally {
    store.close()
  }
})

// 8. The state icon is one inline SVG per state from a literal map, so the five
// states share a geometry instead of borrowing five glyphs from whatever font the
// platform picked for U+0030, U+0021, U+2713 and U+2013.
function iconOf(kind: StateKind): string {
  const html = renderState({ kind, title: 'T', body: 'B' })
  const span = /<span class="state-icon"[^>]*>([\s\S]*?)<\/span>/.exec(html)
  assert.ok(span !== null, `${kind} has no state-icon span`)
  return span[1] ?? ''
}

test('every state renders exactly one inline SVG icon, hidden from the accessibility tree', () => {
  for (const kind of ['loading', 'empty', 'error', 'success', 'disabled'] as StateKind[]) {
    const icon = iconOf(kind)
    assert.equal(icon.match(/<svg\b/g)?.length ?? 0, 1, `${kind} needs exactly one <svg>, not ${icon.match(/<svg\b/g)?.length ?? 0}`)
    assert.match(icon, /^<svg\b/, `${kind}'s span content must start with the icon, so no glyph can survive beside it`)
    assert.match(icon, /aria-hidden="true"/, `${kind}'s icon must be aria-hidden; the <strong> title carries the meaning`)
    assert.match(icon, /focusable="false"/, `${kind}'s icon must not enter the tab order in IE-era engines`)
  }
})

test('the five icons share one viewBox and each carries a geometry element', () => {
  const boxes = new Set<string>()
  for (const kind of ['loading', 'empty', 'error', 'success', 'disabled'] as StateKind[]) {
    const icon = iconOf(kind)
    const box = /viewBox="([^"]+)"/.exec(icon)?.[1]
    assert.ok(box !== undefined && box !== '', `${kind}'s icon needs a viewBox`)
    boxes.add(box)
    assert.match(icon, /<(path|circle|rect|line)\b/, `${kind}'s icon needs at least one geometry element`)
    assert.doesNotMatch(icon, /\swidth="\d/, `${kind}'s icon must be sized by the stylesheet, not a width attribute`)
  }
  assert.equal(boxes.size, 1, `the five icons must share one viewBox, found ${[...boxes].join(' / ')}`)
})

test('the icon follows the state colour and hard-codes none', () => {
  for (const kind of ['loading', 'empty', 'error', 'success', 'disabled'] as StateKind[]) {
    const icon = iconOf(kind)
    assert.match(icon, /(stroke|fill)="currentColor"/, `${kind}'s icon must inherit the state colour`)
    assert.doesNotMatch(icon, /#[0-9a-f]{3,8}\b/i, `${kind}'s icon must not hard-code a hex colour`)
    assert.doesNotMatch(icon, /rgba?\(/, `${kind}'s icon must not hard-code an rgb colour`)
  }
  const sizing = rule('.state-icon svg')
  assert.ok(sizing !== null, 'public/app.css needs a .state-icon svg rule so the size lives in the sheet')
  assert.match(sizing ?? '', /width:\s*22px/)
  assert.match(sizing ?? '', /height:\s*22px/)
})

test('the icon adds no second announcement beside the visible title', () => {
  for (const kind of ['loading', 'empty', 'error', 'success', 'disabled'] as StateKind[]) {
    const html = renderState({ kind, title: 'Visible title', body: 'B' })
    const icon = iconOf(kind)
    assert.doesNotMatch(icon, /<title\b/, `${kind}'s icon must not add a <title>; that would double the announcement`)
    assert.doesNotMatch(icon, /aria-label/, `${kind}'s icon must not carry an aria-label`)
    assert.match(html, /<strong>Visible title<\/strong>/, `${kind} must keep the visible title as the meaning`)
  }
})

// 9. /search built its own empty state by hand and pasted a literal '0' into
// `.state-icon`, so on the one page that composes its own state the "five states
// are one SVG set" claim was false. The fix routes it through renderState; this
// pins the rendered output, not the source text, so a second hand-built icon
// fails here whichever page it appears on.
function stateIcon(html: string): string {
  return /<span class="state-icon"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? ''
}

test('/search renders both empty branches through the shared icon, with no bare glyph', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'search-ui', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const input = {
      config,
      locale: 'en' as const,
      viewer,
      repos: [],
      filters: { q: 'nothing', repo: '', status: '', kind: '', from: '', to: '' },
      cap: 20,
    }
    const empty = { rows: [], capped: false }
    const branches: [string, string][] = [
      ['blank', searchPage({ ...input, results: null })],
      ['no-match', searchPage({ ...input, results: { repos: empty, jobs: empty, workItems: empty, audit: empty } })],
    ]
    for (const [label, html] of branches) {
      assert.match(html, /data-state="empty"/, `${label}: /search must render the shared empty state`)
      assert.match(html, /role="status"/, `${label}: the empty state keeps its live-region role`)
      const icon = stateIcon(html)
      assert.match(icon, /^<svg\b/, `${label}: .state-icon must hold the shared SVG, not a glyph`)
      assert.equal(icon.replace(/<svg[\s\S]*?<\/svg>/g, '').trim(), '', `${label}: no bare glyph may survive beside the icon`)
    }
  } finally {
    store.close()
  }
})

// 10. The icon span belongs to the renderer: a page that writes it by hand can
// drift back to a glyph without any of the state tests above noticing.
test('no page builds a .state-icon span by hand', () => {
  assert.doesNotMatch(pages, /<span class="state-icon"/, 'the icon span belongs to src/views/states.ts alone')
})

// 11. The slot holds an <svg>; a font declaration on the slot itself is styling
// that cannot reach the child and reads as live.
test('the .state-icon rule carries no dead glyph styling', () => {
  const icon = rule('.state-icon')
  assert.ok(icon !== null, 'public/app.css needs a .state-icon rule')
  assert.doesNotMatch(icon ?? '', /font-size|font-weight/, 'the icon slot holds an <svg>, so font declarations there are dead')
})
