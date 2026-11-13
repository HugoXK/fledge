import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { dashboardPage } from '../src/views/pages.js'
import { lastValue, parseRules, pxValue } from './cssRules.js'
import { makeUser, testConfig } from './helpers.js'

// The dashboard's recent-jobs table is wider than its card at 320-480px: the
// two column floors (.job-cell 150px, .job-summary 180px) put a 330px floor
// under a table whose narrowest card boxes only 240px, and nowrap content
// wants 512px. Both halves below are deterministic: the first reads the
// stylesheet, the second renders the page. Neither proves the pixel result;
// the PR carries the browser measurement for that.

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

const rules = parseRules(cssSource)

// The narrowest card content box the issue measured: 320 - 2x16 (.wrap) -
// 2x24 (.card).
const NARROWEST_CARD_BOX = 240

test('the job table declares no column floor that its narrowest card cannot hold', () => {
  const floors = ['.job-table .job-cell', '.job-table .job-summary'].map((selector) => {
    const floor = pxValue(lastValue(rules, selector, 'min-width', 320))
    assert.ok(floor !== null, `${selector} must keep an explicit min-width so this rule is checked, not implied`)
    return { selector, floor }
  })
  const total = floors.reduce((sum, entry) => sum + entry.floor, 0)
  assert.ok(
    total <= NARROWEST_CARD_BOX,
    `the job table columns floor at ${String(total)}px at 320px (${floors.map((entry) => `${entry.selector} ${String(entry.floor)}px`).join(' + ')}), wider than the ${String(NARROWEST_CARD_BOX)}px card content box`,
  )
  // The summary also carried a 420px max-width; a card must be free to wrap.
  assert.equal(lastValue(rules, '.job-table .job-summary', 'max-width', 320), 'none')
})

test('the job table stops being a horizontal scroller below 640px', () => {
  // Cells become blocks: no display:table layout to overflow a 240px box.
  assert.equal(lastValue(rules, '.job-table td', 'display', 320), 'block')
  assert.equal(lastValue(rules, '.job-table tbody', 'display', 320), 'block')
  // The content that wanted 512px wraps instead.
  assert.equal(lastValue(rules, '.job-table td code', 'white-space', 320), 'normal')
  assert.equal(lastValue(rules, '.job-table .job-links', 'white-space', 320), 'normal')
  // The header row is out of flow but stays in the document.
  const headDisplay = lastValue(rules, '.job-table thead', 'display', 320)
  const headClip = lastValue(rules, '.job-table thead', 'clip-path', 320)
  assert.ok(
    headDisplay === 'none' || headClip === 'inset(50%)',
    `the card layout must remove the header row from the flow, got display=${String(headDisplay)} clip-path=${String(headClip)}`,
  )
  // Each card cell carries its own visible label.
  assert.equal(lastValue(rules, '.job-table td::before', 'content', 320), 'attr(data-label)')
})

test('the card layout leaves the tablet and desktop table untouched', () => {
  assert.equal(lastValue(rules, '.job-table td', 'display', 768), null)
  assert.equal(lastValue(rules, '.job-table .job-cell', 'min-width', 768), '150px')
  assert.equal(lastValue(rules, '.job-table .job-summary', 'min-width', 768), '180px')
  assert.equal(lastValue(rules, '.job-table thead', 'clip-path', 768), null)
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
    // stays a plain colspan cell rather than a card with four bare labels. The
    // dashboard now carries other carded tables, so count inside this one.
    // A priority table now also carries an id and an accessible name (#452),
    // so the tag may hold attributes after the class.
    const jobTableMarkup = /<table class="job-table[^"]*"[^>]*>[\s\S]*?<\/table>/.exec(en)?.[0] ?? ''
    assert.notEqual(jobTableMarkup, '', 'the dashboard must still render its job table')
    assert.equal(jobTableMarkup.match(/data-label="/g)?.length, 4)
  } finally {
    store.close()
  }
})
