import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const pages = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')

test('the priority tables mark their low-priority columns', () => {
  assert.ok(pages.includes('class="job-table table-priority"'), 'the job table must opt into the priority layout')
  assert.ok(pages.includes('class="admin-users-table table-cards table-priority"'), 'the admin users table must opt in')
  assert.ok(pages.includes('table-cards table-priority'), 'the audit table must opt in')
  assert.match(pages, /data-job-summary class="job-summary" data-priority="low"/)
  assert.match(pages, /data-priority="low" data-label="\$\{escapeHtml\(t\('已用', 'Used'\)\)\}"/)
  assert.match(pages, /data-priority="low" data-label="\$\{escapeHtml\(t\('详情', 'Detail'\)\)\}"/)
})

test('the tablet band hides low-priority columns only after the script is ready', () => {
  const marker = '@media (min-width: 641px) and (max-width: 960px)'
  const start = css.lastIndexOf(marker)
  assert.ok(start !== -1, 'public/app.css has no tablet priority block')
  const block = css.slice(start, css.indexOf('\n}', start))
  assert.match(block, /\.table-more\s*\{\s*display:\s*inline-flex/)
  assert.match(block, /data-table-ready="true"\] th\[data-priority="low"\]/)
  assert.match(block, /data-table-ready="true"\] td\[data-priority="low"\]/)
  assert.match(block, /display:\s*none/)
  assert.match(block, /data-show-low="true"\]/)
  assert.match(block, /display:\s*table-cell/)
})

test('the script creates the disclose control and keeps the columns reversible', () => {
  assert.match(script, /querySelectorAll\('table\.table-priority'\)/)
  assert.match(script, /data-show-low/)
  assert.match(script, /data-table-ready/)
  assert.match(script, /table-more/)
  assert.match(script, /aria-expanded/)
})
