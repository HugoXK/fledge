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
  text: string
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
