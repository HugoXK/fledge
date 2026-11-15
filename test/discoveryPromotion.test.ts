import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { promoteDiscoveredIssue } from '../src/jobs/discoveryPromotion.js'
import { makeUser, testConfig } from './helpers.js'

function fixture() {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'discovery-promote', status: 'approved' })
  const repo = store.createRepo({ id: 'repo_discovery_promote', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  return { store, user, repo }
}

const now = new Date('2026-11-15T00:00:00.000Z')
const issue = (n: number) => `https://github.com/o/r/issues/${String(n)}`

test('discovery promotion is off by default and never creates a work item', () => {
  const { store, user, repo } = fixture()
  try {
    const result = promoteDiscoveredIssue(store, testConfig(), { repoId: repo.id, userId: user.id, issueUrl: issue(1), now })
    assert.equal(result.status, 'disabled')
    assert.equal(store.findWorkItemByIssueUrl(repo.id, issue(1)), undefined)
  } finally {
    store.close()
  }
})

test('an enabled promotion creates one proposed work item, dedupes the issue and caps the day', () => {
  const { store, user, repo } = fixture()
  try {
    const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 2 })
    const first = promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(1), title: 'First discovered issue', now })
    assert.equal(first.status, 'promoted')
    const item = store.getWorkItem(first.workItemId ?? '')
    assert.ok(item !== undefined)
    assert.equal(item.state, 'proposed')
    assert.equal(item.issue_url, issue(1))
    assert.equal(item.pr_url, null)

    const duplicate = promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(1), now })
    assert.equal(duplicate.status, 'duplicate')
    assert.equal(duplicate.workItemId, first.workItemId)

    const second = promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(2), now })
    assert.equal(second.status, 'promoted')

    const capped = promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(3), now })
    assert.equal(capped.status, 'cap')
    assert.equal(store.findWorkItemByIssueUrl(repo.id, issue(3)), undefined)
    assert.equal(store.getSetting('discover-promote:2026-11-15'), '2')
  } finally {
    store.close()
  }
})

test('a discovery result without an issue URL is not promoted', () => {
  const { store, user, repo } = fixture()
  try {
    const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 3 })
    assert.equal(promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: null, now }).status, 'no-issue')
  } finally {
    store.close()
  }
})
