import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'
import { repoPage } from '../src/views/pages.js'

// #235: the repository settings card is the owner surface. The loop controls an
// owner tunes while reading the page stay on screen; the operator controls
// (paths, stage gate, budgets, providers, models) live in one closed
// `data-advanced` disclosure inside the same form, so the POST route and every
// field name are unchanged.
const OPERATOR_FIELDS = [
  'allowPaths',
  'denyPaths',
  'mergeMethod',
  'stageMode',
  'requireProtection',
  'monthlyBudget',
  'jobBudget',
  'jobBudgetAction',
  'modelIds',
  'allowedProviderIds',
  'providerRegion',
  'defaultModelId',
  'botModel_chief',
]
const LOOP_FIELDS = ['goal', 'repoRole', 'targetBranch', 'auto', 'enabled', 'interval', 'review', 'reviewInterval', 'autoMerge', 'planRequired']

interface Rendered {
  html: string
  repoId: string
  close: () => void
}

function render(locale: 'zh' | 'en'): Rendered {
  const config = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `surfaces-${locale}`, status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_surfaces',
    userId: user.id,
    owner: 'o',
    name: 'surfaces',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: 'ship it',
    autoIterate: true,
    intervalMinutes: 1440,
  })
  const provider = store.createModelProvider({ id: 'prv_surfaces', userId: user.id, label: 'Provider', baseUrl: 'https://p.example/v1', keyEnc: 'enc', allowPrivate: false })
  const model = store.createProviderModel({ id: 'pvm_surfaces', providerId: provider.id, model: 'model-a', label: 'Model A' })
  const html = repoPage({
    config,
    locale,
    viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
    repo,
    jobs: [],
    models: [{ ...model, provider_label: 'Provider' }],
    repoModelIds: [model.id],
    repoDefaultModelId: model.id,
    repoBotModels: [{ role: 'chief', provider_model_id: model.id }],
    providers: [provider],
  })
  return { html, repoId: repo.id, close: () => store.close() }
}

// The settings card runs from its own heading to the connection card that
// follows it, so a field found "outside" the disclosure here is a field the
// owner sees without opening it.
function settingsCard(html: string): string {
  const start = html.indexOf('id="repo-settings"')
  assert.ok(start >= 0, 'the repository page has no #repo-settings card')
  const end = html.indexOf('id="connection"', start)
  assert.ok(end > start, 'the settings card is not followed by the connection card')
  return html.slice(start, end)
}

test('operator settings are one closed disclosure and the loop settings stay visible', () => {
  for (const locale of ['zh', 'en'] as const) {
    const rendered = render(locale)
    try {
      const card = settingsCard(rendered.html)
      const disclosure = /<details\b[^>]*data-advanced="repo-settings"[^>]*>/.exec(card)
      assert.ok(disclosure, `${locale}: the settings card has no [data-advanced="repo-settings"] disclosure`)
      assert.doesNotMatch(disclosure![0], /\sopen(\s|=|>)/, `${locale}: the operator disclosure must render closed`)

      const openAt = disclosure!.index
      const closeAt = card.indexOf('</details>', openAt)
      assert.ok(closeAt > openAt, `${locale}: the operator disclosure is not closed`)
      const inside = card.slice(openAt, closeAt)
      const outside = card.slice(0, openAt)

      for (const field of OPERATOR_FIELDS) {
        assert.match(inside, new RegExp(`name="${field}"`), `${locale}: name="${field}" must render inside the closed disclosure`)
      }
      for (const field of LOOP_FIELDS) {
        assert.match(outside, new RegExp(`name="${field}"`), `${locale}: name="${field}" must stay visible outside the disclosure`)
      }

      const form = /<form method="post" action="\/repos\/[^"]+\/settings"/.exec(card)
      assert.ok(form, `${locale}: the settings card has no POST form`)
      assert.ok(form!.index < openAt, `${locale}: the disclosure must sit inside the settings form`)
      assert.match(card.slice(closeAt), /<\/form>/, `${locale}: the settings form must close after the disclosure`)
    } finally {
      rendered.close()
    }
  }
})

test('the disclosure is labelled in both languages', () => {
  const zh = render('zh')
  const en = render('en')
  try {
    assert.match(settingsCard(zh.html), /<summary>高级：运维设置（路径、阶段门禁、预算、模型）<\/summary>/)
    assert.match(settingsCard(en.html), /<summary>Advanced: operator settings \(paths, stage gate, budgets, models\)<\/summary>/)
  } finally {
    zh.close()
    en.close()
  }
})

test('one POST still stores the operator fields for a maintainer and refuses auto-merge to a developer', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'surfaces-owner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_surfaces_post',
      userId: user.id,
      owner: 'o',
      name: 'surfaces-post',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const provider = store.createModelProvider({ id: 'prv_post', userId: user.id, label: 'Provider', baseUrl: 'https://p.example/v1', keyEnc: 'enc', allowPrivate: false })
    const model = store.createProviderModel({ id: 'pvm_post', providerId: provider.id, model: 'model-a', label: 'Model A' })
    const session = sessionFor(built, user)

    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({
        csrf: session.csrf,
        repoRole: 'maintainer',
        goal: 'keep shipping',
        targetBranch: 'main',
        stageMode: 'shadow',
        allowPaths: 'src/, docs/',
        denyPaths: '.github/',
        mergeMethod: 'rebase',
        requireProtection: '1',
        monthlyBudget: '42',
        jobBudget: '7',
        jobBudgetAction: 'pause',
        modelIds: model.id,
        defaultModelId: model.id,
        botModel_chief: model.id,
      }),
    })
    assert.equal(saved.statusCode, 302)
    const stored = store.getRepo(repo.id)!
    assert.equal(stored.stage_mode, 'shadow')
    assert.equal(stored.allow_paths, 'src/, docs/')
    assert.equal(stored.deny_paths, '.github/')
    assert.equal(stored.merge_method, 'rebase')
    assert.equal(stored.require_protection, 1)
    assert.equal(stored.monthly_budget_cny, 42)
    assert.equal(stored.job_budget_cny, 7)
    assert.equal(stored.job_budget_action, 'pause')
    assert.equal(store.listRepoBotModels(repo.id).find((entry) => entry.role === 'chief')?.provider_model_id, model.id)

    const developer = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/settings`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, repoRole: 'developer', goal: 'keep shipping', targetBranch: 'main', autoMerge: '1' }),
    })
    assert.equal(developer.statusCode, 302)
    assert.equal(store.getRepo(repo.id)!.auto_merge, 0)
  } finally {
    await built.close()
  }
})
