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
    assert.equal(store.getSetting(`discover-promote:${repo.id}:2026-11-15`), '2')
  } finally {
    store.close()
  }
})

// #803 says only "The setting has a daily cap". A deployment-wide counter let
// one repository spend every other repository's day, so the cap is per
// repository: a busy repository cannot starve a quiet one.
test('the daily cap is per repository', () => {
  const { store, user, repo } = fixture()
  const other = store.createRepo({ id: 'repo_discovery_promote_b', userId: user.id, owner: 'o', name: 'r2', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
  try {
    const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 1 })
    assert.equal(promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(1), now }).status, 'promoted')
    assert.equal(promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(2), now }).status, 'cap')
    assert.equal(promoteDiscoveredIssue(store, config, { repoId: other.id, userId: user.id, issueUrl: issue(3), now }).status, 'promoted')
  } finally {
    store.close()
  }
})

// A non-numeric setting reads as NaN, and `NaN >= cap` is false forever, so one
// bad write used to switch the cap off for good. A corrupt value counts as 0 and
// the next promotion rewrites a finite number.
test('a corrupt counter value cannot switch the cap off', () => {
  const { store, user, repo } = fixture()
  try {
    const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 1 })
    assert.equal(promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(1), now }).status, 'promoted')
    const counter = store.listSettings('discover-promote')[0]
    assert.ok(counter !== undefined)
    store.setSetting(counter.key, 'not-a-number')
    assert.equal(promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(2), now }).status, 'promoted')
    assert.equal(promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(3), now }).status, 'cap')
  } finally {
    store.close()
  }
})

test('a promoted work item keeps the priority it was given', () => {
  const { store, user, repo } = fixture()
  try {
    const config = testConfig({ autoPromoteDiscovery: true, autoPromoteDiscoveryDailyCap: 3 })
    const result = promoteDiscoveredIssue(store, config, { repoId: repo.id, userId: user.id, issueUrl: issue(1), priority: 2, now })
    assert.equal(result.status, 'promoted')
    assert.equal(store.getWorkItem(result.workItemId ?? '')?.priority, 2)
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
