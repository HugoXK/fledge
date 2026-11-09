import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { dashboardPage } from '../src/views/pages.js'
import { QuotaNotifier } from '../src/gateway/notifier.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'
import type { Locale } from '../src/i18n.js'

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
