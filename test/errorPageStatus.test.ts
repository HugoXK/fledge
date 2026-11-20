// #469: the error page has to say what happened and what the viewer can do
// next. Today it renders a title, a sentence and "Back home" only, so a 404 and
// a 500 look alike and neither offers the viewer a way forward. The page takes
// the status the route already replied with, shows it, and picks the recovery
// action from the viewer: a signed-in person goes back to the console, an
// anonymous one signs in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { errorPage } from '../src/views/pages.js'
import { MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'

const TITLE = '页面不存在'
const MESSAGE = '你访问的页面不存在。'

// The header and the footer link to sign-in and to the console on every page, so
// a recovery assertion has to read the action block, not the whole document.
function actionBlock(html: string): string {
  const match = /<div class="actions">([\s\S]*?)<\/div>/.exec(html)
  assert.ok(match !== null, 'the page has an action block')
  return match[1] ?? ''
}

test('a 404 error page shows the status the route replied with', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const viewer = { user: makeUser(store), csrfToken: 'csrf' }
  const zh = errorPage(config, viewer, 404, TITLE, MESSAGE, 'zh')
  // The code is visible, not only in the header: a reader who lands here from a
  // stale link needs to know it is a missing page and not an outage.
  assert.match(zh, /data-status="404"/, 'the page carries the replied status')
  assert.match(zh, /class="eyebrow[^"]*">[^<]*404/, 'the status is shown above the title')
  assert.match(zh, /<title>[^<]*404/, 'the browser tab carries the status too')
  assert.match(zh, /<h1>页面不存在<\/h1>/)
})

test('the recovery action follows the viewer, not the status alone', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const viewer = { user: makeUser(store), csrfToken: 'csrf' }

  const signedIn = actionBlock(errorPage(config, viewer, 404, TITLE, MESSAGE, 'zh'))
  assert.match(signedIn, /class="btn" href="\/dashboard">回到控制台</, 'a signed-in viewer goes back to the console')
  assert.doesNotMatch(signedIn, /href="\/auth\/github"/, 'a signed-in viewer is not asked to sign in again')

  const anonymous = actionBlock(errorPage(config, null, 404, TITLE, MESSAGE, 'zh'))
  assert.match(anonymous, /class="btn" href="\/auth\/github">使用 GitHub 登录</, 'an anonymous viewer signs in')
  assert.doesNotMatch(anonymous, /href="\/dashboard"/, 'an anonymous viewer is not sent to a page that will bounce them')

  // 403 is the other status where the viewer is the remedy, so it follows the
  // same rule; 5xx does not, because signing in cannot fix our failure.
  const forbidden = errorPage(config, null, 403, 'OAuth 已启用', '这个部署已经启用 GitHub OAuth，请使用 GitHub 登录。', 'zh')
  assert.match(forbidden, /data-status="403"/)
  assert.match(actionBlock(forbidden), /href="\/auth\/github"/)

  const failed = errorPage(config, null, 500, '出错了', '服务器出了点问题，请稍后再试。', 'zh', undefined, { ref: 'ref123' })
  assert.match(failed, /data-status="500"/)
  assert.match(failed, /action="\/errors\/ref123\/report"/, 'a 5xx keeps the report form')
  assert.doesNotMatch(actionBlock(failed), /href="\/auth\/github"/, 'a 5xx never asks the viewer to sign in')
  assert.doesNotMatch(failed, /at .*\.(?:ts|js):\d+/, 'a 5xx never prints a stack frame')
})

test('an explicit action still wins over the derived one', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const viewer = { user: makeUser(store), csrfToken: 'csrf' }
  const page = actionBlock(errorPage(config, viewer, 403, '没有权限', '你没有这个页面的权限。', 'zh', { href: '/admin', label: '去 Admin' }))
  assert.match(page, /href="\/admin">去 Admin</, 'the route names its own way out')
  assert.doesNotMatch(page, /href="\/dashboard"/, 'a derived action does not sit next to the explicit one')
})

test('the status and the recovery action are bilingual', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const viewer = { user: makeUser(store), csrfToken: 'csrf' }

  const en = errorPage(config, viewer, 404, TITLE, MESSAGE, 'en')
  assert.match(en, /<h1>Page not found<\/h1>/)
  assert.match(actionBlock(en), /class="btn" href="\/dashboard">Back to dashboard</, 'the English action is English')
  assert.doesNotMatch(actionBlock(en), /回到控制台|使用 GitHub 登录/, 'no Chinese leaks into the English action')

  const enAnonymous = errorPage(config, null, 404, TITLE, MESSAGE, 'en')
  assert.match(actionBlock(enAnonymous), /class="btn" href="\/auth\/github">Sign in with GitHub</)
  assert.match(enAnonymous, /data-status="404"/)
})

test('the real not-found route replies with its status on the page', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const anonymous = await built.app.inject({ method: 'GET', url: '/no-such-page-469' })
    assert.equal(anonymous.statusCode, 404)
    assert.match(anonymous.body, /data-status="404"/, 'the 404 reply says 404 in the body')
    assert.match(anonymous.body, /href="\/auth\/github"/, 'an anonymous visitor is offered sign-in')

    const user = makeUser(store)
    const session = sessionFor(built, user)
    const signedIn = await built.app.inject({ method: 'GET', url: '/lang/nope?next=/dashboard', cookies: { fledge_session: session.raw } })
    assert.equal(signedIn.statusCode, 404)
    assert.match(signedIn.body, /data-status="404"/)
    assert.match(signedIn.body, /href="\/dashboard"/, 'a signed-in visitor is offered the console')
    assert.doesNotMatch(signedIn.body, /href="\/auth\/github"/)
  } finally {
    await built.close()
  }
})
