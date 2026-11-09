import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { dashboardPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// The dashboard's recent-jobs table is wider than its card at 320-480px: the
// two column floors (.job-cell 150px, .job-summary 180px) put a 330px floor
// under a table whose narrowest card boxes only 240px, and nowrap content
// wants 512px. Both halves below are deterministic: the first reads the
// stylesheet, the second renders the page. Neither proves the pixel result;
// the PR carries the browser measurement for that.

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

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

function declarationsFor(selector: string, width: number): Declaration[] {
  const matched: Declaration[] = []
  for (const rule of rules) {
    if (!appliesAt(rule, width)) continue
    if (!rule.selectors.includes(selector)) continue
    matched.push(...rule.declarations)
  }
  return matched
}

function lastValue(selector: string, property: string, width: number): string | null {
  let value: string | null = null
  for (const declaration of declarationsFor(selector, width)) {
    if (declaration.property === property) value = declaration.value
  }
  return value
}

function pxValue(value: string | null): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '0') return 0
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(trimmed)
  return match === null ? null : Number(match[1])
}

// The narrowest card content box the issue measured: 320 - 2x16 (.wrap) -
// 2x24 (.card).
const NARROWEST_CARD_BOX = 240

test('the job table declares no column floor that its narrowest card cannot hold', () => {
  const floors = ['.job-table .job-cell', '.job-table .job-summary'].map((selector) => {
    const floor = pxValue(lastValue(selector, 'min-width', 320))
    assert.ok(floor !== null, `${selector} must keep an explicit min-width so this rule is checked, not implied`)
    return { selector, floor }
  })
  const total = floors.reduce((sum, entry) => sum + entry.floor, 0)
  assert.ok(
    total <= NARROWEST_CARD_BOX,
    `the job table columns floor at ${String(total)}px at 320px (${floors.map((entry) => `${entry.selector} ${String(entry.floor)}px`).join(' + ')}), wider than the ${String(NARROWEST_CARD_BOX)}px card content box`,
  )
  // The summary also carried a 420px max-width; a card must be free to wrap.
  assert.equal(lastValue('.job-table .job-summary', 'max-width', 320), 'none')
})

test('the job table stops being a horizontal scroller below 640px', () => {
  // Cells become blocks: no display:table layout to overflow a 240px box.
  assert.equal(lastValue('.job-table td', 'display', 320), 'block')
  assert.equal(lastValue('.job-table tbody', 'display', 320), 'block')
  // The content that wanted 512px wraps instead.
  assert.equal(lastValue('.job-table td code', 'white-space', 320), 'normal')
  assert.equal(lastValue('.job-table .job-links', 'white-space', 320), 'normal')
  // The header row is out of flow but stays in the document.
  const headDisplay = lastValue('.job-table thead', 'display', 320)
  const headClip = lastValue('.job-table thead', 'clip-path', 320)
  assert.ok(
    headDisplay === 'none' || headClip === 'inset(50%)',
    `the card layout must remove the header row from the flow, got display=${String(headDisplay)} clip-path=${String(headClip)}`,
  )
  // Each card cell carries its own visible label.
  assert.equal(lastValue('.job-table td::before', 'content', 320), 'attr(data-label)')
})

test('the card layout leaves the tablet and desktop table untouched', () => {
  assert.equal(lastValue('.job-table td', 'display', 768), null)
  assert.equal(lastValue('.job-table .job-cell', 'min-width', 768), '150px')
  assert.equal(lastValue('.job-table .job-summary', 'min-width', 768), '180px')
  assert.equal(lastValue('.job-table thead', 'clip-path', 768), null)
})

test('every job cell is emitted with its column label, in both languages', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'job-table-cards', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const repo = store.createRepo({
      id: 'repo_cards',
      userId: user.id,
      owner: 'o',
      name: 'r',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: 'keep it small',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const job = store.createJob({
      id: 'job_cards_1',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'keep it small',
      callbackHash: 'cb',
      platformTokenHash: '',
      kind: 'iterate',
      baseBranch: 'main',
    })
    store.updateJob(job.id, { status: 'failed', summary: 'Tests failed', pr_url: 'https://github.com/o/r/pull/7' })

    const en = dashboardPage({ config, locale: 'en', viewer, repos: [store.getRepo(repo.id)!], jobs: [store.getJob(job.id)!], notifications: [] })
    for (const label of ['Job', 'Status', 'PR / Issue', 'Summary']) {
      assert.match(en, new RegExp(`data-label="${label.replace(/[/\\^$.*+?()[\]{}|]/g, '\\$&')}"`), `the English table must label the ${label} cell`)
    }
    const zh = dashboardPage({ config, locale: 'zh', viewer, repos: [store.getRepo(repo.id)!], jobs: [store.getJob(job.id)!], notifications: [] })
    for (const label of ['任务', '状态', 'PR / Issue', '摘要']) {
      assert.match(zh, new RegExp(`data-label="${label.replace(/[/\\^$.*+?()[\]{}|]/g, '\\$&')}"`), `the Chinese table must label the ${label} cell`)
    }
    // One label per column of the one populated row, and the empty-state row
    // stays a plain colspan cell rather than a card with four bare labels.
    assert.equal(en.match(/data-label="/g)?.length, 4)
  } finally {
    store.close()
  }
})
