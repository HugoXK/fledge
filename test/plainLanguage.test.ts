import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #228: the normal-user surfaces name the product, not the machinery. The four
// pages every signed-in user reaches — /dashboard, /console, /repos/:id and
// /settings — must not name FlyBot or DSH in visible text, while the footer
// brand line and the stageMode form values survive the sweep. Rendered through
// the real routes, so the test reads the same server HTML the browser gets.

const FORBIDDEN = [
  { pattern: /FlyBot/, what: 'FlyBot' },
  { pattern: /DSH/, what: 'DSH' },
  { pattern: /团队阶段门禁/, what: '团队阶段门禁' },
  { pattern: /Team stage gate/, what: 'Team stage gate' },
  { pattern: /\benforced\b/, what: 'enforced' },
  { pattern: /\bshadow\b/, what: 'shadow' },
]

const START_HINT = { zh: '工作区就绪后，团队才能开始工作。', en: 'The team can start work once the workspace is ready.' }
const STOP_HINT = { zh: '停止会中断正在运行的工作。', en: 'Stopping interrupts running work.' }
const REINIT_HINT = { zh: '重新初始化会重建工作区。', en: 'Reinitializing rebuilds the workspace.' }

// Visible text only: the advanced operator blocks, the footer block and any
// script/style payload are removed first, then every tag — attributes included —
// so value="enforced" or name="…" can never satisfy the sweep.
function visibleText(html: string): string {
  return html
    .replace(/<details[^>]*advanced-help[^>]*>[\s\S]*?<\/details>/g, '\n')
    .replace(/<footer[\s\S]*?<\/footer>/g, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '\n')
    .replace(/<[^>]*>/g, '\n')
}

interface Harness {
  built: Awaited<ReturnType<typeof buildApp>>
  store: Store
  user: { id: string }
  repo: { id: string }
  readyRepo: { id: string }
  cookie: string
  normal: { user: { id: string }; repo: { id: string }; cookie: string }
}

async function createRepo(store: Store, id: string, userId: string, name: string, autoIterate: boolean): Promise<{ id: string }> {
  return store.createRepo({
    id, userId, owner: 'acme', name, defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
    repoRole: 'maintainer', goal: '', autoIterate, intervalMinutes: 1440,
  })
}

async function harness(): Promise<Harness> {
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: 'image' } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'plain-language-user', status: 'approved', superadmin: true })
  // The dashboard answers "workspace not ready" only on its all-clear card, and
  // that card needs a complete first run: an instance, a model and a finished
  // job. Those live on a repository with automatic iteration off, so it never
  // enters the next-run choice and cannot shadow the two repositories whose
  // answer this test reads.
  const readyRepo = await createRepo(store, 'repo_plain_ready', user.id, 'ready', false)
  saveInstance(store, readyRepo.id, user.id, 'ready', null)
  store.createModelProvider({ id: 'prov_plain', userId: user.id, label: 'p', baseUrl: 'https://example.test', keyEnc: 'x', allowPrivate: false })
  store.createProviderModel({ id: 'pm_plain', providerId: 'prov_plain', model: 'm', label: 'm' })
  store.setRepoModelSelection(readyRepo.id, ['pm_plain'], 'pm_plain')
  store.createJob({ id: 'job_plain_first', repoId: readyRepo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
  store.updateJob('job_plain_first', { status: 'succeeded' })
  const repo = await createRepo(store, 'repo_plain_language', user.id, 'demo', true)
  await createRepo(store, 'repo_plain_second', user.id, 'second', true)
  // A plain approved user: the normal-user surface the issue is written for, with
  // no advanced operator region.
  const normalUser = makeUser(store, { login: 'plain-language-normal', status: 'approved' })
  const normalRepo = await createRepo(store, 'repo_plain_normal', normalUser.id, 'normal', true)
  const { cookie } = sessionFor(built, user)
  const normalSession = sessionFor(built, normalUser)
  return { built, store, user, repo, readyRepo, cookie, normal: { user: normalUser, repo: normalRepo, cookie: normalSession.cookie } }
}

function saveInstance(store: Store, repoId: string, userId: string, status: string, lastError: string | null): void {
  store.saveRepoInstance({
    repo_id: repoId, user_id: userId, container: 'fledge-plain', network: 'n', data_dir: '/tmp/plain',
    bridge_script: '/tmp/bridge', dsh_port: 1, bridge_port: 2, model_port: 3, model_bind: '127.0.0.1',
    image: 'image', status, chief_session: 'chief', team_json: JSON.stringify({ chief: 'c', lead: 'l', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'DigitalMate' }),
    bridge_token_enc: 'x', bridge_pid: null, log_pid: null, last_error: lastError,
    created_at: '2026-11-16T08:00:00.000Z', updated_at: '2026-11-16T08:00:00.000Z', last_health_at: '2026-11-16T08:00:00.000Z',
  })
}

function get(h: Harness, url: string, locale: string) {
  return getAs(h, h.cookie, url, locale)
}

function getAs(h: Harness, cookie: string, url: string, locale: string) {
  return h.built.app.inject({ method: 'GET', url, headers: { cookie, 'accept-language': locale } })
}

test('no normal-user page names the machinery in visible text (zh and en)', async () => {
  const h = await harness()
  try {
    for (const locale of ['zh', 'en'] as const) {
      for (const url of ['/dashboard', '/console', `/repos/${h.repo.id}`, '/settings']) {
        const response = await get(h, url, locale)
        assert.equal(response.statusCode, 200, `${locale} ${url}: renders`)
        const text = visibleText(response.body)
        for (const { pattern, what } of FORBIDDEN) {
          const match = pattern.exec(text)
          assert.equal(match, null, `${locale} ${url}: visible text must not name ${what}${match === null ? '' : ` (found near: ${JSON.stringify(text.slice(Math.max(0, match.index - 40), match.index + 40).replace(/\s+/g, ' '))})`}`)
        }
      }
    }
  } finally {
    await h.built.close()
  }
})

test('the footer brand line and the stageMode values survive the sweep', async () => {
  const h = await harness()
  try {
    const zhPages = await Promise.all(['/dashboard', '/console', `/repos/${h.repo.id}`, '/settings'].map((url) => get(h, url, 'zh')))
    for (const page of zhPages) assert.ok(page.body.includes('由 FlyBot 驱动'), 'every zh page keeps the brand in the footer, so the sweep cannot pass by deleting the footer')
    const enSettings = await get(h, '/settings', 'en')
    assert.ok(enSettings.body.includes('powered by FlyBot'), 'the English page keeps the brand line too')
    const repo = await get(h, `/repos/${h.repo.id}`, 'en')
    for (const value of ['enforced', 'shadow', 'off']) {
      assert.ok(repo.body.includes(`value="${value}"`), `the stageMode form still submits value="${value}"`)
    }
  } finally {
    await h.built.close()
  }
})

test('the next-run sentence and the inbox heading are fixed at every call site they share', async () => {
  const h = await harness()
  try {
    const zh = { dashboard: await get(h, '/dashboard', 'zh'), repo: await get(h, `/repos/${h.repo.id}`, 'zh'), console: await get(h, '/console', 'zh') }
    const en = { dashboard: await get(h, '/dashboard', 'en'), repo: await get(h, `/repos/${h.repo.id}`, 'en'), console: await get(h, '/console', 'en') }
    // The dashboard names the next run on its all-clear card; a fixture that fell
    // back to another card would make the assertion below test nothing.
    for (const page of [zh.dashboard, en.dashboard]) assert.ok(page.body.includes('data-next-action="clear"'), 'the dashboard fixture reaches the all-clear card')
    // The same helper renders on both surfaces; a fix applied to one call site
    // only is red here.
    for (const page of [zh.dashboard, zh.repo]) assert.ok(page.body.includes('工作区未就绪，自动运行不会开始'), 'zh next-run sentence on the dashboard and the repository page')
    for (const page of [en.dashboard, en.repo]) assert.ok(page.body.includes('Workspace not ready; no automatic run starts'), 'en next-run sentence on the dashboard and the repository page')
    for (const page of [zh.dashboard, zh.repo, zh.console]) assert.ok(page.body.includes('工作区在等你回答'), 'zh inbox heading on dashboard, repository and console')
    for (const page of [en.dashboard, en.repo, en.console]) assert.ok(page.body.includes('Workspace is waiting for you'), 'en inbox heading on dashboard, repository and console')
  } finally {
    await h.built.close()
  }
})

test('every renamed workspace control has a plain label and a one-line hint, in both locales', async () => {
  const h = await harness()
  try {
    const cases = [
      { status: null, label: { zh: '启动工作区', en: 'Start workspace' }, hint: START_HINT },
      { status: 'ready', label: { zh: '停止工作区', en: 'Stop workspace' }, hint: STOP_HINT },
      { status: 'starting', label: { zh: '重新初始化工作区', en: 'Reinitialize workspace' }, hint: REINIT_HINT },
    ] as const
    for (const state of cases) {
      if (state.status !== null) saveInstance(h.store, h.repo.id, h.user.id, state.status, null)
      for (const locale of ['zh', 'en'] as const) {
        const page = await get(h, `/repos/${h.repo.id}`, locale)
        assert.ok(page.body.includes(state.label[locale]), `${locale}: the ${state.status ?? 'missing'} instance offers ${state.label[locale]}`)
        assert.ok(page.body.includes(state.hint[locale]), `${locale}: ${state.label[locale]} carries its one-line hint`)
      }
    }
  } finally {
    await h.built.close()
  }
})

test('renamed copy does not mix the other language into a page', async () => {
  const h = await harness()
  try {
    // The plain user's repository page is the surface the issue is written for:
    // no advanced operator region, so the workspace heading is the one rendered.
    const zhRepo = visibleText((await getAs(h, h.normal.cookie, `/repos/${h.normal.repo.id}`, 'zh')).body)
    const enRepo = visibleText((await getAs(h, h.normal.cookie, `/repos/${h.normal.repo.id}`, 'en')).body)
    assert.ok(zhRepo.includes('工作区状态'), 'zh uses the workspace heading')
    assert.ok(!zhRepo.includes('Workspace status'), 'zh page never prints the English heading')
    assert.ok(enRepo.includes('Workspace status'), 'en uses the workspace heading')
    assert.ok(!enRepo.includes('工作区状态'), 'en page never prints the Chinese heading')
    assert.ok(zhRepo.includes('每仓库工作区'), 'zh eyebrow is translated')
    assert.ok(!zhRepo.includes('PER-REPOSITORY WORKSPACE'), 'zh page never prints the English eyebrow')
    assert.ok(enRepo.includes('PER-REPOSITORY WORKSPACE'), 'en eyebrow is translated')
    assert.ok(!enRepo.includes('每仓库工作区'), 'en page never prints the Chinese eyebrow')
  } finally {
    await h.built.close()
  }
})
