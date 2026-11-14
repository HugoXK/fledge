import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { repoPage } from '../src/views/pages.js'
import { makeTerminalJob, makeUser, testConfig } from './helpers.js'
import { runRepoTabs } from './stubDom.js'

// #234: /repos/:id is one long scroll today. The six sections and the sticky
// subnav are a regroup of cards that already render, so the failure this pins
// is a regroup that loses one: an id someone deep-links to, a form, or an
// action that falls off the page. The pins below are the ten ids that exist at
// main 920c52f, the eleven `form action` targets and the page's href set, read
// from a render of that commit, plus the six anchors this change adds.

const SECTIONS = ['overview', 'delivery', 'work', 'team', 'settings', 'danger'] as const
const TAB_LABELS: Record<(typeof SECTIONS)[number], string> = {
  overview: 'Overview',
  delivery: 'Delivery',
  work: 'Work',
  team: 'Team',
  settings: 'Settings',
  danger: 'Danger',
}

// The ids, `form action` targets and hrefs the page renders at main 920c52f
// (read from a render of that commit with this fixture, repo id folded). #main
// and #main-nav belong to the layout; #role is absent here because this fixture
// has a role, and its own test covers that branch.
const KEPT_IDS = ['inbox', 'chief', 'chief-thread', 'board', 'jobs', 'repo-settings', 'connection', 'goal-settings']

const FORM_ACTIONS = [
  '/auth/logout',
  '/repos/:id/delete',
  '/repos/:id/delivery/merge-clean',
  '/repos/:id/disable',
  '/repos/:id/jobs/job_nav/merge',
  '/repos/:id/jobs/job_nav/recheck',
  '/repos/:id/plan',
  '/repos/:id/refresh',
  '/repos/:id/run',
  '/repos/:id/settings',
  // #523: the triage start is a repository-page form like the run and plan
  // starts, so the page's action inventory grows by exactly this one entry.
  '/repos/:id/triage',
  '/repos/:id/work',
]

const KEPT_HREFS = [
  '#inbox',
  '#main',
  '/',
  '/assets/app.css',
  '/console',
  '/dashboard',
  '/lang/en?next=%2Frepos%2F:id',
  '/lang/zh?next=%2Frepos%2F:id',
  '/repos/:id#chief',
  '/repos/:id/jobs/job_nav',
  '/repos/:id/workspace',
  '/repos/:id?workState=approved#work',
  '/repos/:id?workState=assigned#work',
  '/repos/:id?workState=changes_requested#work',
  '/repos/:id?workState=closed#work',
  '/repos/:id?workState=in_progress#work',
  '/repos/:id?workState=in_review#work',
  '/repos/:id?workState=merged#work',
  '/repos/:id?workState=pr_ready#work',
  '/repos/:id?workState=proposed#work',
  '/repos/:id?workState=triaged#work',
  '/settings',
  'https://fledge-docs.hugoxk.online/docs/',
  'https://github.com/HugoXK/fledge',
  'https://github.com/acme/demo',
  'https://hugoxk.online/status/',
  'https://portal.hugoxk.online',
]

const NEW_ANCHORS = ['#overview', '#delivery', '#work', '#team', '#settings', '#danger']

type Rendered = { html: string; close: () => void }

function renderRepo(options: { repoRole?: 'maintainer' | null } = {}): Rendered {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'nav-user', status: 'approved' })
  const repoRole = options.repoRole === undefined ? 'maintainer' : options.repoRole
  const repo = store.createRepo({
    id: 'repo_nav',
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: repoRole ?? undefined,
    goal: '',
    autoIterate: true,
    intervalMinutes: 1440,
  })
  store.createWorkItem({ id: 'work_nav', repoId: repo.id, userId: user.id, title: 'Nav item', detail: 'detail', state: 'in_review' })
  const job = makeTerminalJob(store, {
    id: 'job_nav',
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: 'h',
    platformTokenHash: 't',
    kind: 'iterate',
    baseBranch: 'main',
  })
  const html = repoPage({
    config,
    locale: 'en',
    viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
    repo,
    jobs: [job],
    prJobs: [job],
  })
  return { html, close: () => store.close() }
}

const uniq = (values: string[]): string[] => values.filter((value, index, all) => all.indexOf(value) === index).sort()
const norm = (value: string): string => value.replace(/repo_nav/g, ':id')
const idSet = (html: string): string[] => uniq([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1] ?? ''))
const formSet = (html: string): string[] => uniq([...html.matchAll(/<form[^>]*\saction="([^"]+)"/g)].map((match) => norm(match[1] ?? '')))
const hrefList = (html: string): string[] => uniq([...html.matchAll(/\shref="([^"]+)"/g)].map((match) => norm(match[1] ?? '')))

test('the repository page carries a six-tab subnav in order', () => {
  const rendered = renderRepo()
  try {
    const nav = /<nav[^>]*id="repo-tabs"[^>]*>([\s\S]*?)<\/nav>/.exec(rendered.html)
    assert.ok(nav, 'the page has no <nav id="repo-tabs">')
    const body = nav[1] ?? ''
    const links = [...body.matchAll(/<a[^>]*href="(#[a-z]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({ href: match[1] ?? '', label: (match[2] ?? '').trim(), tag: match[0] }))
    assert.deepEqual(links.map((link) => link.href), NEW_ANCHORS)
    assert.deepEqual(links.map((link) => link.label), SECTIONS.map((section) => TAB_LABELS[section]))
    const current = links.filter((link) => /aria-current="page"/.test(link.tag))
    assert.equal(current.length, 1, 'exactly one tab is aria-current="page"')
    assert.equal(current[0]?.href, '#overview', 'Overview is the section a bare /repos/:id opens')
    for (const link of links.slice(1)) assert.doesNotMatch(link.tag, /aria-current/, `${link.href} claims to be current`)
  } finally {
    rendered.close()
  }
})

test('each tab owns a section that keeps its deep link', () => {
  const rendered = renderRepo()
  try {
    const { html } = rendered
    for (const section of SECTIONS) {
      assert.match(html, new RegExp(`<section class="repo-section"[^>]*id="${section}"`), `no section wrapper for #${section}`)
      assert.match(html, new RegExp(`data-repo-section="${section}"`), `#${section} wrapper is not marked for the tab script`)
    }
    const positions = SECTIONS.map((section) => html.indexOf(`data-repo-section="${section}"`))
    assert.deepEqual(positions.slice().sort((a, b) => a - b), positions, 'sections must appear in nav order')
    // The three anchors that exist today still land on a real element.
    for (const anchor of ['delivery', 'work', 'danger']) {
      assert.equal(idSet(html).filter((id) => id === anchor).length, 1, `#${anchor} must exist exactly once`)
    }
  } finally {
    rendered.close()
  }
})

test('the regroup keeps every id and action the page has today', () => {
  const rendered = renderRepo()
  try {
    const ids = idSet(rendered.html)
    for (const id of KEPT_IDS) assert.ok(ids.includes(id), `id "${id}" disappeared in the regroup`)
    for (const anchor of ['delivery', 'work', 'danger']) assert.ok(ids.includes(anchor), `anchor #${anchor} disappeared`)
    for (const section of ['overview', 'team', 'settings']) assert.ok(ids.includes(section), `new anchor #${section} is missing`)

    assert.deepEqual(formSet(rendered.html), [...FORM_ACTIONS].sort(), 'the set of form actions changed')

    const hrefs = hrefList(rendered.html)
    for (const href of KEPT_HREFS) assert.ok(hrefs.includes(href), `href "${href}" disappeared in the regroup`)
    const anchors = hrefs.filter((href) => href.startsWith('#'))
    const added = anchors.filter((href) => !KEPT_HREFS.includes(href))
    assert.deepEqual(added, [...NEW_ANCHORS].sort(), 'the tabs added an anchor nobody asked for, or dropped one')
  } finally {
    rendered.close()
  }
})

test('the role card sits in the Team section', () => {
  const rendered = renderRepo({ repoRole: null })
  try {
    const { html } = rendered
    assert.ok(idSet(html).includes('role'), 'id "role" disappeared')
    const team = html.indexOf('data-repo-section="team"')
    const role = html.indexOf('id="role"')
    const settings = html.indexOf('data-repo-section="settings"')
    assert.ok(team >= 0 && role > team, 'the role card is not inside Team')
    assert.ok(settings > role, 'the role card fell past Settings')
  } finally {
    rendered.close()
  }
})

test('the subnav is sticky and one section shows at a time', () => {
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
  const rule = (selector: string): string => {
    const index = css.indexOf(selector)
    assert.ok(index >= 0, `stylesheet has no ${selector}`)
    const open = css.indexOf('{', index)
    const close = css.indexOf('}', open)
    return css.slice(open + 1, close)
  }
  const subnav = rule('.repo-subnav {')
  assert.match(subnav, /position:\s*sticky/, '.repo-subnav is not sticky')
  assert.match(subnav, /top:\s*var\(--header-h\)/, '.repo-subnav does not clear the sticky header')
  assert.match(subnav, /overflow-x:\s*auto/, 'a narrow screen cannot reach the last tabs')
  assert.match(rule('.repo-page.is-tabbed .repo-section {'), /display:\s*none/, 'sections are not collapsed once the script runs')
  assert.match(rule('.repo-page.is-tabbed .repo-section.is-active {'), /display:\s*block/, 'the active section is not shown')
  assert.match(rule('.repo-tab[aria-current="page"] {'), /background:\s*var\(--accent-strong\)/, 'the current tab is not marked with the interactive accent')
})

test('the tab script follows the hash and the deep links', () => {
  const asset = new URL('../public/repoTabs.js', import.meta.url)
  assert.ok(existsSync(asset), 'public/repoTabs.js is missing')
  const source = readFileSync(asset, 'utf8')
  assert.match(source, /aria-current/, 'the tab script does not move aria-current')
  assert.match(source, /hashchange/, 'the tab script ignores back/forward and in-page links')
  assert.match(source, /querySelectorAll\('\[id\]'\)/, 'inner anchors that predate the tabs do not open their section')
  assert.match(source, /is-tabbed/, 'the tab script never collapses the sections')
  const rendered = renderRepo()
  try {
    assert.match(rendered.html, /<script src="\/assets\/repoTabs\.js" defer><\/script>/, 'the page does not load the tab script')
  } finally {
    rendered.close()
  }
})

test('the skip link does not steal the tab', () => {
  const tabs = runRepoTabs({ hash: '#work' })
  assert.equal(tabs.active(), 'work', 'a section deep link did not open its section')
  assert.equal(tabs.current(), '#work', 'the section deep link did not mark its tab')

  // The layout's "skip to content" link is a hash that belongs to no section.
  // Switching the visible section there would throw a keyboard reader out of
  // the tab they were on, so an unknown hash must change nothing.
  tabs.hash('#main')
  assert.equal(tabs.active(), 'work', 'the skip link threw the reader back to Overview')
  assert.equal(tabs.current(), '#work', 'the skip link moved the current tab')
  assert.deepEqual(tabs.scrolled(), [], 'the skip link scrolled the page')
})

test('an inner anchor still opens the section that holds it', () => {
  const tabs = runRepoTabs({ hash: '#overview' })
  tabs.hash('#board')
  assert.equal(tabs.active(), 'work', 'an inner deep link did not open the section that holds it')
  assert.equal(tabs.current(), '#work', 'an inner deep link did not move the current tab')
  assert.deepEqual(tabs.scrolled(), ['board'], 'the inner target was not scrolled to')
})

test('an inner anchor lands clear of the subnav band', () => {
  const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')
  const declaration = (selector: string, property: string): string => {
    const index = css.indexOf(`${selector} {`)
    assert.ok(index >= 0, `stylesheet has no ${selector} rule`)
    const body = css.slice(css.indexOf('{', index) + 1, css.indexOf('}', index))
    const match = body.match(new RegExp(`${property}:\\s*([^;]+);`))
    assert.ok(match !== null, `${selector} has no ${property}`)
    return (match[1] ?? '').trim()
  }

  const offset = declaration('.repo-page [id]', 'scroll-margin-top')
  assert.match(offset, /var\(--header-h\)/, 'an inner anchor no longer clears the header')
  assert.match(offset, /var\(--subnav-h\)/, 'an inner anchor does not clear the sticky subnav, so it lands under it')
  // The band and the offset read the same token, so tuning one cannot silently
  // leave the other behind.
  assert.match(declaration('.repo-subnav', 'min-height'), /var\(--subnav-h\)/, 'the subnav band no longer uses the shared height token')

  const tokens = new Map<string, string>()
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    const name = match[1] ?? ''
    if (!tokens.has(name)) tokens.set(name, (match[2] ?? '').trim())
  }
  const px = (expression: string, depth = 0): number => {
    assert.ok(depth < 6, `stylesheet token does not resolve: ${expression}`)
    const substituted = expression
      .replace(/var\(--([a-z0-9-]+)\)/g, (_whole, name: string) => {
        const value = tokens.get(name)
        assert.ok(value !== undefined, `stylesheet uses an undefined token --${name}`)
        return `(${px(value, depth + 1)})`
      })
      .replace(/calc/g, '')
      .replace(/[()]/g, '')
      .replace(/px/g, '')
    return substituted.split('+').reduce((sum, term) => {
      const product = term.split('*').reduce((acc, factor) => acc * Number(factor.trim()), 1)
      return sum + product
    }, 0)
  }

  const header = px(tokens.get('header-h') ?? '0px')
  const band = px(tokens.get('subnav-h') ?? '0px')
  // Test measured the band at 70-131px on 1280x800: 61px of chrome.
  assert.ok(band >= 61, `the subnav band is ${band}px, thinner than the 61px measured on 1280x800`)
  const inner = px(offset)
  assert.ok(inner >= header + band, `an inner anchor stops at ${inner}px, inside the ${header + band}px of chrome`)
  assert.ok(inner - (header + band) >= px(tokens.get('space-4') ?? '0px'), `an inner anchor lands ${inner - (header + band)}px below the band, less than one spacing step`)
})
