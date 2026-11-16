import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { repoPage, type ScheduledNext } from '../src/views/pages.js'
import { makeTerminalJob, makeUser, testConfig } from './helpers.js'

// #802: the repository header printed "Auto every <interval>" next to "Automatic
// work". That interval never decided when work starts — work starts from ready
// items after the short cooldown (`src/jobs/service.ts` `workDue`), while the
// interval is the discovery cadence, floored at 60 minutes (`discoverDue`,
// `MIN_DISCOVERY_INTERVAL_MINUTES`). One pill claiming to be the work interval
// made the page say a repository runs once a day when it actually starts within
// 15 minutes of the last job. The pins below are the three readings that must
// hold: the discovery cadence is named as discovery, the floor is honoured, and
// a saved schedule stays the source of when a run happens.

type Rendered = { html: string; close: () => void }

function renderHeader(options: {
  locale?: 'en' | 'zh'
  intervalMinutes?: number
  autoIterate?: boolean
  scheduledNext?: ScheduledNext
} = {}): Rendered {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'cadence-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_cadence',
    userId: user.id,
    owner: 'acme',
    name: 'cadence',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: options.autoIterate ?? true,
    intervalMinutes: options.intervalMinutes ?? 1440,
  })
  const job = makeTerminalJob(store, {
    id: 'job_cadence',
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
    locale: options.locale ?? 'en',
    viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
    repo,
    jobs: [job],
    prJobs: [job],
    ...(options.scheduledNext === undefined ? {} : { scheduledNext: options.scheduledNext }),
  })
  return { html, close: () => store.close() }
}

// The header strip only, so a match cannot come from a form or a help tip far
// down the page: the strip is the element the defect is about.
function strip(html: string): string {
  const match = /<div class="repo-status-strip">([\s\S]*?)<\/div>/.exec(html)
  assert.ok(match, 'the repository header has no status strip')
  return match[1] ?? ''
}

const stripText = (html: string): string => strip(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

test('the header names the discovery cadence instead of claiming a work interval', () => {
  const rendered = renderHeader()
  try {
    const text = stripText(rendered.html)
    assert.doesNotMatch(text, /Auto every/, 'the header still says "Auto every"')
    assert.match(text, /Discovery every/, 'the header does not name a discovery cadence')
    assert.match(text, /Daily/, 'the header does not print the saved interval')
  } finally {
    rendered.close()
  }
})

test('a stored interval below the discovery floor is reported at the floor', () => {
  const rendered = renderHeader({ intervalMinutes: 30 })
  try {
    const text = stripText(rendered.html)
    assert.match(text, /Hourly/, 'discovery runs hourly at a 30-minute row, and the header says otherwise')
    assert.doesNotMatch(text, /Every 30 minutes/, 'the header repeats a cadence discovery never uses')
  } finally {
    rendered.close()
  }
})

test('a saved schedule stays the source of when a run happens', () => {
  const at = Date.now() + 3 * 60 * 60 * 1000
  const rendered = renderHeader({ scheduledNext: { kind: 'cron', at } })
  try {
    const header = strip(rendered.html)
    assert.match(header, /data-next-source="schedule"/, 'the next-run pill does not name the schedule as its source')
    // The discovery cadence is still printed, because discovery still runs off
    // it with a schedule saved; what must not happen is the interval being read
    // as the work cadence.
    assert.match(stripText(rendered.html), /Discovery every/)
    assert.doesNotMatch(stripText(rendered.html), /Auto every/)
  } finally {
    rendered.close()
  }
})

test('a repository without a schedule reads its next run from the interval rule', () => {
  const rendered = renderHeader()
  try {
    assert.match(strip(rendered.html), /data-next-source="interval"/)
  } finally {
    rendered.close()
  }
})

test('automatic work stays its own on/off answer, apart from the cadence', () => {
  const on = renderHeader({ intervalMinutes: 1440 })
  try {
    const text = stripText(on.html)
    assert.match(text, /Automatic work/)
    assert.match(text, /Auto-iteration on/)
  } finally {
    on.close()
  }
  const off = renderHeader({ autoIterate: false })
  try {
    assert.match(stripText(off.html), /Manual runs only/)
  } finally {
    off.close()
  }
})

test('the Chinese header reads 发现间隔 and never 自动间隔', () => {
  const rendered = renderHeader({ locale: 'zh' })
  try {
    const text = stripText(rendered.html)
    assert.match(text, /发现间隔/)
    assert.match(text, /每天/)
    assert.doesNotMatch(text, /自动间隔/)
    assert.doesNotMatch(text, /自动迭代已开启.*自动间隔/)
  } finally {
    rendered.close()
  }
})

test('the relabel keeps the anchors and the interval field the page already had', () => {
  const rendered = renderHeader()
  try {
    for (const anchor of ['#work', '#settings', '#danger']) {
      assert.match(rendered.html, new RegExp(`id="${anchor.slice(1)}"`), `the page lost the ${anchor} anchor`)
    }
    assert.match(rendered.html, /<select name="interval"/, 'the settings form lost its interval field')
    assert.match(rendered.html, /\/repos\/repo_cadence\/schedule/, 'the schedule console link is gone')
  } finally {
    rendered.close()
  }
})
