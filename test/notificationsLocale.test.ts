import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { dashboardPage } from '../src/views/pages.js'
import { QuotaNotifier } from '../src/gateway/notifier.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'
import type { Locale } from '../src/i18n.js'
import { LOCALES, NOTIFICATION_TEMPLATES, localizeNotification } from '../src/i18n.js'

// The console is bilingual but a notification is written as a finished sentence
// by whatever code produced the event, so the row used to render in the writer's
// language: an English dashboard showed 额度已用完 and a Chinese one showed
// "PR … has been open for 49h". These cases pin both directions at the read
// path, plus the fallback for a row no template knows.

const CJK = /[\u3400-\u9fff]/

function render(store: Store, userId: string, locale: Locale): string {
  return dashboardPage({
    config: testConfig(),
    locale,
    viewer: { user: store.userById(userId)!, csrfToken: 'csrf' },
    repos: [],
    jobs: [],
    notifications: store.listNotifications(userId),
  })
}

function noticeRow(html: string): string {
  return /<div class="notice"><span>(.*?)<\/span>/.exec(html)?.[1] ?? ''
}

test('a quota notice written in Chinese renders in English on an English dashboard', async () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'notice-quota', status: 'approved' })
    await new QuotaNotifier(store, new MemoryMailer(), testConfig()).notify(store.userById(user.id)!)

    const en = render(store, user.id, 'en')
    assert.match(noticeRow(en), /Platform quota is used up/i)
    assert.equal(CJK.test(noticeRow(en)), false, `the English notice row must not contain CJK: ${noticeRow(en)}`)

    const zh = render(store, user.id, 'zh')
    assert.match(noticeRow(zh), /平台额度已用完/)
  } finally {
    store.close()
  }
})

test('an ops alert written in English renders in Chinese on a Chinese dashboard', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'notice-ops', status: 'approved' })
    store.notify(user.id, 'ops', 'PR https://github.com/o/r/pull/7 has been open for 49h')

    const zh = render(store, user.id, 'zh')
    assert.match(noticeRow(zh), /已开启 49 小时/)
    assert.equal(noticeRow(zh).includes('has been open for'), false, `the Chinese notice row must not keep the English sentence: ${noticeRow(zh)}`)

    const en = render(store, user.id, 'en')
    assert.match(noticeRow(en), /has been open for 49h/)
  } finally {
    store.close()
  }
})

test('a stalled-job alert renders in the reader language in both directions', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'notice-stalled', status: 'approved' })
    store.notify(user.id, 'ops', 'job job_9 has no callback for 49m')

    const zh = render(store, user.id, 'zh')
    assert.match(noticeRow(zh), /任务 job_9 已有 49 分钟没有回报/)
    assert.equal(CJK.test(noticeRow(render(store, user.id, 'en'))), false)

    store.notify(user.id, 'job', '任务 job_1 失败：模型超时')
    const en = render(store, user.id, 'en')
    assert.match(en, /The job job_1 failed: 模型超时/)
  } finally {
    store.close()
  }
})

test('a stage-evidence notice renders in English for every job kind', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'notice-stage', status: 'approved' })
    // The writer interpolates `${job.kind}`, and checkStage blocks scope and
    // verify as well as iterate and review, so every kind has to be localised.
    store.notify(user.id, 'job', 'scope 任务 job_3 缺少阶段证据：缺少范围（evidence.scope）')
    store.notify(user.id, 'job', 'verify 任务 job_4 缺少阶段证据：缺少失败测试证据（evidence.testRed）')
    store.notify(user.id, 'job', 'iterate 任务 job_5 缺少阶段证据：缺少验收标准（evidence.acceptance）')

    const en = render(store, user.id, 'en')
    assert.ok(en.includes('The scope job job_3 is missing stage evidence: 缺少范围'), `the scope notice must be English: ${en}`)
    assert.ok(en.includes('The verify job job_4 is missing stage evidence: 缺少失败测试证据'), `the verify notice must be English: ${en}`)
    assert.ok(en.includes('The iterate job job_5 is missing stage evidence: 缺少验收标准'), `the iterate notice must be English: ${en}`)
    assert.equal(/[a-z]+ 任务 job_\d 缺少阶段证据/.test(en), false, `no stage-evidence template may survive in English: ${en}`)

    const zh = render(store, user.id, 'zh')
    assert.ok(zh.includes('scope 任务 job_3 缺少阶段证据：缺少范围'), `a Chinese console keeps the stored row: ${zh}`)
  } finally {
    store.close()
  }
})

test('an inventory-issue notice renders in English on an English dashboard', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'notice-inventory', status: 'approved' })
    // #417: `src/jobs/service.ts` writes this sentence when a job's issue is
    // classified as inventory/cleanup work. No template knew it, so an English
    // console showed the raw Chinese line and could not act on it.
    store.notify(user.id, 'job', '任务 job_1 产出的是盘点/清账类 issue，不计为产品产出；请改为具体问题。')

    const en = render(store, user.id, 'en')
    assert.equal(CJK.test(noticeRow(en)), false, `the English notice row must not contain CJK: ${noticeRow(en)}`)
    assert.match(noticeRow(en), /inventory|cleanup/i)
    assert.match(noticeRow(en), /job_1/)
    assert.match(noticeRow(en), /concrete problem/i)

    const zh = render(store, user.id, 'zh')
    assert.match(noticeRow(zh), /盘点\/清账类 issue/)
  } finally {
    store.close()
  }
})

test('every localisation row is pinned by a sample in both directions', () => {
  const samples: ReadonlyArray<readonly [Locale, string, string]> = [
    ['en', '@alice 的 GitHub token 权限不足，自动迭代已暂停；请重新授权后手动开启。', "@alice: the GitHub token is missing permissions, so auto-iteration is paused. Re-authorize GitHub and start it again manually."],
    ['en', '审核 job_1 启动失败：模型超时', 'The review job job_1 failed to start: 模型超时'],
    ['en', '任务 job_2 失败：模型超时', 'The job job_2 failed: 模型超时'],
    ['en', 'scope 任务 job_3 缺少阶段证据：缺少范围（evidence.scope）', 'The scope job job_3 is missing stage evidence: 缺少范围（evidence.scope）'],
    ['en', '任务 job_4 成本 12.5 元，超过单任务预算 10 元。', 'Job job_4 cost 12.5 CNY, over its 10 CNY single-job budget.'],
    ['en', '任务 job_5 属于临时失败，将在约 5 分钟后自动重试。', 'Job job_5 hit a temporary failure; it will retry automatically in about 5 minutes.'],
    ['en', '任务 job_6 的 PR 改动了受保护路径，已阻止合并：src/auth/x.ts', 'The PR for job job_6 changed protected paths, so the merge was blocked: src/auth/x.ts'],
    ['en', '任务 job_16 的 PR 改动的文件列表不完整，无法确认路径约束，已阻止合并：incomplete changed-file list: checked 3000 of 3100', 'The PR for job job_16 has an incomplete changed-file list, so the path constraint could not be confirmed and the merge was blocked: incomplete changed-file list: checked 3000 of 3100'],
    ['en', '任务 job_17 改动的文件列表不完整，无法确认路径约束：incomplete changed-file list: checked 3000', 'Job job_17 has an incomplete changed-file list, so the path constraint could not be confirmed: incomplete changed-file list: checked 3000'],
    ['en', '任务 job_7 改动了受保护路径：src/auth/x.ts', 'Job job_7 changed protected paths: src/auth/x.ts'],
    ['en', '任务 job_18 产出的是盘点/清账类 issue，不计为产品产出；请改为具体问题。', 'Job job_18 produced an inventory/cleanup issue, which does not count as product output. Replace it with a concrete problem.'],
    ['en', 'alice 连续 3 个任务失败，自动迭代已暂停；请检查 bridge、GitHub 凭据和模型额度后手动重新开启。', 'alice failed 3 jobs in a row, so auto-iteration is paused. Check the bridge, the GitHub credential and the model quota, then start it again manually.'],
    ['en', 'alice 的本次任务只有 Lead 参与，其他团队角色没有实际介入。', 'Only the Lead took part in this job for alice; no other team role was involved.'],
    ['en', 'alice 团队提问：继续吗', 'alice team question: 继续吗'],
    ['en', '平台额度已用完，请到 Settings → Model 配置你自己的模型 API。后重试。', 'Platform quota is used up. Configure your own model API in Settings → Model.'],
    ['en', '平台额度已用完，请在 Settings → Model 配置自己的模型 API。', 'Platform quota is used up. Configure your own model API in Settings → Model.'],
    ['zh', 'The scope job job_3 is missing stage evidence: 缺少范围（evidence.scope）', 'scope 任务 job_3 缺少阶段证据：缺少范围（evidence.scope）'],
    ['zh', 'job job_9 has no callback for 49m', '任务 job_9 已有 49 分钟没有回报。'],
    ['zh', 'PR https://github.com/o/r/pull/7 has been open for 49h', 'PR https://github.com/o/r/pull/7 已开启 49 小时。'],
    ['zh', 'alice: GitHub credential is expired', 'alice：GitHub 凭据状态为 expired。'],
    ['zh', 'alice: spent 12.5 of 100 CNY in 30 days', 'alice：30 天已花费 12.5 / 100 元。'],
  ]

  for (const [locale, stored, expected] of samples) {
    assert.equal(localizeNotification(locale, stored), expected, `${locale} template drifted for: ${stored}`)
  }

  // A row with no sample would ship untested, so a new template fails here.
  for (const locale of LOCALES) {
    for (const [pattern] of NOTIFICATION_TEMPLATES[locale]) {
      assert.ok(
        samples.some(([sampleLocale, stored]) => sampleLocale === locale && pattern.test(stored)),
        `the ${locale} row ${String(pattern)} has no sample`,
      )
    }
  }
})

test('a notice no template knows renders verbatim in both locales', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'notice-verbatim', status: 'approved' })
    store.notify(user.id, 'job', 'plain note without a template')
    assert.match(noticeRow(render(store, user.id, 'en')), /plain note without a template/)
    assert.match(noticeRow(render(store, user.id, 'zh')), /plain note without a template/)
  } finally {
    store.close()
  }
})
