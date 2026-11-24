import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { Store } from '../src/db.js'
import { dashboardPage, repoPage } from '../src/views/pages.js'
import type { ClockState } from '../src/repos/app.js'
import { makeTerminalJob, makeUser, testConfig } from './helpers.js'

// #1255: the repository page is where work starts — the Run now button and the
// next-run line — and it was the one page that said nothing while the admission
// guard refused every enqueue. `#1198` shipped the banner on the dashboard and
// `#758` slice 2 shipped the refusal; the two never met here, so a user read a
// promised time, pressed Run now, and learned about the platform clock only from
// the redirect's `?error=`.
//
// The fix is one input and one component: the page reads `githubApp.clockState()`
// the way the dashboard does, and renders the same banner rather than a second
// sentence about the same fact. The assertions below pin both halves — the fail
// state paints the dashboard's banner, and a healthy or absent clock keeps the
// page byte-identical, so the page cannot grow its own wording later.

const failing: ClockState = {
  state: 'fail',
  skewSeconds: 1686,
  measuredAt: '2026-11-23T21:25:43.933Z',
  thresholdSeconds: 120,
}

// #1300: one literal instant, used for both stamps and asserted on the page.
// The old fixture built a fresh store per render, so the job carried a
// wall-clock `created_at` read at call time and the two pages could differ by
// one second when a boundary fell between them. The page is now a function of
// the record: every render below reads one job that was built once with these
// stamps, and the rendered line is the literal below, not "now".
const FIXED_AT = '2026-11-23T21:25:43.500Z'
const FIXED_LABEL = '2026-11-23 21:25:43 UTC'

function makeRepoFixture(): { store: Store; render: (clock?: ClockState) => string } {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'clock-repo-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_clock',
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: true,
    intervalMinutes: 1440,
  })
  const job = makeTerminalJob(store, {
    id: 'job_clock',
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: 'h',
    platformTokenHash: 't',
    kind: 'iterate',
    baseBranch: 'main',
    createdAt: FIXED_AT,
  }, { finishedAt: FIXED_AT })
  const render = (clock?: ClockState): string => repoPage({
    config,
    locale: 'en',
    viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
    repo,
    jobs: [job],
    prJobs: [job],
    ...(clock === undefined ? {} : { clock }),
  })
  return { store, render }
}

// #1300: one store and one job for the whole file, so `renderRepo` can keep the
// call shape these tests already had. The record is the fixture; the wall clock
// is no longer an input to any assertion here.
const repoFixture = makeRepoFixture()
after(() => repoFixture.store.close())

function renderRepo(clock?: ClockState): string {
  return repoFixture.render(clock)
}

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

test('a failing clock paints the dashboard banner on the repository page, above the sections', () => {
  const html = renderRepo(failing)
  const banners = html.match(/id="clock-fail"/g) ?? []
  assert.equal(banners.length, 1, `expected exactly one clock banner on the repository page, rendering it ${banners.length} times`)
  const opening = html.match(/<div class="banner bad" id="clock-fail"[^>]*>/)?.[0] ?? ''
  assert.match(opening, /role="alert"/, 'the banner announces itself')
  const text = textOf(html)
  assert.ok(text.includes('1686'), 'the banner names the measured offset')
  assert.ok(text.includes('120'), 'the banner names the threshold')
  assert.ok(text.includes('timedatectl set-ntp true'), 'the banner carries the recovery command')
  // Visible on load: the page's own sections, not a collapsed detail, follow it.
  const banner = html.indexOf('id="clock-fail"')
  const sections = html.indexOf('class="repo-subnav"')
  assert.ok(banner > 0 && sections > 0, 'the banner and the section nav both render')
  assert.ok(banner < sections, 'the banner sits above the sections, not inside one')
})

test('the repository page is unchanged for an ok clock and for no reading at all', () => {
  const ok: ClockState = { state: 'ok', skewSeconds: 3, measuredAt: '2026-11-23T21:25:43.933Z', thresholdSeconds: 120 }
  assert.equal(renderRepo(ok).includes('id="clock-fail"'), false, 'an ok clock paints nothing')
  assert.equal(renderRepo(undefined).includes('id="clock-fail"'), false, 'no reading paints nothing')
  assert.equal(renderRepo(ok), renderRepo(undefined), 'an ok clock renders exactly like an absent one')
  assert.ok(textOf(renderRepo(ok)).includes(FIXED_LABEL), `the page renders the stored instant ${FIXED_LABEL}, not the wall clock`)
})

test('both pages render the same banner markup and sentence for the same clock', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'clock-both', status: 'approved' })
    const dashboard = dashboardPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user, csrfToken: 'csrf' },
      repos: [],
      jobs: [],
      notifications: [],
      clock: failing,
    })
    const bannerOf = (html: string): string => html.match(/<div class="banner bad" id="clock-fail"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? ''
    const fromDashboard = bannerOf(dashboard)
    const fromRepo = bannerOf(renderRepo(failing))
    assert.notEqual(fromDashboard, '', 'the dashboard still carries the banner')
    assert.equal(fromRepo, fromDashboard, 'one wording, one component: the two pages cannot drift apart')
  } finally {
    store.close()
  }
})
