import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { layout } from '../src/views/layout.js'
import { dashboardPage } from '../src/views/pages.js'
import type { Locale } from '../src/i18n.js'
import { makeUser, testConfig } from './helpers.js'
import { runApp } from './stubDom.js'

// #472: a page could carry a failure, an informational notice, three page
// banners and the inbox at the same time. The failure was rendered after the
// notice, each message was its own live region, and nothing could be dismissed,
// so a failure could sit below a "saved" line and a stale message survived a
// reload. The page now renders one stack, ordered by severity, announced by one
// polite region, with one dismiss control per message.

const cssText = (): string => readFileSync(new URL('../public/app.css', import.meta.url), 'utf8')

interface Entry {
  level: 'error' | 'warning' | 'success' | 'info'
  text?: string
  html?: string
  key?: string
}

// The stack builder is the unit that orders and de-duplicates, so it is called
// directly; the page tests below prove `layout()` routes both messages into it.
async function stackFor(entries: Entry[], locale: Locale = 'en'): Promise<string> {
  const module = (await import('../src/views/layout.js')) as unknown as Record<string, unknown>
  const builder = module.notificationStack
  assert.equal(typeof builder, 'function', 'src/views/layout.ts must export notificationStack(locale, entries)')
  return (builder as (locale: Locale, entries: Entry[]) => string)(locale, entries)
}

function page(locale: Locale, options: { notice?: string; error?: string; body?: string } = {}): string {
  return layout({
    title: 'x',
    viewer: null,
    body: options.body ?? '',
    config: testConfig(),
    locale,
    path: '/dashboard',
    notice: options.notice,
    error: options.error,
  })
}

function mainOf(html: string): string {
  const match = /<main class="wrap" id="main">([\s\S]*?)<\/main>/.exec(html)
  assert.ok(match !== null, 'the page has no main element')
  return match[1] ?? ''
}

function stackOf(html: string): string {
  const match = /<section class="banner-stack"([^>]*)>([\s\S]*?)<\/section>/.exec(html)
  assert.ok(match !== null, 'the page has no notification stack')
  return match[0] ?? ''
}

test('an error renders above an informational notice, inside the one live region', () => {
  const html = page('en', { error: 'Saving the repository failed.', notice: 'Repository saved.' })
  const main = mainOf(html)
  const stack = stackOf(main)

  const open = /<section class="banner-stack"([^>]*)>/.exec(stack)?.[1] ?? ''
  assert.match(open, /aria-live="polite"/, `the stack is not a polite live region: ${open}`)
  assert.equal(main.match(/aria-live="polite"/g)?.length, 1, 'the notices must not add a second live region')

  const failure = stack.indexOf('Saving the repository failed.')
  const saved = stack.indexOf('Repository saved.')
  assert.notEqual(failure, -1, 'the failure is not in the stack')
  assert.notEqual(saved, -1, 'the notice is not in the stack')
  assert.ok(failure < saved, 'the failure must render above the informational notice')

  assert.equal(stack.match(/data-dismiss/g)?.length, 2, 'every message needs its own dismiss control')
  assert.doesNotMatch(stack, /role="alert"/, 'the failure must not claim its own assertive region')
  assert.doesNotMatch(stack, /role="status"/, 'the notice must not claim its own live region')
})

test('the dismiss control is translated in both locales', () => {
  const en = stackOf(mainOf(page('en', { notice: 'Saved.' })))
  assert.match(en, /aria-label="Dismiss message"/)

  const zh = stackOf(mainOf(page('zh', { notice: '已保存。' })))
  assert.match(zh, /aria-label="关闭消息"/)
})

test('dismissing one message hides that message alone', () => {
  const harness = runApp({ dismiss: 2 })
  harness.clickDismiss(0)

  assert.equal(harness.messageHidden(0), true, 'the dismissed message must be hidden')
  assert.equal(harness.messageHidden(1), false, 'dismissing one message hid another')
  assert.equal(harness.removedMessages(), 0, 'dismiss must hide the node, not delete it')
})

test('the same key renders once, and the failure wins the key', async () => {
  const stack = await stackFor([
    { level: 'success', text: 'Repository saved.', key: 'repo-saved' },
    { level: 'error', text: 'Repository saved.', key: 'repo-saved' },
    { level: 'info', text: 'Queued.' },
  ])

  assert.equal(stack.match(/Repository saved\./g)?.length, 1, 'a duplicated key rendered twice')
  assert.match(stack, /class="banner bad"/, 'the surviving message must keep the error severity')
  assert.ok(stack.indexOf('Repository saved.') < stack.indexOf('Queued.'), 'the error must stay above the info line')
})

test('a warning renders as its own variant, above success and below errors', async () => {
  const stack = await stackFor([
    { level: 'success', text: 'Saved.' },
    { level: 'warning', text: 'Two jobs were skipped.' },
    { level: 'error', text: 'Sending failed.' },
  ])
  assert.ok(stack.indexOf('Sending failed.') < stack.indexOf('Two jobs were skipped.'), 'a warning must follow an error')
  assert.ok(stack.indexOf('Two jobs were skipped.') < stack.indexOf('Saved.'), 'a warning must precede success')
  assert.match(stack, /class="banner warn"/, 'a warning has no banner warn class')

  const css = cssText()
  assert.match(css, /(?:^|\n)\.banner\.warn \{/, 'public/app.css has no .banner.warn rule')
  assert.match(css, /(?:^|\n)\.banner-stack \{/, 'public/app.css has no .banner-stack rule')
  assert.match(css, /(?:^|\n)\.banner\[hidden\] \{/, 'a dismissed message needs an explicit hidden rule')
})

test('the inbox stays out of the stack', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'stack-inbox', status: 'approved' })
    store.notify(user.id, 'job', 'job job_1 finished')
    const html = dashboardPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repos: [],
      jobs: [],
      notifications: store.listNotifications(user.id),
      notice: 'Repository saved.',
    })
    const main = mainOf(html)
    const stack = stackOf(main)

    assert.doesNotMatch(stack, /class="card notices"/, 'the inbox card was folded into the notification stack')
    assert.doesNotMatch(stack, /id="inbox"/, 'the inbox was folded into the notification stack')
    assert.match(main, /class="card notices"/, 'the inbox card must still render on the page')
    assert.ok(main.indexOf(stack) < main.indexOf('class="card notices"'), 'the stack comes first, the inbox stays separate')
  } finally {
    store.close()
  }
})

test('a page with no message renders no empty stack', () => {
  assert.doesNotMatch(page('en'), /banner-stack/)
})

// #472 slice 3: page-level messages join the one stack instead of being a
// second ad-hoc banner elsewhere on the page. `notifications` is the page's own
// list; it is ordered and de-duplicated with the redirect message by the same
// builder, so a page cannot classify a message twice.
function pageWith(locale: Locale, notifications: Entry[], options: { notice?: string; error?: string; body?: string } = {}): string {
  return layout({
    title: 'x',
    viewer: null,
    body: options.body ?? '',
    config: testConfig(),
    locale,
    path: '/dashboard',
    notice: options.notice,
    error: options.error,
    notifications,
  })
}

test('a page-level message joins the stack and sorts with the redirect message', () => {
  const html = pageWith('en', [
    { level: 'info', text: 'A repository has no instance yet.', key: 'instance-missing' },
    { level: 'error', text: 'The FlyBot instance failed.', key: 'instance-failed' },
  ], { notice: 'Repository saved.' })
  const main = mainOf(html)
  const stack = stackOf(main)
  assert.equal(main.match(/aria-live="polite"/g)?.length, 1, 'a page message added a second live region')
  // The stack's documented order is failure, warning, success, information, so a
  // page's own information entry sorts below the redirect's success message.
  assert.ok(stack.indexOf('The FlyBot instance failed.') < stack.indexOf('Repository saved.'))
  assert.ok(stack.indexOf('Repository saved.') < stack.indexOf('A repository has no instance yet.'))
  assert.equal(stack.match(/data-dismiss/g)?.length, 3, 'every message, including a page-level one, needs a dismiss control')
})

test('a page message built with html keeps its structure and still travels through the stack', () => {
  const stack = stackOf(mainOf(pageWith('en', [
    { level: 'error', html: '<strong>Current state</strong><ul><li>Repository disabled</li></ul><div class="row"><a class="btn" href="#x">Enable</a></div>', key: 'lifecycle' },
  ])))
  assert.match(stack, /<strong>Current state<\/strong>/)
  assert.match(stack, /<li>Repository disabled<\/li>/)
  assert.match(stack, /<a class="btn" href="#x">Enable<\/a>/)
  assert.match(stack, /data-dismiss/)
})

test('a page message and the redirect message sharing a key render once at the worse severity', () => {
  // A page entry without an explicit key is keyed by its text, the same seam a
  // redirect message uses, so the same sentence from both paths renders once and
  // keeps the failure the redirect knew about.
  const stack = stackOf(mainOf(pageWith('en', [
    { level: 'success', text: 'Repository saved.' },
  ], { error: 'Repository saved.' })))
  assert.equal(stack.match(/Repository saved\./g)?.length, 1, 'the same event rendered twice')
  assert.match(stack, /class="banner bad"/, 'the page entry must not downgrade the redirect failure')
})

test('the exhausted-quota banner is a stack message, not a second banner outside it', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'stack-quota', status: 'approved', quota: 0 })
    const html = dashboardPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repos: [],
      jobs: [],
      notifications: [],
    })
    const main = mainOf(html)
    const stack = stackOf(main)
    // The dashboard's next-action card also says the quota is used up; only the
    // banner sentence counts, and it must exist exactly once, inside the stack.
    const banner = /Platform quota is used up\. Add your own model API in Settings/g
    assert.match(stack, banner)
    assert.equal(main.match(banner)?.length, 1, 'the quota banner rendered outside the stack as well')
  } finally {
    store.close()
  }
})

test('an add-repository failure stays in its form and does not also render in the stack', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'stack-add', status: 'approved' })
    const marker = 'ADD-REPO-MARKER-472'
    const html = dashboardPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repos: [],
      jobs: [],
      notifications: [],
      error: marker,
    })
    const main = mainOf(html)
    assert.equal(main.match(new RegExp(marker, 'g'))?.length, 1, 'the form error rendered twice, in the form and in the stack')
    assert.match(main, /id="add-repo"[\s\S]*ADD-REPO-MARKER-472/, 'the failure must stay in the add-repository dialog')
  } finally {
    store.close()
  }
})

test('an add-repository refusal lands on the page with its dialog open', async () => {
  const { buildApp } = await import('../src/app.js')
  const { MockRunner } = await import('../src/jobs/mock.js')
  const { MemoryMailer, flashOf, formBody, sessionFor } = await import('./helpers.js')
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'stack-add-redirect', status: 'approved' })
    const { csrf, cookie } = sessionFor(built, user)
    // An empty token fails before any GitHub call, so this exercises the
    // dashboard error redirect without a fake API.
    const refused = await built.app.inject({
      method: 'POST',
      url: '/repos',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf, repo: 'octo/demo', goal: 'demo' }),
    })
    assert.equal(refused.statusCode, 302)
    // The failure is rendered inside `#add-repo` only (the stack test above pins
    // that), so the landing page has to open that dialog: a closed dialog hides
    // the one sentence the refusal wrote.
    assert.equal(refused.headers.location, '/dashboard#add-repo', 'the refusal lands on a page whose dialog stays closed')
    assert.equal(flashOf(refused)?.error?.text, '请填写 GitHub token')
    // The two "App is not configured" exits reach the same dialog-only slot, so
    // they carry the same deep link.
    const noAppGet = await built.app.inject({ method: 'GET', url: '/repos/new', headers: { cookie } })
    assert.equal(noAppGet.statusCode, 302)
    assert.equal(noAppGet.headers.location, '/dashboard#add-repo')
    const noAppPost = await built.app.inject({
      method: 'POST',
      url: '/repos/app',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(noAppPost.statusCode, 302)
    assert.equal(noAppPost.headers.location, '/dashboard#add-repo')
  } finally {
    await built.app.close()
    store.close()
  }
})
