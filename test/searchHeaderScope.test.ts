import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { adminSearchPage, searchPage } from '../src/views/pages.js'
import type { OwnedSearch } from '../src/db.js'
import { makeUser, testConfig } from './helpers.js'

// #1010: the shared renderer inside `searchPage` emitted a bare `<th>`, so every
// card it drew lost the column association and a screen reader announced the
// value with no column name. The eight header cells in the filtered-result card
// on `/admin/search` already declared `scope="col"`; that page is the regression
// surface, not the acceptance surface, so both halves are pinned here. A test
// that only counted `<th>` would pass on the compliant card and say nothing.

// Opening tags only: `<thead>` also starts with `<th`, so a cell is `<th`
// followed by a space or the closing `>`.
function headerCells(html: string): string[] {
  const cells: string[] = []
  let from = 0
  for (;;) {
    const at = html.indexOf('<th', from)
    if (at === -1) return cells
    const after = html.charAt(at + 3)
    if (after !== ' ' && after !== '>') {
      from = at + 3
      continue
    }
    const end = html.indexOf('>', at)
    if (end === -1) return cells
    cells.push(html.slice(at, end + 1))
    from = end + 1
  }
}

function bareHeaderCells(html: string): string[] {
  return headerCells(html).filter((cell) => !/\sscope="col"/.test(cell))
}

function renderPeopleSearch(results: OwnedSearch | null): string {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'scope-reader', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    return searchPage({
      config,
      locale: 'en',
      viewer,
      repos: [],
      filters: { q: 'widget', repo: '', status: '', kind: '', from: '', to: '' },
      results,
      cap: 20,
    })
  } finally {
    store.close()
  }
}

function renderAdminSearch(view: 'jobs' | 'audit'): string {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'scope-admin', status: 'approved' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    return adminSearchPage({
      config,
      locale: 'en',
      viewer,
      jobs: [],
      audit: [],
      usersById: new Map(),
      filters: { q: 'widget', status: '', kind: '', priority: '', action: '', from: '', to: '', view },
      jobsPage: 1,
      jobsTotal: 0,
      auditPage: 1,
      auditTotal: 0,
      perPage: 20,
      lastJobsExport: null,
      lastAuditExport: null,
    })
  } finally {
    store.close()
  }
}

// One row per section, so all four cards the helper draws are on the page. An
// empty section renders no card at all, which would make "no bare <th>" true for
// the wrong reason.
const section = <T>(rows: T[]) => ({ rows, capped: false })
const populated: OwnedSearch = {
  repos: section([{ id: 'r1', owner: 'acme', name: 'widgets', enabled: 1 }]),
  jobs: section([{ id: 'j1', repo_id: 'r1', status: 'succeeded' as const, kind: 'iterate', goal: 'g', summary: 's', error: null, pr_url: null, issue_url: null, created_at: '2026-01-01T00:00:00Z' }]),
  workItems: section([{ id: 'w1', repo_id: 'r1', title: 't', state: 'open', issue_url: null, pr_url: null, updated_at: '2026-01-01T00:00:00Z' }]),
  audit: section([{ id: 1, at: '2026-01-01T00:00:00Z', action: 'job.create', detail: null }]),
}

test('every header cell the shared result renderer draws declares its column', () => {
  const html = renderPeopleSearch(populated)
  const cells = headerCells(html)
  // Repositories 2, Jobs 4, Work items 3, Audit 3. The count proves the four
  // cards were rendered, so the assertion below cannot pass on a blank page.
  assert.equal(cells.length, 12, `the four result cards carry 12 header cells, found ${cells.length}`)
  for (const cell of cells) {
    assert.match(cell, /\sscope="col"/, `a header cell is emitted without a column scope: ${cell}`)
  }
  assert.deepEqual(bareHeaderCells(html), [], 'no header cell on the people search page may be bare')
})

test('the filtered-result card on /admin/search keeps its declared column scope', () => {
  for (const view of ['jobs', 'audit'] as const) {
    const html = renderAdminSearch(view)
    const cells = headerCells(html)
    assert.equal(cells.length, 4, `the ${view} card carries 4 header cells, found ${cells.length}`)
    for (const cell of cells) {
      assert.match(cell, /\sscope="col"/, `the ${view} card regressed to a bare header cell: ${cell}`)
    }
    assert.deepEqual(bareHeaderCells(html), [], `no header cell in the ${view} view may be bare`)
  }
  // The audit branch is the one that carries the table id the issue names.
  assert.match(renderAdminSearch('audit'), /id="search-audit-table"/, 'the audit card keeps its table id')
})

test('the already-compliant card is not the only surface the fix has to cover', () => {
  // If the filtered-result card were the whole fix, the people search page would
  // still render bare cells. This fails on a tree that only touches the admin card.
  const people = renderPeopleSearch(populated)
  const admin = renderAdminSearch('jobs')
  assert.ok(headerCells(people).length > 0, 'the people search page renders its result cards')
  assert.deepEqual(bareHeaderCells(people), [], 'the shared renderer is the surface that has to change')
  assert.deepEqual(bareHeaderCells(admin), [], 'and the admin card stays compliant')
})
