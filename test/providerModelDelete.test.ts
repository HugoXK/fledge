import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, type BuiltApp } from '../src/app.js'
import { Store, type RepoRow, type UserRow } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { sha256Hex } from '../src/lib/secrets.js'
import { flashOf, formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'
import { LOCALE_COOKIE } from '../src/i18n.js'

// #849: deleting a model provider (or one of its models) removes the selection
// rows by cascade, and every repository that used one silently falls to the
// platform default model: it spends platform quota and the console never offers
// the models-dirty restart the switch path sets. These tests pin the flag, the
// notice and the audit for both delete paths.

interface Fixture {
  built: BuiltApp
  store: Store
  user: UserRow
  repo: RepoRow
  providerId: string
  modelId: string
}

async function fixture(): Promise<Fixture> {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'provider-delete-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_provider_delete', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main',
    tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
  })
  const provider = store.createModelProvider({
    id: 'mp_delete', userId: user.id, label: 'acme', baseUrl: 'https://api.example.com/v1', keyEnc: 'x', allowPrivate: false,
  })
  const model = store.createProviderModel({ id: 'pvm_delete', providerId: provider.id, model: 'acme-1', label: 'Acme 1' })
  return { built, store, user, repo, providerId: provider.id, modelId: model.id }
}

function actorFor(built: BuiltApp, store: Store, user: UserRow): { cookie: string; csrf: string } {
  const session = sessionFor(built, user)
  // The delete routes are in the recent-auth scope, so a test that means to
  // delete marks the session confirmed instead of replaying the refusal.
  store.markRecentAuth(sha256Hex(session.raw), new Date().toISOString())
  return { cookie: session.cookie, csrf: session.csrf }
}

async function deleteProvider(input: Fixture, cookie: string, csrf: string): Promise<{ location: string; notice: string | undefined }> {
  const response = await input.built.app.inject({
    method: 'POST',
    url: `/settings/providers/${input.providerId}/delete`,
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf }),
  })
  assert.equal(response.statusCode, 302)
  return { location: String(response.headers.location), notice: flashOf(response)?.notice?.text }
}

test('deleting a provider flags every repository that had selected one of its models', async () => {
  const input = await fixture()
  try {
    input.store.setRepoModelSelection(input.repo.id, [input.modelId], input.modelId)
    assert.equal(input.store.getRepo(input.repo.id)?.models_dirty, 1, 'the picker itself already marks the workspace dirty')
    input.store.markRepoModelsApplied(input.repo.id)
    assert.equal(input.store.getRepo(input.repo.id)?.models_dirty, 0, 'the precondition is a clean workspace')
    const { cookie, csrf } = actorFor(input.built, input.store, input.user)
    await deleteProvider(input, cookie, csrf)
    assert.equal(input.store.getRepo(input.repo.id)?.models_dirty, 1, 'a repository that lost its model must offer the restart')
  } finally {
    await input.built.close()
  }
})

test('the delete notice names how many repositories lost their model', async () => {
  const input = await fixture()
  try {
    input.store.setRepoModelSelection(input.repo.id, [input.modelId], input.modelId)
    const second = input.store.createRepo({
      id: 'repo_provider_delete_2', userId: input.user.id, owner: 'o', name: 'r2', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    input.store.setRepoModelSelection(second.id, [input.modelId], input.modelId)
    const { cookie, csrf } = actorFor(input.built, input.store, input.user)
    const result = await deleteProvider(input, cookie, csrf)
    assert.match(String(result.notice), /2 个仓库/, 'the notice must carry the repository count, not a generic sentence')
  } finally {
    await input.built.close()
  }
})

test('a repository that never selected the provider keeps a clean workspace', async () => {
  const input = await fixture()
  try {
    input.store.setRepoModelSelection(input.repo.id, [input.modelId], input.modelId)
    const untouched = input.store.createRepo({
      id: 'repo_provider_delete_untouched', userId: input.user.id, owner: 'o', name: 'r3', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    input.store.markRepoModelsApplied(input.repo.id)
    input.store.markRepoModelsApplied(untouched.id)
    const { cookie, csrf } = actorFor(input.built, input.store, input.user)
    await deleteProvider(input, cookie, csrf)
    assert.equal(input.store.getRepo(untouched.id)?.models_dirty, 0, 'an unaffected repository must not be asked to restart')
  } finally {
    await input.built.close()
  }
})

test('deleting one provider model flags only the repositories that had selected it', async () => {
  const input = await fixture()
  try {
    input.store.setRepoModelSelection(input.repo.id, [input.modelId], input.modelId)
    const other = input.store.createRepo({
      id: 'repo_provider_delete_other', userId: input.user.id, owner: 'o', name: 'r4', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    input.store.markRepoModelsApplied(input.repo.id)
    input.store.markRepoModelsApplied(other.id)
    const { cookie, csrf } = actorFor(input.built, input.store, input.user)
    const response = await input.built.app.inject({
      method: 'POST',
      url: `/settings/providers/${input.providerId}/models/${input.modelId}/delete`,
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf }),
    })
    assert.equal(response.statusCode, 302)
    assert.equal(input.store.getRepo(input.repo.id)?.models_dirty, 1, 'the repository that used the model must be flagged')
    assert.equal(input.store.getRepo(other.id)?.models_dirty, 0, 'a repository on another model must stay clean')
    assert.match(String(flashOf(response)?.notice?.text), /1 个仓库/, 'the notice must count one affected repository')
  } finally {
    await input.built.close()
  }
})

test('the deleted provider leaves an empty selection, which is the silent platform-funded fallback', async () => {
  const input = await fixture()
  try {
    input.store.setRepoModelSelection(input.repo.id, [input.modelId], input.modelId)
    assert.equal(input.store.listRepoModelSelection(input.repo.id).length, 1, 'the repository starts on its own model')
    const { cookie, csrf } = actorFor(input.built, input.store, input.user)
    await deleteProvider(input, cookie, csrf)
    // platformFundedFor() spends platform quota exactly when this list is empty;
    // the flag exists so that spend is a visible decision instead of a silent one.
    assert.equal(input.store.listRepoModelSelection(input.repo.id).length, 0, 'the cascade removes the selection')
  } finally {
    await input.built.close()
  }
})

test('the removal audit records how many repositories were affected', async () => {
  const input = await fixture()
  try {
    input.store.setRepoModelSelection(input.repo.id, [input.modelId], input.modelId)
    const { cookie, csrf } = actorFor(input.built, input.store, input.user)
    await deleteProvider(input, cookie, csrf)
    const audited = input.store.listAudit(50).find((row) => row.action === 'model.provider.removed')
    assert.ok(audited !== undefined, 'the removal must be audited')
    assert.match(String(audited.detail), /repos=1/, 'the audit row must carry the affected repository count')
  } finally {
    await input.built.close()
  }
})

async function deleteProviderIn(locale: 'zh' | 'en', input: Fixture, cookie: string, csrf: string): Promise<{ notice: string | undefined }> {
  const response = await input.built.app.inject({
    method: 'POST',
    url: `/settings/providers/${input.providerId}/delete`,
    headers: { cookie: `${cookie}; ${LOCALE_COOKIE}=${locale}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf }),
  })
  assert.equal(response.statusCode, 302)
  return { notice: flashOf(response)?.notice?.text }
}

test('the count notice reaches an English viewer in English', async () => {
  const input = await fixture()
  try {
    input.store.setRepoModelSelection(input.repo.id, [input.modelId], input.modelId)
    input.store.markRepoModelsApplied(input.repo.id)
    const { cookie, csrf } = actorFor(input.built, input.store, input.user)
    const result = await deleteProviderIn('en', input, cookie, csrf)
    assert.match(String(result.notice), /the model selection of 1 repositories is no longer valid/, 'the English viewer must not receive the Chinese count sentence')
    assert.doesNotMatch(String(result.notice), /个仓库/, 'no Chinese count sentence may survive into an English notice')
  } finally {
    await input.built.close()
  }
})
