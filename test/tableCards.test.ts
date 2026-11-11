import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { WORK_ITEM_STATES, workItemStateLabel } from '../src/lib/workItems.js'
import { adminPage, adminSupportPage, dashboardPage, repoPage } from '../src/views/pages.js'
import { lastValue, parseRules, pxValue } from './cssRules.js'
import { makeUser, testConfig } from './helpers.js'
import { translator } from '../src/i18n.js'

// #130: the tables the phone matrix measured as clipped inside `.table-scroll`
// reuse the mechanism #116 built for the job table — a `data-label` on every
// cell and the same `max-width: 640px` block in `public/app.css`. The stylesheet
// half proves the block applies at 360 and not at 768; the render half proves
// every cell of every named table carries its column label in both languages.
// Neither half measures pixels: the PR body says so and names what was not run.

const cssSource = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
const rules = parseRules(cssSource)

const PHONE = 360
const TABLET = 768

test('the card layout is #116’s block, extended to every carded table', () => {
  const expected: Array<[string, string, string]> = [
    ['.table-cards', 'display', 'block'],
    ['.table-cards thead', 'display', 'none'],
    ['.table-cards tbody', 'display', 'block'],
    ['.table-cards td', 'display', 'block'],
    ['.table-cards td::before', 'content', 'attr(data-label)'],
    ['.table-cards td:not([data-label])::before', 'display', 'none'],
  ]
  for (const [selector, property, value] of expected) {
    assert.equal(lastValue(rules, selector, property, PHONE), value, `${selector} must declare ${property}: ${value} at ${String(PHONE)}px`)
  }
  // Content that used nowrap or an unbreakable token wraps inside the card.
  assert.equal(lastValue(rules, '.table-cards td code', 'white-space', PHONE), 'normal')
  assert.equal(lastValue(rules, '.table-cards .nowrap', 'white-space', PHONE), 'normal')
})

test('the board keeps its stage filter when the header row leaves the flow', () => {
  // Below 641px a header row is out of the flow, but the board's th are links:
  // that table keeps a wrapping control row instead of losing it.
  assert.equal(lastValue(rules, '.table-cards thead', 'display', PHONE), 'none')
  assert.equal(lastValue(rules, '.table-cards-head thead', 'display', PHONE), 'block')
  // The touch floor on those links is slice 3 (#132); this slice only keeps
  // them in the flow at all.
  assert.equal(lastValue(rules, '.table-cards-head thead tr', 'display', PHONE), 'flex')
})

test("the users table's 320px column floor is dropped below 641px and kept above it", () => {
  // The floor made a 278px scroller hold a 621px table. A card has no columns,
  // so it goes at phone width and stays on the tablet table.
  assert.equal(pxValue(lastValue(rules, '.admin-users-table.table-cards td:last-child', 'min-width', PHONE)), 0)
  assert.equal(pxValue(lastValue(rules, '.admin-users-table td:last-child', 'min-width', TABLET)), 320)
})

test('the card layout does not reach the tablet', () => {
  assert.equal(lastValue(rules, '.table-cards td', 'display', TABLET), null)
  assert.equal(lastValue(rules, '.table-cards thead', 'display', TABLET), null)
  assert.equal(lastValue(rules, '.table-cards-head thead', 'display', TABLET), null)
})

function cardTables(html: string): string[] {
  return [...html.matchAll(/<table class="[^"]*table-cards[^"]*">[\s\S]*?<\/table>/g)].map((match) => match[0])
}

function labelsOf(table: string): string[] {
  return [...table.matchAll(/data-label="([^"]*)"/g)].map((match) => match[1] ?? '')
}

function unlabelledCells(table: string): number {
  const cells = table.match(/<td\b[^>]*>/g) ?? []
  return cells.filter((tag) => !tag.includes('data-label=')).length
}

interface Fixture {
  store: Store
  repoId: string
}

function fixture(): Fixture {
  const store = new Store(':memory:')
  const admin = makeUser(store, { login: 'table-cards-admin', admin: true, superadmin: true, status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_table_cards',
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
  const job = store.createJob({
    id: 'job_table_cards',
    repoId: repo.id,
    userId: admin.id,
    trigger: 'manual',
    goal: 'keep it small',
    callbackHash: 'cb-table-cards',
    platformTokenHash: '',
    kind: 'iterate',
    baseBranch: 'main',
  })
  store.updateJob(job.id, { status: 'failed', summary: 'Tests failed', pr_url: 'https://github.com/octo/demo/pull/9' })
  store.createWorkItem({
    id: 'work_table_cards',
    repoId: repo.id,
    userId: admin.id,
    title: 'Fix the parser',
    detail: 'It drops a token.',
    issueUrl: 'https://github.com/octo/demo/issues/1',
    prUrl: 'https://github.com/octo/demo/pull/2',
    priority: 20,
    state: 'triaged',
  })
  store.audit(admin.id, 'repo.settings', 'by @table-cards-admin')
  return { store, repoId: repo.id }
}

function pagesOf(input: Fixture, locale: 'en' | 'zh'): Array<{ name: string; html: string }> {
  const { store, repoId } = input
  const config = testConfig()
  const user = store.listUsers().find((row) => row.login === 'table-cards-admin')
  assert.ok(user !== undefined)
  const viewer = { user, csrfToken: 'csrf' }
  const repo = store.getRepo(repoId)
  assert.ok(repo !== undefined)
  const jobs = store.listJobsForRepo(repoId, 10)
  return [
    { name: 'dashboard', html: dashboardPage({ config, locale, viewer, repos: [repo], jobs, notifications: [] }) },
    {
      name: 'admin',
      html: adminPage({ config, locale, viewer, users: [user], jobs, jobsPage: 1, jobsTotal: jobs.length, audit: store.listAudit(10), auditPage: 1, auditTotal: 1, perPage: 10, superadmin: true }),
    },
    { name: 'repos', html: repoPage({ config, locale, viewer, repo, jobs, prJobs: jobs, workItems: store.listWorkItems(repoId) }) },
    { name: 'support', html: adminSupportPage({ config, locale, viewer, user, repos: [repo], jobs, audit: store.listAudit(10) }) },
  ]
}

const EN_LABELS: Record<string, string[][]> = {
  dashboard: [['Repository', 'Mode', 'Status', 'Last run', 'Actions']],
  admin: [
    ['Login', 'Status', 'Role', 'Quota', 'Used', 'Activity', 'Adjust'],
    ['Time', 'Action', 'Actor', 'Detail'],
  ],
  repos: [
    ['Work item', 'State', 'Priority', 'Issue / PR', 'Job', 'Actions'],
    ['PR', 'Status', 'Verified', 'Review', 'Cost', 'Created', 'Actions'],
  ],
  support: [
    ['Repository', 'Role', 'Status', 'Last run'],
    ['Job', 'Status', 'PR', 'Created'],
  ],
}

const ZH_LABELS: Record<string, string[][]> = {
  dashboard: [['仓库', '模式', '状态', '上次运行', '操作']],
  admin: [
    ['登录名', '状态', '角色', '额度', '已用', '活动', '调整'],
    ['时间', '动作', '操作者', '详情'],
  ],
  repos: [
    ['工作项', '状态', '优先级', 'Issue / PR', '任务', '操作'],
    ['PR', '状态', '核实', '审核分', '成本', '创建', '操作'],
  ],
  support: [
    ['仓库', '角色', '状态', '上次运行'],
    ['任务', '状态', 'PR', '创建'],
  ],
}

for (const locale of ['en', 'zh'] as const) {
  test(`every cell of every carded table carries its column label (${locale})`, () => {
    const input = fixture()
    try {
      const expected = locale === 'en' ? EN_LABELS : ZH_LABELS
      const pages = pagesOf(input, locale)
      const boardLabels = WORK_ITEM_STATES.map((state) => workItemStateLabel(translator(locale), state))
      for (const page of pages) {
        const tables = cardTables(page.html)
        const wanted = expected[page.name] ?? []
        // The board adds one carded table (its stage filter row plus five cells).
        const extra = page.name === 'repos' ? 1 : 0
        assert.equal(tables.length, wanted.length + extra, `the ${page.name} page must render ${String(wanted.length + extra)} carded table(s), got ${String(tables.length)}`)
        for (const table of tables) {
          assert.equal(unlabelledCells(table), 0, `every cell of every ${page.name} carded table must carry data-label`)
        }
        if (page.name === 'repos') {
          const board = tables.find((table) => table.includes('table-cards-head')) ?? ''
          assert.notEqual(board, '', 'the board keeps its own class so its filter row can stay in the flow')
          assert.deepEqual(labelsOf(board), boardLabels, 'the board prints the stage name above each count')
        }
        for (const labels of wanted) {
          const match = tables.find((table) => labelsOf(table).slice(0, labels.length).every((label, index) => label === labels[index]))
          assert.ok(match !== undefined, `the ${page.name} page must label its table with ${labels.join(' / ')}`)
        }
      }
    } finally {
      input.store.close()
    }
  })
}

test('an empty table stays a plain colspan cell instead of a card with bare labels', () => {
  const store = new Store(':memory:')
  try {
    const config = testConfig()
    const admin = makeUser(store, { login: 'table-cards-empty', admin: true, superadmin: true, status: 'approved' })
    const viewer = { user: store.userById(admin.id)!, csrfToken: 'csrf' }
    const html = adminPage({ config, locale: 'en', viewer, users: [], jobs: [], jobsPage: 1, jobsTotal: 0, audit: [], auditPage: 1, auditTotal: 0, perPage: 10, superadmin: true })
    const tables = cardTables(html)
    assert.ok(tables.length >= 1)
    // The empty state is one colspan cell: it carries no data-label, and the
    // stylesheet hides the caption for exactly that cell.
    for (const table of tables) {
      // A table with no rows has nothing to card; a table whose empty state is
      // one colspan cell keeps that cell unlabelled.
      const cells = table.match(/<td\b[^>]*>/g) ?? []
      for (const tag of cells) assert.ok(!tag.includes('data-label='), 'an empty table must not invent a label for its state cell')
    }
  } finally {
    store.close()
  }
})
