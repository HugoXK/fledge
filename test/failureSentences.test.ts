import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { makeUser, testConfig } from './helpers.js'
import { ENQUEUE_REFUSAL_CODES, FAILURE_CODES, FAILURES, failureLabel, failureSentence } from '../src/lib/failure.js'
import type { FailureKind } from '../src/lib/failure.js'
import { jobPage } from '../src/views/pages.js'
import type { Locale } from '../src/i18n.js'

// #988: #228 removed the machinery words from the pages a signed-in user
// reaches, but the dictionary those same pages render *after an action* — a
// refused start, a failed job — still said "FlyBot instance" and "DSH". A
// maintainer reads the workspace, so every sentence this dictionary can put on
// a page names the workspace instead. The codes, the actions and the audit
// rows are unchanged: this is copy only.
const MACHINERY: Record<Locale, RegExp> = {
  zh: /FlyBot|DSH|实例/,
  en: /FlyBot|DSH|\binstance\b/i,
}

function pick(locale: Locale): (zh: string, en: string) => string {
  return (zh, en) => (locale === 'zh' ? zh : en)
}

test('every refusal and failure sentence names the workspace, not the machinery', () => {
  const locales: Locale[] = ['zh', 'en']
  for (const locale of locales) {
    for (const code of [...ENQUEUE_REFUSAL_CODES, ...FAILURE_CODES]) {
      const sentence = failureSentence(pick(locale), code)
      // A code without a sentence has no copy to check; the ones that do are
      // the whole dictionary surface for this sweep.
      if (sentence === null) continue
      assert.doesNotMatch(sentence, MACHINERY[locale], `${code} (${locale}) still names the machinery: ${sentence}`)
    }
  }
})

test('every failure label and hint names the workspace, not the machinery', () => {
  const kinds = Object.keys(FAILURES) as FailureKind[]
  for (const locale of ['zh', 'en'] as const) {
    for (const kind of kinds) {
      const info = FAILURES[kind]
      const label = info.label[locale === 'zh' ? 0 : 1]
      const hint = info.hint[locale === 'zh' ? 0 : 1]
      const shown = failureLabel(pick(locale), kind)
      assert.equal(shown, label, `${kind} (${locale}) must render its dictionary label`)
      assert.doesNotMatch(label, MACHINERY[locale], `${kind} (${locale}) label still names the machinery: ${label}`)
      assert.doesNotMatch(hint, MACHINERY[locale], `${kind} (${locale}) hint still names the machinery: ${hint}`)
    }
  }
})

function visibleText(html: string): string {
  return html
    .replace(/<footer[\s\S]*?<\/footer>/g, '\n')
    .replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, '\n')
    .replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '\n')
}

test('the rendered job page carries the workspace wording in both locales', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'failure-page-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_failure_page',
      userId: user.id,
      owner: 'o',
      name: 'fp',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const job = store.createJob({ id: 'job_failure_page', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    store.updateJob(job.id, { status: 'failed', error: 'bridge unreachable', error_code: 'BRIDGE_ERROR' })
    const stored = store.getJob(job.id)!
    for (const locale of ['en', 'zh'] as const) {
      const page = jobPage({
        config,
        locale,
        viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
        repo,
        job: stored,
      })
      const text = visibleText(page)
      assert.doesNotMatch(text, MACHINERY[locale], `the ${locale} job page still names the machinery`)
      assert.match(text, locale === 'en' ? /workspace/i : /工作区/, `the ${locale} job page must name the workspace`)
    }
  } finally {
    store.close()
  }
})
