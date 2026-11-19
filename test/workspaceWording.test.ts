import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import type { BuiltApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import type { Config } from '../src/config.js'
import { flashOf, formBody, json, makeUser, sessionFor, startFakeServer, testConfig, MemoryMailer } from './helpers.js'
import type { Locale } from '../src/i18n.js'

// #988: #228 removed the machinery words from the pages every signed-in user
// reaches, and #1045 did the same for the job-failure dictionary
// (`src/lib/failure.ts`). The other half of that card is the copy the routes
// themselves write: the instance-cap banner and the notices a maintainer reads
// after adding a repository, starting the workspace or stopping it. A
// maintainer reads the workspace, so none of those sentences may name FlyBot or
// DSH, and each one has to say "workspace" in both languages.
// The sentence the route writes: no machinery noun at all, in either language.
const MACHINERY: Record<Locale, RegExp> = { zh: /FlyBot|DSH|实例/, en: /FlyBot|DSH|\binstance\b/i }
// The rendered page keeps the word 实例 in other cards (#228's rule is about the
// product names), so the page-level check is the same one test/plainLanguage.test.ts
// makes: the brand and the runtime are not named on a page a maintainer reads.
const BRAND: Record<Locale, RegExp> = { zh: /FlyBot|DSH/, en: /FlyBot|DSH/ }
const WORKSPACE: Record<Locale, RegExp> = { zh: /工作区/, en: /workspace/i }

function visibleText(html: string): string {
  return html
    .replace(/<footer[\s\S]*?<\/footer>/g, '\n')
    .replace(/<script[^>]*>[\s\S]*?<\/script[^>]*>/gi, '\n')
    .replace(/<style[^>]*>[\s\S]*?<\/style[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
}

interface Harness {
  built: BuiltApp
  store: Store
  config: Config
  close: () => Promise<void>
}

async function harness(overrides: Partial<Config> = {}): Promise<Harness> {
  const config = testConfig(overrides)
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  return { built, store, config, close: async () => { await built.close() } }
}

function repoRow(store: Store, userId: string, id: string, name: string): { id: string } {
  return store.createRepo({
    id, userId, owner: 'octo', name, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
}

function instanceRow(userId: string, repoId: string, status: string): Parameters<Store['saveRepoInstance']>[0] {
  return {
    repo_id: repoId, user_id: userId, container: `c-${repoId}`, network: `n-${repoId}`, data_dir: `/tmp/${repoId}`, bridge_script: '',
    dsh_port: 0, bridge_port: 0, model_port: 0, model_bind: '', image: 'img', status, chief_session: null,
    team_json: null, bridge_token_enc: null, bridge_pid: null, log_pid: null, last_error: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
  } as Parameters<Store['saveRepoInstance']>[0]
}

async function noticePage(built: BuiltApp, location: string, cookie: string, flash: string, locale: Locale): Promise<string> {
  const response = await built.app.inject({
    method: 'GET',
    url: location,
    headers: { cookie: `${cookie}; ${flash}`, 'accept-language': locale === 'en' ? 'en' : 'zh-CN' },
  })
  assert.equal(response.statusCode, 200, `the notice page did not render: ${response.statusCode}`)
  return visibleText(response.body)
}

test('the instance-cap banner names the workspace, not the machinery', async () => {
  const h = await harness({ limits: { reposPerUser: 10, instancesPerUser: 1, instancesGlobal: 0 } })
  try {
    h.config.flybot.instanceImage = 'fledge-flybot:test'
    const user = makeUser(h.store, { login: 'cap-banner', status: 'approved' })
    const first = repoRow(h.store, user.id, 'repo_cap_one', 'one')
    const second = repoRow(h.store, user.id, 'repo_cap_two', 'two')
    h.store.saveRepoInstance(instanceRow(user.id, first.id, 'ready'))
    const { cookie, csrf } = sessionFor(h.built, user)

    for (const locale of ['zh', 'en'] as const) {
      const refused = await h.built.app.inject({
        method: 'POST', url: `/repos/${second.id}/instance`,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': locale === 'en' ? 'en' : 'zh-CN' },
        payload: formBody({ csrf }),
      })
      assert.equal(refused.statusCode, 302)
      const flash = flashOf(refused)
      const key = flash?.error?.key ?? ''
      assert.match(key, /^INSTANCE_LIMIT:/, `the refusal lost its code: ${key}`)
      const message = key.slice('INSTANCE_LIMIT:'.length)
      assert.doesNotMatch(message, MACHINERY[locale], `the ${locale} cap banner still names the machinery: ${message}`)
      assert.match(message, WORKSPACE[locale], `the ${locale} cap banner does not name the workspace: ${message}`)

      const flashCookieLine = String(refused.headers['set-cookie']).split(/,\s*(?=[A-Za-z]+=)/).find((line) => line.startsWith('fledge_flash='))
      assert.ok(flashCookieLine, 'the refusal has to carry its message in the flash cookie')
      const rendered = await noticePage(h.built, `/repos/${second.id}`, cookie, flashCookieLine!, locale)
      assert.doesNotMatch(rendered, BRAND[locale], `the rendered ${locale} cap banner still names the machinery`)
      assert.match(rendered, WORKSPACE[locale], `the rendered ${locale} cap banner does not name the workspace`)
    }
  } finally {
    await h.close()
  }
})

test('the notice after starting the workspace names the workspace', async () => {
  const h = await harness()
  try {
    h.config.flybot.instanceImage = 'fledge-flybot:test'
    h.built.instances.provision = async () => undefined
    h.built.instances.stop = async () => undefined
    const user = makeUser(h.store, { login: 'start-notice', status: 'approved' })
    const repo = repoRow(h.store, user.id, 'repo_start_notice', 'start')
    const { cookie, csrf } = sessionFor(h.built, user)

    for (const locale of ['zh', 'en'] as const) {
      const started = await h.built.app.inject({
        method: 'POST', url: `/repos/${repo.id}/instance`,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': locale === 'en' ? 'en' : 'zh-CN' },
        payload: formBody({ csrf }),
      })
      assert.equal(started.statusCode, 302)
      const notice = flashOf(started)?.notice?.text ?? ''
      assert.doesNotMatch(notice, MACHINERY[locale], `the ${locale} start notice still names the machinery: ${notice}`)
      assert.match(notice, WORKSPACE[locale], `the ${locale} start notice does not name the workspace: ${notice}`)

      const flashCookieLine = String(started.headers['set-cookie']).split(/,\s*(?=[A-Za-z]+=)/).find((line) => line.startsWith('fledge_flash='))
      assert.ok(flashCookieLine, 'the start notice has to carry its text in the flash cookie')
      const rendered = await noticePage(h.built, String(started.headers.location), cookie, flashCookieLine!, locale)
      assert.doesNotMatch(rendered, BRAND[locale], `the rendered ${locale} start notice still names the machinery`)
      assert.match(rendered, WORKSPACE[locale], `the rendered ${locale} start notice does not name the workspace`)
    }
  } finally {
    await h.close()
  }
})

test('the notice after stopping the workspace names the workspace', async () => {
  const h = await harness()
  try {
    h.built.instances.stop = async () => undefined
    const user = makeUser(h.store, { login: 'stop-notice', status: 'approved' })
    const repo = repoRow(h.store, user.id, 'repo_stop_notice', 'stop')
    h.store.saveRepoInstance(instanceRow(user.id, repo.id, 'ready'))
    const { cookie, csrf } = sessionFor(h.built, user)

    for (const locale of ['zh', 'en'] as const) {
      const stopped = await h.built.app.inject({
        method: 'POST', url: `/repos/${repo.id}/instance/stop`,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': locale === 'en' ? 'en' : 'zh-CN' },
        payload: formBody({ csrf }),
      })
      assert.equal(stopped.statusCode, 302)
      const notice = flashOf(stopped)?.notice?.text ?? ''
      assert.doesNotMatch(notice, MACHINERY[locale], `the ${locale} stop notice still names the machinery: ${notice}`)
      assert.match(notice, WORKSPACE[locale], `the ${locale} stop notice does not name the workspace: ${notice}`)
    }
  } finally {
    await h.close()
  }
})

test('the page shown when the deployment has no workspace names the workspace', async () => {
  const h = await harness()
  try {
    h.config.flybot.instanceImage = ''
    const user = makeUser(h.store, { login: 'no-workspace', status: 'approved' })
    const repo = repoRow(h.store, user.id, 'repo_no_workspace', 'nows')
    const { cookie, csrf } = sessionFor(h.built, user)

    for (const locale of ['zh', 'en'] as const) {
      const response = await h.built.app.inject({
        method: 'POST', url: `/repos/${repo.id}/instance`,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': locale === 'en' ? 'en' : 'zh-CN' },
        payload: formBody({ csrf }),
      })
      assert.equal(response.statusCode, 400, 'a deployment without a workspace image refuses the start')
      const text = visibleText(response.body)
      assert.doesNotMatch(text, BRAND[locale], `the ${locale} refusal page still names the machinery: ${text.slice(0, 400)}`)
      assert.match(text, WORKSPACE[locale], `the ${locale} refusal page does not name the workspace: ${text.slice(0, 400)}`)
    }
  } finally {
    await h.close()
  }
})

test('the notice after adding a repository names the workspace', async () => {
  const github = await startFakeServer((request, response) => {
    if (request.url === '/user') {
      json(response, 200, { id: 4343, login: 'octo', name: 'octo', email: 'octo@example.com', avatar_url: null })
      return
    }
    for (const name of ['zh-demo', 'en-demo']) {
      if (request.url === `/repos/octo/${name}`) {
        json(response, 200, {
          name, full_name: `octo/${name}`, default_branch: 'main', private: false,
          html_url: `https://github.com/octo/${name}`, owner: { login: 'octo' }, permissions: { admin: true, push: true },
        })
        return
      }
    }
    response.writeHead(404)
    response.end()
  })
  const h = await harness({ github: { ...testConfig().github, apiBase: github.url } })
  try {
    h.config.flybot.instanceImage = 'fledge-flybot:test'
    h.built.instances.provision = async () => undefined
    h.built.instances.ensureUserDir = () => '/tmp/fledge-test/workspace-wording'
    const user = makeUser(h.store, { login: 'octo', status: 'approved' })
    const { cookie, csrf } = sessionFor(h.built, user)

    for (const locale of ['zh', 'en'] as const) {
      // The deployment owns the upstream, so the add needs no fork and the only
      // notice this test reads is the one the route composes.
      const added = await h.built.app.inject({
        method: 'POST', url: '/repos',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': locale === 'en' ? 'en' : 'zh-CN' },
        payload: formBody({ csrf, repo: `octo/${locale}-demo`, token: 'repo-token', goal: 'fix it', auto: '0', interval: '1440' }),
      })
      assert.equal(added.statusCode, 302, `the add was refused: ${visibleText(added.body).slice(0, 200)}`)
      const notice = flashOf(added)?.notice?.text ?? ''
      assert.doesNotMatch(notice, MACHINERY[locale], `the ${locale} add notice still names the machinery: ${notice}`)
      assert.match(notice, WORKSPACE[locale], `the ${locale} add notice does not name the workspace: ${notice}`)

      const flashCookieLine = String(added.headers['set-cookie']).split(/,\s*(?=[A-Za-z]+=)/).find((line) => line.startsWith('fledge_flash='))
      assert.ok(flashCookieLine, 'the add notice has to carry its text in the flash cookie')
      const rendered = await noticePage(h.built, String(added.headers.location), cookie, flashCookieLine!, locale)
      assert.doesNotMatch(rendered, BRAND[locale], `the rendered ${locale} add notice still names the machinery`)
    }
  } finally {
    await h.close()
    await github.close()
  }
})
