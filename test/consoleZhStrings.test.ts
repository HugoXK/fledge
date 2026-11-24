import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { adminNotificationsPage, adminWebhooksPage, jobPage, repoPage, scheduleConsolePage } from '../src/views/pages.js'
import { productPage } from '../src/views/product.js'
import { scheduleConsole } from '../src/schedules/console.js'
import type { ProductLoopSnapshot } from '../src/metrics/product.js'
import { makeTerminalJob, makeUser, testConfig } from './helpers.js'

// #1263: `translator` renders `zh` for every locale except `en`, so a `t(zh, en)`
// call whose two arguments are the same string shows its English text to the
// default reader. The card's six literals are 16 such call sites in
// `src/views/pages.ts` and `src/views/product.ts`. These cases render the six
// pages and read the text a reader would read — not the source — because the
// source-level guard is the separate checker card (#1239) and a second, greppier
// copy of it here would disagree with that one the day either changes.
//
// Every case renders both locales: the fix moves only the first argument, so the
// `en` render must keep the English words it printed at the base of this change.

const CJK = /[\u3400-\u9fff]/

/** The text a reader sees: tags removed, whitespace flattened. `data-*` sentinels live in tags and are not display. */
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
}

function fixture(locale: 'zh' | 'en', login: string): {
  store: Store
  repo: ReturnType<Store['createRepo']>
  job: NonNullable<ReturnType<Store['getJob']>>
  viewer: { user: NonNullable<ReturnType<Store['userById']>>; csrfToken: string }
} {
  const store = new Store(':memory:')
  const user = makeUser(store, { login, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${login}`,
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const job = makeTerminalJob(store, {
    id: `job_${login}`,
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'g',
    callbackHash: 'h',
    platformTokenHash: 't',
    kind: 'iterate',
    baseBranch: 'main',
  })
  // The evidence list is where `CI / checks` lives, so the job has to carry
  // structured evidence for that page to render it at all.
  store.updateJob(job.id, { evidence_json: JSON.stringify({ checks: 'ci-ok green' }) })
  return { store, repo, job: store.getJob(job.id)!, viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' } }
}

const emptyLoop: ProductLoopSnapshot = {
  windowEvents: 0,
  funnel: { connected: 0, firstJob: 0, firstPr: 0, merged: 0 },
  toFirstJob: { samples: 0, medianMs: null },
  toFirstPr: { samples: 0, medianMs: null },
  toMerge: { samples: 0, medianMs: null },
  rescue: { failed: 0, actions: 0, rate: null, mix: [] },
  returning: { repositories: 0, returned: 0 },
  evidence: { succeeded: 0, withPr: 0, withCost: 0, completeRate: null, completed: 0, unknownCost: 0, unknownCostRate: null },
  analyticsEnabled: true,
}

test('repoPage: the branch-protection fact reads in the reader\'s language', () => {
  for (const locale of ['zh', 'en'] as const) {
    const { store, repo, viewer } = fixture(locale, `repo-page-${locale}`)
    try {
      const text = textOf(repoPage({ config: testConfig(), locale, viewer, repo, jobs: [], prJobs: [] }))
      if (locale === 'zh') {
        assert.ok(text.includes('分支保护'), 'zh: the branch-protection fact is Chinese')
        assert.equal(text.includes('Branch protection'), false, 'zh: the page must not print the English label')
      } else {
        assert.ok(text.includes('Branch protection'), 'en: the English label is unchanged')
        assert.equal(text.includes('分支保护'), false, 'en: no Chinese leaks into the English page')
      }
    } finally {
      store.close()
    }
  }
})

test('jobPage: the checks row of the evidence list reads in the reader\'s language', () => {
  for (const locale of ['zh', 'en'] as const) {
    const { store, repo, job, viewer } = fixture(locale, `job-page-${locale}`)
    try {
      const text = textOf(jobPage({ config: testConfig(), locale, viewer, repo, job, events: [] }))
      if (locale === 'zh') {
        assert.ok(text.includes('CI / 检查'), 'zh: the checks row is Chinese')
        assert.equal(text.includes('CI / checks'), false, 'zh: the page must not print the English label')
      } else {
        assert.ok(text.includes('CI / checks'), 'en: the English label is unchanged')
        assert.equal(text.includes('CI / 检查'), false, 'en: no Chinese leaks into the English page')
      }
    } finally {
      store.close()
    }
  }
})

test('adminWebhooksPage: heading and title both read in the reader\'s language', () => {
  for (const locale of ['zh', 'en'] as const) {
    const { store, viewer } = fixture(locale, `webhooks-page-${locale}`)
    try {
      const text = textOf(adminWebhooksPage({
        config: testConfig(), locale, viewer,
        deliveries: [], filters: { status: '', event: '' }, page: 1, pages: 1, total: 0,
      }))
      if (locale === 'zh') {
        assert.equal(text.split('Webhook 投递').length - 1, 2, 'zh: the heading and the document title are both Chinese')
        assert.equal(text.includes('Webhook deliveries'), false, 'zh: neither the heading nor the title prints the English literal')
      } else {
        assert.equal(text.split('Webhook deliveries').length - 1, 2, 'en: the heading and the document title are unchanged')
        assert.equal(text.includes('Webhook 投递'), false, 'en: no Chinese leaks into the English page')
      }
    } finally {
      store.close()
    }
  }
})

test('adminNotificationsPage: heading and title both read in the reader\'s language', () => {
  for (const locale of ['zh', 'en'] as const) {
    const { store, viewer } = fixture(locale, `notifications-page-${locale}`)
    try {
      const text = textOf(adminNotificationsPage({
        config: testConfig(), locale, viewer,
        rows: [], counts: [], filters: { state: '', transport: '' }, page: 1, pages: 1, total: 0,
      }))
      if (locale === 'zh') {
        assert.equal(text.split('通知发件箱').length - 1, 2, 'zh: the heading and the document title are both Chinese')
        assert.equal(text.includes('Notification outbox'), false, 'zh: the document title must not print the English literal')
      } else {
        assert.equal(text.split('Notification outbox').length - 1, 2, 'en: the heading and the document title are unchanged')
        assert.equal(text.includes('通知发件箱'), false, 'en: no Chinese leaks into the English page')
      }
    } finally {
      store.close()
    }
  }
})

test('productPage: a missing rate and a missing percentage read in the reader\'s language', () => {
  // `n/a（还没有样本）` is a different, deliberate pair on the same page; the
  // assertions below are the two `n/a` cells this card owns, so they read the
  // rendered text around them instead of counting every `n/a` on the page.
  const render = (locale: 'zh' | 'en'): string => {
    const { store, viewer } = fixture(locale, `product-page-${locale}`)
    try {
      return textOf(productPage({
        config: testConfig(), locale, viewer, loop: emptyLoop, windowDays: 7, since: '2026-11-16',
        webhook: { configured: false, lastPushAt: null },
      }))
    } finally {
      store.close()
    }
  }

  const zh = render('zh')
  assert.ok(zh.includes('占 暂无；已结束任务里成本未知的占 暂无'), 'zh: both percentages of the completion sentence are Chinese')
  assert.ok(zh.includes('每个失败的救援数 0 0 暂无'), 'zh: the rescue cell is Chinese')
  assert.equal(zh.includes('n/a of succeeded jobs'), false, 'zh: the completion sentence does not print the English fallback')

  const en = render('en')
  assert.ok(en.includes('n/a of succeeded jobs carry both a pull request and a known cost; n/a of finished jobs have an unknown cost'), 'en: the completion sentence is unchanged')
  assert.ok(en.includes('Rescues per failure 0 0 n/a'), 'en: the rescue cell is unchanged')
  assert.equal(en.includes('暂无'), false, 'en: no Chinese leaks into the English page')
})

test('scheduleConsolePage: every null fact and the frozen card read in the reader\'s language', () => {
  const NOW = Date.parse('2026-11-23T00:00:00Z')
  const form = { cron: '', every: '', timezone: '', startAt: '', endAt: '', misfire: '', grace: '', dailyRuns: '' }

  /** `claimed` puts a decided instant on the page, which is what mounts the frozen card. */
  const render = (locale: 'zh' | 'en', claimed: boolean): string => {
    const { store, repo, viewer } = fixture(locale, `schedule-page-${locale}-${claimed ? 'claimed' : 'empty'}`)
    try {
      let row: ReturnType<Store['saveSchedule']> | undefined
      if (claimed) {
        row = store.saveSchedule({ id: `sch_${repo.id}`, repoId: repo.id, kind: 'interval', everyMs: 3_600_000 })
        // A null snapshot is the state this page has to print as unknown: the run
        // happened but recorded nothing, and borrowing today's row would be the
        // substitution the console must never make.
        store.claimScheduleOccurrence({
          id: `occ_${repo.id}`, scheduleId: row.id, repoId: repo.id, logicalTime: NOW,
          timingRevision: row.timing_revision, leaseToken: 'tok', leaseMs: 3_600_000, now: NOW, snapshotJson: null,
        })
      }
      const state = scheduleConsole({
        repoId: repo.id,
        row,
        repo,
        occurrences: claimed ? store.listScheduleOccurrences(repo.id, 10) : [],
        now: NOW,
        jobStatus: () => null,
        runsToday: 0,
      })
      const html = scheduleConsolePage({ config: testConfig(), locale, viewer, repo, state, role: 'maintainer', form, runNowKey: 'k' })
      return textOf(html)
    } finally {
      store.close()
    }
  }

  const zhEmpty = render('zh', false)
  assert.ok(
    zhEmpty.includes('排期 未知 状态 未知 下次运行 未知 上次成功 未知 最后决定 未知 租约 未知'),
    'zh: schedule, state, next run, last success, last decision and lease all read Chinese',
  )
  assert.ok(zhEmpty.includes('时序版本 未知 · 未知'), 'zh: timing revision and misfire are both Chinese')
  assert.equal(zhEmpty.includes('Schedule unknown State unknown'), false, 'zh: the facts never fall back to the English literal')

  const enEmpty = render('en', false)
  assert.ok(
    enEmpty.includes('Schedule unknown State unknown Next run unknown Last success unknown Last decision unknown Lease unknown'),
    'en: the same six facts are unchanged',
  )

  const zhClaimed = render('zh', true)
  assert.ok(
    zhClaimed.includes('类型 未知 表达式 未知 间隔 未知 时区 未知 有效期 未知 所有者 未知 安装 未知 权限 未知 角色 未知 时序版本 未知'),
    'zh: every frozen-card cell is Chinese when the run recorded nothing',
  )
  assert.equal(zhClaimed.includes('Kind unknown Expression unknown'), false, 'zh: the frozen card does not fall back to the English literal')

  const enClaimed = render('en', true)
  assert.ok(
    enClaimed.includes('Kind unknown Expression unknown Interval unknown Timezone unknown Window unknown Owner unknown Installation unknown Permission unknown Role unknown Revision unknown'),
    'en: every frozen-card cell is unchanged',
  )

  // A residual of the same class, deliberately not in this card's 16 and not
  // changed here: with no schedule row `runsToday` is null, and the daily-run
  // limit cell prints the mixed literal `今天已运行 unknown` (`pages.ts:6206`).
  // Changing it would be a seventh literal outside the reviewed census, so this
  // test pins it as it is and the PR names it.
  assert.ok(zhEmpty.includes('今天已运行 unknown'), 'zh: the daily-run residual is recorded, not silently asserted away')
  assert.ok(CJK.test(zhEmpty), 'zh: the page is otherwise Chinese')
})
