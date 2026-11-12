import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pages = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

test('settings and admin carry a section nav with matching ids', () => {
  for (const href of ['#account', '#model-providers', '#notifications', '#tokens']) {
    assert.ok(pages.includes(`href="${href}"`), `settings nav is missing ${href}`)
  }
  for (const id of ['account', 'model-providers', 'notifications', 'tokens']) {
    assert.ok(pages.includes(`id="${id}"`), `settings section is missing id=${id}`)
  }
  for (const href of ['#release', '#release-chain', '#backups', '#pending', '#users', '#jobs', '#audit']) {
    assert.ok(pages.includes(`href="${href}"`), `admin nav is missing ${href}`)
  }
  for (const id of ['release', 'release-chain', 'backups', 'pending', 'users', 'jobs', 'audit']) {
    assert.ok(pages.includes(`id="${id}"`), `admin section is missing id=${id}`)
  }
})

test('the section nav sticks under the header and offsets its targets', () => {
  const rule = /\.section-nav\s*\{([^}]*)\}/.exec(css)
  assert.ok(rule !== null, 'public/app.css has no .section-nav rule')
  assert.match(rule[1] ?? '', /position:\s*sticky/)
  assert.match(rule[1] ?? '', /top:\s*var\(--header-h\)/)
  assert.match(css, /\.section-nav ~ \.card\[id\]\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--header-h\)\s*\+\s*56px\)/)
})

test('the script marks the visible section without a second route', () => {
  assert.match(script, /querySelector\(['"]\.section-nav['"]\)/)
  assert.match(script, /IntersectionObserver/)
  assert.match(script, /setAttribute\(['"]aria-current['"]/)
})
