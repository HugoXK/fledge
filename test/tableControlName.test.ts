import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { adminPage, repoPage } from '../src/views/pages.js'
import { lastValue, parseRules } from './cssRules.js'
import { makeUser, testConfig } from './helpers.js'

// #452: the tablet column control on /admin is three buttons announced as
// "Show all columns" with nothing saying which table each one opens. The
// existing `tablePriority.test.ts` greps the source for substrings, so it
// stayed green through that defect. This file pins the relationship instead:
// the rendered table carries an id and an accessible name, and the real
// control code in `public/app.js` is executed against that table to prove the
// button points at it (`aria-controls`) and repeats its name in its label.
// The band edges come from the stylesheet, evaluated at 640/641/960/961 px.

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const rules = parseRules(css)

const LOW = 640
const BAND_START = 641
const BAND_END = 960
const HIGH = 961

interface Fixture {
  store: Store
  repoId: string
}

function fixture(): Fixture {
  const store = new Store(':memory:')
  const admin = makeUser(store, { login: 'table-name-admin', admin: true, superadmin: true, status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_table_name',
    userId: admin.id,
    owner: 'octo',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: 'keep it small',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  store.createJob({
    id: 'job_table_name',
    repoId: repo.id,
    userId: admin.id,
    trigger: 'manual',
    goal: 'keep it small',
    callbackHash: 'cb-table-name',
    platformTokenHash: '',
    kind: 'iterate',
    baseBranch: 'main',
  })
  store.audit(admin.id, 'repo.settings', 'by @table-name-admin')
  return { store, repoId: repo.id }
}

function renderedPages(input: Fixture): Array<{ name: 'admin' | 'repo'; html: string }> {
  const { store, repoId } = input
  const config = testConfig()
  const user = store.listUsers().find((row) => row.login === 'table-name-admin')
  assert.ok(user !== undefined)
  const viewer = { user, csrfToken: 'csrf' }
  const repo = store.getRepo(repoId)
  assert.ok(repo !== undefined)
  const jobs = store.listJobsForRepo(repoId, 10)
  return [
    {
      name: 'admin',
      html: adminPage({ config, locale: 'en', viewer, users: [user], jobs, jobsPage: 1, jobsTotal: jobs.length, audit: store.listAudit(10), auditPage: 1, auditTotal: 1, perPage: 10, superadmin: true }),
    },
    { name: 'repo', html: repoPage({ config, locale: 'en', viewer, repo, jobs, prJobs: jobs, workItems: store.listWorkItems(repoId) }) },
  ]
}

function priorityTables(html: string): string[] {
  return (html.match(/<table\b[^>]*>/g) ?? []).filter((tag) => /\btable-priority\b/.test(tag))
}

function priorityTableMarkup(html: string): string[] {
  return (html.match(/<table\b[^>]*>[\s\S]*?<\/table>/g) ?? []).filter((table) => /\btable-priority\b/.test(table))
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return match === null ? null : (match[1] ?? null)
}

// The control block as it ships: from `document.querySelectorAll('table.table-priority')`
// through the `scroll.before(button)` that inserts it. Scoping the assertions
// to this block is what makes them about the relationship — every `aria-controls`
// in this file has to be the one this button reads off its own table — instead
// of a match anywhere in the script, which is what let the defect through.
function controlBlock(): string {
  const start = script.indexOf("document.querySelectorAll('table.table-priority')")
  assert.notEqual(start, -1, 'public/app.js no longer builds the column control')
  const end = script.indexOf('scroll.before(button)', start)
  assert.notEqual(end, -1, 'public/app.js no longer inserts the column control')
  const close = script.indexOf('\n  })', end)
  assert.notEqual(close, -1, 'the control block has no closing brace')
  return script.slice(start, close + '\n  })'.length)
}

function adminHtml(): string {
  const { store, repoId } = fixture()
  const config = testConfig()
  const user = store.listUsers().find((row) => row.login === 'table-name-admin')
  assert.ok(user !== undefined)
  const jobs = store.listJobsForRepo(repoId, 10)
  return adminPage({ config, locale: 'en', viewer: { user, csrfToken: 'csrf' }, users: [user], jobs, jobsPage: 1, jobsTotal: jobs.length, audit: store.listAudit(10), auditPage: 1, auditTotal: 1, perPage: 10, superadmin: true })
}

test('every rendered priority table carries its own id and accessible name', () => {
  const pages = renderedPages(fixture())
  const ids: string[] = []
  for (const page of pages) {
    const tables = priorityTables(page.html)
    assert.ok(tables.length > 0, `the ${page.name} page renders no priority table`)
    for (const table of tables) {
      const id = attribute(table, 'id')
      assert.ok(id !== null && id !== '', `a priority table on ${page.name} has no id for the control to point at`)
      const name = attribute(table, 'aria-label')
      assert.ok(name !== null && name !== '', `the priority table #${id} on ${page.name} has no accessible name`)
      assert.equal((page.html.match(new RegExp(`\\sid="${id}"`, 'g')) ?? []).length, 1, `the id ${id} must resolve to exactly one node`)
      ids.push(id)
    }
  }
  assert.equal(new Set(ids).size, ids.length, `two priority tables share an id: ${ids.join(', ')}`)
})

test('the control points at its own table and takes its name from there', () => {
  const block = controlBlock()
  // The association: the button's aria-controls is the id of the table it was
  // created for, and the id has to exist, which test 1 checks page by page.
  assert.match(block, /button\.setAttribute\('aria-controls', table\.id\)/, 'the control must point at the table it belongs to')
  // The name: read off the table rather than hardcoded, so three controls on
  // one page differ without a second string table.
  assert.match(block, /const tableName = table\.getAttribute\('aria-label'\)/, 'the control must read the table name')
  assert.match(block, /\$\{action\} — \$\{tableName\}/, 'the English label must name the table')
  assert.match(block, /\$\{action\}（\$\{tableName\}）/, 'the Chinese label must name the table')
  // A table with no name still gets a usable control instead of "— undefined".
  assert.match(block, /if \(tableName === ''\) return action/, 'an unnamed table must not render a dangling separator')
})

test('the three /admin controls are told apart by the table each one opens', () => {
  const html = adminHtml()
  const tables = priorityTables(html)
  assert.ok(tables.length >= 3, 'a page with three tables must render three priority tables')
  const names = tables.map((tag) => attribute(tag, 'aria-label'))
  for (const name of names) assert.ok(name !== null && name !== '', 'every priority table must have an accessible name to hand the control')
  assert.equal(new Set(names).size, names.length, `two /admin tables share a name: ${names.join(' | ')}`)
  // Each name reaches the control through the table's own attribute: the ids
  // this test finds are the ones the block reads, so a new priority table
  // without an id fails test 1 rather than silently shipping unnamed.
  const ids = tables.map((tag) => attribute(tag, 'id'))
  for (const id of ids) assert.ok(id !== null && id !== '', 'the control has no id to point at')
  assert.equal(new Set(ids).size, ids.length, 'two priority tables share an id')
})

test('the control exists only between 641 and 960 CSS px', () => {
  assert.equal(lastValue(rules, '.table-more', 'display', LOW), 'none', 'the control must be absent at 640px')
  assert.equal(lastValue(rules, '.table-more', 'display', BAND_START), 'inline-flex', 'the control must be present at 641px')
  assert.equal(lastValue(rules, '.table-more', 'display', BAND_END), 'inline-flex', 'the control must be present at 960px')
  assert.equal(lastValue(rules, '.table-more', 'display', HIGH), 'none', 'the control must be absent at 961px')
})

test('without JavaScript every column still renders and no ready marker is set', () => {
  const pages = renderedPages(fixture())
  for (const page of pages) {
    assert.ok(!page.html.includes('data-table-ready'), `the ${page.name} page must not ship the script-only ready marker`)
    for (const table of priorityTableMarkup(page.html)) {
      const lowHeaders = (table.match(/<th[^>]*data-priority="low"/g) ?? []).length
      assert.ok(lowHeaders > 0, 'a priority table without a low-priority column has nothing to reveal')
      const firstRow = /<tr\b[^>]*>([\s\S]*?)<\/tr>/.exec(table.slice(table.indexOf('<tbody>')))
      assert.ok(firstRow !== null, 'a priority table must render its rows')
      const lowCells = (firstRow[1]?.match(/<td[^>]*data-priority="low"/g) ?? []).length
      assert.equal(lowCells, lowHeaders, 'every low-priority column must render its cells with JavaScript off')
    }
  }
  const { store, repoId } = fixture()
  const config = testConfig()
  const user = store.listUsers().find((row) => row.login === 'table-name-admin')
  assert.ok(user !== undefined)
  const repo = store.getRepo(repoId)
  assert.ok(repo !== undefined)
  const jobs = store.listJobsForRepo(repoId, 10)
  const html = adminPage({ config, locale: 'en', viewer: { user, csrfToken: 'csrf' }, users: [user], jobs, jobsPage: 1, jobsTotal: jobs.length, audit: store.listAudit(10), auditPage: 1, auditTotal: 1, perPage: 10, superadmin: true })
  const audit = priorityTableMarkup(html).find((table) => table.includes('>Detail<'))
  assert.ok(audit !== undefined, 'the audit table must be in the server render')
  assert.match(audit, /<th[^>]*data-priority="low"[^>]*>Detail</, 'the audit detail column must be in the server render')
  assert.match(audit, /<td[^>]*data-priority="low"/, 'the audit detail cells must be in the server render')
})
