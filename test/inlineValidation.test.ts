import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import type { RepoRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { flashCookie, formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'
import type { UserRow } from '../src/db.js'
import { runApp } from './stubDom.js'

// #471: a form refusal used to be one sentence in a banner and nowhere else, so
// on a long Settings form the invalid control was unmarked, undescribed and
// unfocused. This suite fixes the shape of the first slice — the repository
// settings form — and states the three rules the slice must keep:
//
// - the refusal is server-authoritative: the `<select>` cannot produce a value
//   outside its options, so the invalid submission is posted directly;
// - a *stored* cadence the form still carries stays savable (a legacy 90-minute
//   row, or a review interval of 17 minutes, must not become a data trap when
//   the maintainer saves an untouched form);
// - one sentence, once: the banner keeps the summary, the control keeps the
//   detail, and neither sentence is printed twice.

interface Harness {
  store: Store
  built: BuiltApp
  user: UserRow
  repo: RepoRow
}

async function harness(input: { intervalMinutes?: number; reviewIntervalMinutes?: number; autoIterate?: boolean } = {}): Promise<Harness> {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'inline-validation', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_inline',
    userId: user.id,
    owner: 'o',
    name: 'inline',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: input.autoIterate ?? true,
    intervalMinutes: input.intervalMinutes ?? 1440,
    reviewIntervalMinutes: input.reviewIntervalMinutes ?? 1440,
  })
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  return { store, built, user, repo }
}

function settingsForm(html: string, repoId: string): string {
  const start = html.indexOf(`action="/repos/${repoId}/settings"`)
  assert.notEqual(start, -1, 'the repository settings form is on the page')
  const from = html.lastIndexOf('<form', start)
  return html.slice(from, html.indexOf('</form>', start))
}

function count(haystack: string, needle: string): number {
  let seen = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    seen += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return seen
}

test('#471 an invalid interval is refused and names the field instead of being silently clamped', async () => {
  const h = await harness()
  try {
    const session = sessionFor(h.built, h.user)
    const response = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/settings`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, repoRole: 'maintainer', interval: '17' }),
    })
    assert.equal(response.statusCode, 302)
    const location = String(response.headers.location)
    assert.match(location, /[?&]field=interval(&|#|$)/, 'the refusal names the field the page must mark')
    assert.doesNotMatch(location, /[?&]error=/, 'the sentence rides the one-shot flash, not the address bar')
    assert.equal(h.store.getRepo(h.repo.id)?.interval_minutes, 1440, 'a refused submission writes nothing')
  } finally {
    await h.built.close()
  }
})

test('#471 the refused page marks, describes and focuses the field, and the sentence is not repeated', async () => {
  const h = await harness()
  try {
    const session = sessionFor(h.built, h.user)
    // English on the POST too: the summary is written into the flash in the
    // submitting request's locale, so both sentences are read in one language.
    const response = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/settings`,
      headers: { cookie: `${session.cookie}; fledge_lang=en`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, repoRole: 'maintainer', interval: '17' }),
    })
    const flash = flashCookie(response)
    assert.notEqual(flash, undefined, 'the refusal rides the one-shot flash, not the address bar')

    const page = await h.built.app.inject({
      method: 'GET',
      url: `/repos/${h.repo.id}?field=interval`,
      headers: { cookie: `${session.cookie}; fledge_lang=en; ${flash}` },
    })
    assert.equal(page.statusCode, 200)
    const form = settingsForm(page.body, h.repo.id)

    const select = form.slice(form.indexOf('name="interval"') - 200, form.indexOf('name="interval"') + 400)
    assert.match(select, /aria-invalid="true"/, 'the invalid control is marked')
    assert.match(select, /aria-describedby="repo-settings-interval-error"/, 'the control points at its message')
    assert.equal(count(form, 'repo-settings-interval-error'), 2, 'one description id, one message element')

    const message = page.body.slice(page.body.indexOf('id="repo-settings-interval-error"'))
    assert.match(message, /^id="repo-settings-interval-error"[^>]*>[^<]+</, 'the message element carries a sentence')

    const autofocus = [...form.matchAll(/<(\w+)[^>]*\bautofocus\b[^>]*>/g)].map((match) => match[0])
    assert.equal(autofocus.length, 1, 'exactly one control is focused, not one per error')
    assert.match(autofocus[0] ?? '', /name="interval"/, 'the first invalid control is the one focused')
    assert.equal(count(form, 'data-field-error-focus'), 1, 'one control carries the script focus hook')

    // One sentence, once: the banner keeps a summary, the control keeps its own
    // detail, and no sentence is printed twice on the page.
    const summary = 'The settings were not saved.'
    const detail = 'Choose one of the listed intervals.'
    assert.equal(count(page.body, summary), 1, 'the summary appears once, in the banner')
    assert.equal(count(page.body, detail), 1, 'the detail appears once, beside the field')
  } finally {
    await h.built.close()
  }
})

test('#471 a valid submission saves and marks nothing', async () => {
  const h = await harness()
  try {
    const session = sessionFor(h.built, h.user)
    const response = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/settings`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, repoRole: 'maintainer', interval: '120', reviewInterval: '720' }),
    })
    assert.equal(response.statusCode, 302)
    assert.doesNotMatch(String(response.headers.location), /[?&]field=/, 'a valid submission names no field')
    const saved = h.store.getRepo(h.repo.id)
    assert.equal(saved?.interval_minutes, 120)
    assert.equal(saved?.review_interval_minutes, 720)

    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    const form = settingsForm(page.body, h.repo.id)
    assert.doesNotMatch(form, /aria-invalid/, 'a page with no refusal marks no control')
    assert.doesNotMatch(form, /aria-describedby="repo-settings-/, 'a page with no refusal describes no control')
  } finally {
    await h.built.close()
  }
})

test('#471 a stored cadence the form carries stays savable, so a legacy row is not a data trap', async () => {
  // 90 is a real stored discovery interval (#802 prints the floor for 30), and 17
  // is a stored review interval outside the offered list. Both are rendered as
  // their own selected option today; saving that untouched form must succeed.
  const h = await harness({ intervalMinutes: 90, reviewIntervalMinutes: 17 })
  try {
    const session = sessionFor(h.built, h.user)
    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    const form = settingsForm(page.body, h.repo.id)
    assert.match(form, /<option value="90" selected>/, 'the form carries the stored discovery interval')
    assert.match(form, /<option value="17" selected>/, 'the form carries the stored review interval')

    const response = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/settings`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, repoRole: 'maintainer', interval: '90', reviewInterval: '17' }),
    })
    assert.equal(response.statusCode, 302)
    assert.doesNotMatch(String(response.headers.location), /[?&]field=/, 'saving an untouched legacy form is not a refusal')
    const saved = h.store.getRepo(h.repo.id)
    assert.equal(saved?.interval_minutes, 90)
    assert.equal(saved?.review_interval_minutes, 17)
  } finally {
    await h.built.close()
  }
})

test('#471 a stored interval below the discovery floor is normalised on read and still saves', async () => {
  const h = await harness({ intervalMinutes: 30 })
  try {
    const session = sessionFor(h.built, h.user)
    const page = await h.built.app.inject({ method: 'GET', url: `/repos/${h.repo.id}`, headers: { cookie: `${session.cookie}; fledge_lang=en` } })
    const form = settingsForm(page.body, h.repo.id)
    assert.match(form, /<option value="60" selected>/, 'the page reads the legacy row at the 60-minute floor')

    const response = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/settings`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, repoRole: 'maintainer', interval: '60' }),
    })
    assert.equal(response.statusCode, 302)
    assert.doesNotMatch(String(response.headers.location), /[?&]field=/, 'the value the page carried is accepted')
    assert.equal(h.store.getRepo(h.repo.id)?.interval_minutes, 60)
  } finally {
    await h.built.close()
  }
})

test('#471 the shipped script moves focus to the marked field, and a page without one focuses nothing', () => {
  const plain = runApp()
  assert.equal(plain.focusedField(), 0, 'no marker, no focus move')
  const marked = runApp({ fieldFocus: true })
  assert.equal(marked.focusedField(), 1, 'the marked control receives focus once')
})

test('#471 a field the form disables is marked but claims no focus, because a disabled control cannot take it', async () => {
  // `public/app.js` disables the interval select while auto-iterate is off, so a
  // crafted refusal can name a control the reader cannot reach. The message and
  // `aria-invalid` still render; the focus claim is not made, rather than landing
  // the reader on the document.
  const h = await harness({ autoIterate: false })
  try {
    const session = sessionFor(h.built, h.user)
    const response = await h.built.app.inject({
      method: 'POST',
      url: `/repos/${h.repo.id}/settings`,
      headers: { cookie: `${session.cookie}; fledge_lang=en`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, repoRole: 'maintainer', interval: '17' }),
    })
    const flash = flashCookie(response)
    const page = await h.built.app.inject({
      method: 'GET',
      url: `/repos/${h.repo.id}?field=interval`,
      headers: { cookie: `${session.cookie}; fledge_lang=en; ${flash}` },
    })
    const form = settingsForm(page.body, h.repo.id)
    assert.match(form, /aria-invalid="true"/, 'the refusal is still visible')
    assert.equal(count(form, 'data-field-error-focus'), 0, 'a disabled control is not asked to take focus')
    assert.equal(count(form, 'autofocus'), 0, 'and nothing else is focused instead')
  } finally {
    await h.built.close()
  }
})
