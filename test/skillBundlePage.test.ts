import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import type { JobRow } from '../src/db.js'
import { repoPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #380: the repository page has to show which skill bundles a job loaded and
// where each came from. A page that only shows the happy path is how a revoked
// bundle stays invisible until a merge goes wrong.

const SOURCE = 'repo:o/r'
const HASH = 'a'.repeat(64)
const CONTENT_HASH = 'b'.repeat(64)

test('the repository page shows the loaded skill bundles with their provenance and hash', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'bundle-page-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bundle_page', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const stored = store.createJob({
      id: 'job_bundle_page',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: 'cb',
      platformTokenHash: '',
    })
    // The shape the dispatch writes once the bundle is attested. The fixture
    // states it directly so this test is about the page, not about the writer.
    const job = {
      ...stored,
      skill_bundle_hash: HASH,
      skill_bundle_json: JSON.stringify({
        hash: HASH,
        decision: 'accepted',
        bundles: [{ name: 'skill:triage', source: SOURCE, version: 1, contentHash: CONTENT_HASH, state: 'accepted' }],
      }),
      skill_state: 'accepted',
    } as JobRow
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const en = repoPage({ config, locale: 'en', viewer, repo, jobs: [job] })
    assert.match(en, /Skill bundles/)
    assert.match(en, /skill:triage/)
    assert.match(en, /repo:o\/r/)
    assert.match(en, new RegExp(HASH.slice(0, 12)))
    assert.match(en, /accepted/i)

    const zh = repoPage({ config, locale: 'zh', viewer, repo, jobs: [job] })
    assert.match(zh, /技能包/)
  } finally {
    store.close()
  }
})

test('the repository page says no bundle was loaded when the latest job recorded none', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'bundle-page-empty-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bundle_page_empty', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const job = store.createJob({ id: 'job_bundle_page_empty', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const en = repoPage({ config, locale: 'en', viewer, repo, jobs: [job] })
    assert.match(en, /Skill bundles/)
    assert.match(en, /No attested bundles/)
  } finally {
    store.close()
  }
})

test('a maintainer gets the revoke control for each recorded source', () => {
  const config = testConfig()
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'bundle-source-owner', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bundle_source', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.ensureSkillBundleSource({ repoId: repo.id, source: SOURCE, updatedBy: 'system:first-load' })
    const viewer = { user: store.userById(user.id)!, csrfToken: 'csrf' }
    const html = repoPage({ config, locale: 'en', viewer, repo, jobs: [], skillSources: store.listSkillBundleSources(repo.id), canMaintain: true })
    assert.ok(html.includes('/repos/repo_bundle_source/skill-source'), 'the owner path is a form on the page')
    assert.match(html, /name="source" value="repo:o\/r"/)
    assert.match(html, /Revoke this source/)
    // The control follows the actor, not the upstream declaration: a developer
    // does not get the write control even when the repository says maintainer.
    store.updateRepo(repo.id, { repo_role: 'maintainer' })
    const developer = repoPage({ config, locale: 'en', viewer, repo: store.getRepo(repo.id)!, jobs: [], skillSources: store.listSkillBundleSources(repo.id), canMaintain: false })
    assert.equal(developer.includes('/repos/repo_bundle_source/skill-source'), false)
  } finally {
    store.close()
  }
})
