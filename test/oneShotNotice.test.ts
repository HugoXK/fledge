import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #472 slice 2: a redirect message is delivered in a one-shot cookie, not in the
// address bar. The first HTML page consumes it and clears it, so a reload has
// nothing left to print and a hand-typed `?notice=`/`?error=` renders nothing.
// These cases read the cookie themselves (base64url JSON) rather than importing
// the implementation, so the file fails on `main` for the behaviour, not for a
// missing module.

const FLASH_COOKIE = 'fledge_flash'

interface FlashMessage {
  text: string
  key: string
}

interface FlashState {
  notice?: FlashMessage
  error?: FlashMessage
}

function cookieLines(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers['set-cookie']
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).map(String)
}

function flashLine(response: { headers: Record<string, unknown> }): string | undefined {
  return cookieLines(response).find((line) => line.startsWith(`${FLASH_COOKIE}=`))
}

function flashValue(response: { headers: Record<string, unknown> }): string | undefined {
  const line = flashLine(response)
  if (line === undefined) return undefined
  const value = line.slice(FLASH_COOKIE.length + 1).split(';')[0] ?? ''
  return value === '' ? undefined : value
}

function flashOf(response: { headers: Record<string, unknown> }): FlashState | undefined {
  const raw = flashValue(response)
  if (raw === undefined) return undefined
  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, { t?: unknown; k?: unknown }>
  const state: FlashState = {}
  if (typeof parsed.n?.t === 'string') state.notice = { text: parsed.n.t, key: typeof parsed.n.k === 'string' ? parsed.n.k : parsed.n.t }
  if (typeof parsed.e?.t === 'string') state.error = { text: parsed.e.t, key: typeof parsed.e.k === 'string' ? parsed.e.k : parsed.e.t }
  return state
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

async function harness() {
  const store = new Store(':memory:')
  const built = await buildApp({
    config: testConfig(),
    store,
    mailer: new MemoryMailer(),
    runner: new MockRunner(),
    startScheduler: false,
  })
  const user = makeUser(store, { login: 'one-shot-notice', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_one_shot_notice',
    userId: user.id,
    owner: 'o',
    name: 'notice',
    defaultBranch: 'main',
    targetBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const { cookie, csrf } = sessionFor(built, user)
  return { built, store, user, repo, cookie, csrf }
}

function post(built: Awaited<ReturnType<typeof buildApp>>, url: string, cookie: string, payload: Record<string, string>) {
  return built.app.inject({
    method: 'POST',
    url,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody(payload),
  })
}

test('a redirect moves its error into a one-shot cookie and out of the address bar', async () => {
  const { built, repo, cookie, csrf } = await harness()
  try {
    const rejected = await post(built, `/repos/${repo.id}/work`, cookie, { csrf, title: '' })
    assert.equal(rejected.statusCode, 302)
    assert.equal(rejected.headers.location, `/repos/${repo.id}#work`, 'the redirect must carry no message in its query')
    assert.doesNotMatch(String(rejected.headers.location), /(?:notice|error)=/)

    const flash = flashOf(rejected)
    assert.ok(flash, 'the message must travel in a flash cookie')
    assert.equal(flash.error?.text, '请填写工作项标题。')
    assert.equal(flash.notice, undefined)

    const raw = flashValue(rejected)
    assert.ok(raw)
    const rendered = await built.app.inject({
      method: 'GET',
      url: String(rejected.headers.location),
      headers: { cookie: `${cookie}; ${FLASH_COOKIE}=${raw}` },
    })
    assert.equal(rendered.statusCode, 200)
    assert.equal(count(rendered.body, '请填写工作项标题。'), 1, 'the message must render exactly once')
    assert.match(rendered.body, /<section class="banner-stack" aria-live="polite"/)
    const cleared = flashLine(rendered)
    assert.ok(cleared, 'the page that read the message must clear the cookie')
    assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/, 'the cookie must be expired, not just left behind')

    const reloaded = await built.app.inject({ method: 'GET', url: String(rejected.headers.location), headers: { cookie } })
    assert.equal(reloaded.statusCode, 200)
    assert.equal(count(reloaded.body, '请填写工作项标题。'), 0, 'a reload must not resurrect a one-shot message')
  } finally {
    await built.close()
  }
})

test('a redirect notice is shown once and is gone on the next navigation', async () => {
  const { built, repo, cookie, csrf } = await harness()
  try {
    const created = await post(built, `/repos/${repo.id}/work`, cookie, { csrf, title: 'one shot work' })
    assert.equal(created.statusCode, 302)
    assert.equal(created.headers.location, `/repos/${repo.id}#work`)
    const flash = flashOf(created)
    assert.equal(flash?.notice?.text, '工作项已创建。')

    const raw = flashValue(created)
    assert.ok(raw)
    const first = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie: `${cookie}; ${FLASH_COOKIE}=${raw}` } })
    assert.equal(first.statusCode, 200)
    assert.equal(count(first.body, '工作项已创建。'), 1)
    const second = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie } })
    assert.equal(second.statusCode, 200)
    assert.equal(count(second.body, '工作项已创建。'), 0)
  } finally {
    await built.close()
  }
})

test('a hand-typed notice or error in the address bar renders nothing', async () => {
  const { built, repo, cookie } = await harness()
  try {
    for (const [name, text] of [['notice', 'forged notice'], ['error', 'forged error']] as const) {
      const response = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}?${name}=${encodeURIComponent(text)}`, headers: { cookie } })
      assert.equal(response.statusCode, 200)
      assert.equal(count(response.body, text), 0, `?${name}= must not render from the address bar`)
    }
  } finally {
    await built.close()
  }
})

test('the cookie can carry an error and a notice together, and the stack prints the error first', async () => {
  const { built, repo, cookie } = await harness()
  try {
    const state = { e: { t: 'an error happened', k: 'error-1' }, n: { t: 'a notice happened', k: 'notice-1' } }
    const raw = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')
    const page = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}`, headers: { cookie: `${cookie}; ${FLASH_COOKIE}=${raw}` } })
    assert.equal(page.statusCode, 200)
    const errorAt = page.body.indexOf('an error happened')
    const noticeAt = page.body.indexOf('a notice happened')
    assert.ok(errorAt !== -1 && noticeAt !== -1, 'both messages must render')
    assert.ok(errorAt < noticeAt, 'the failure must come before the notice')
    assert.equal(count(page.body, 'an error happened'), 1)
    assert.equal(count(page.body, 'a notice happened'), 1)
  } finally {
    await built.close()
  }
})
