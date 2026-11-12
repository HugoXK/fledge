import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { dashboardPage } from '../src/views/pages.js'
import { renderState } from '../src/views/states.js'
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
