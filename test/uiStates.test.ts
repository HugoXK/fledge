import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const layout = readFileSync(new URL('../src/views/layout.ts', import.meta.url), 'utf8')
const pages = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const teamJs = readFileSync(new URL('../public/team.js', import.meta.url), 'utf8')

function rule(selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'i').exec(css)
  return match === null ? null : (match[1] ?? null)
}

test('the five UI states have a shared component class each', () => {
  const missing: string[] = []
  for (const selector of ['.state', '.state.loading', '.state.empty', '.state.error', '.state.success', '.state.disabled']) {
    if (rule(selector) === null) missing.push(selector)
  }
  for (const selector of ['.skeleton', '[aria-busy="true"]', '.btn.is-busy', '.banner.ok', '.banner.bad', '.empty']) {
    if (rule(selector) === null) missing.push(selector)
  }
  assert.deepEqual(missing, [], `missing state styles: ${missing.join(', ')}`)
})

test('a busy control cannot be clicked twice and keeps its label for screen readers', () => {
  const busy = rule('.btn.is-busy')
  assert.ok(busy !== null, 'missing .btn.is-busy')
  const disabled = rule('.btn:disabled')
  assert.ok(disabled !== null, 'missing .btn:disabled')
  assert.match(appJs, /aria-busy/, 'public/app.js must mark a submitted form or button busy')
  assert.match(appJs, /data-pending-label/, 'the pending label must come from the server, so it is translated')
})

test('the skeleton prefers less motion when the reader asks for it', () => {
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)
  assert.ok(reduced !== null, 'missing prefers-reduced-motion block')
  assert.match(reduced[1] ?? '', /animation|transition/, 'reduced motion must neutralise animation/transition')
})

test('live regions announce streaming updates', () => {
  const live = (source: string, id: string) => {
    const tag = new RegExp(`<[^>]*id="${id}"[^>]*>`).exec(source)
    return tag === null ? '' : tag[0]
  }
  assert.match(live(pages, 'team-questions'), /aria-live="polite"/, '#team-questions needs aria-live')
  assert.match(live(pages, 'inbox'), /aria-live="polite"/, '#inbox needs aria-live')
  assert.match(live(pages, 'team-live'), /aria-busy="(true|false)"/, '#team-live needs aria-busy')
  assert.match(teamJs, /setAttribute\('aria-busy'|ariaBusy/, 'public/team.js must toggle aria-busy while it fetches')
})

test('the active navigation item is exposed, not only coloured', () => {
  assert.match(layout, /aria-current="page"/, 'the active nav link must carry aria-current="page"')
})

test('interactive targets hit the 44px touch target', () => {
  assert.match(css, /--touch:\s*44px/, 'missing --touch: 44px token')
  const uses = css.match(/min-height:\s*var\(--touch\)/g) ?? []
  assert.ok(uses.length >= 3, `expected the touch token on buttons and nav links, found ${uses.length}`)
})

test('focus stays visible on every interactive element', () => {
  assert.match(css, /:focus-visible\s*\{[^}]*outline/, 'missing a visible :focus-visible outline')
  assert.match(css, /\.skip-link:focus/, 'missing a skip link')
})
