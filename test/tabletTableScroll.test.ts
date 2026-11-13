import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

function tabletBlock(): string {
  const marker = '@media (min-width: 641px) and (max-width: 960px)'
  const start = css.lastIndexOf(marker, css.indexOf('scrollbar-gutter: stable'))
  assert.ok(start !== -1, 'public/app.css has no tablet table block')
  const open = css.indexOf('{', start)
  const end = css.indexOf('\n}', open)
  assert.ok(end !== -1, 'the tablet table block is not closed')
  return css.slice(open + 1, end)
}

test('a tablet table keeps its first column and signals horizontal scroll', () => {
  const block = tabletBlock()
  assert.match(block, /\.table-scroll\s*\{[^}]*scrollbar-gutter:\s*stable/)
  assert.match(block, /\.table-scroll\s*\{[^}]*overscroll-behavior-x:\s*contain/)
  assert.match(block, /box-shadow:\s*inset -14px 0 14px -14px/)
  assert.match(block, /\.table-scroll th:first-child,\s*\.table-scroll td:first-child\s*\{[^}]*position:\s*sticky/)
  assert.match(block, /left:\s*0/)
  assert.match(block, /background:\s*var\(--panel\)/)
})
