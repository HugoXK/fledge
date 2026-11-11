import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/db.js'
import { WORK_ITEM_TRANSITIONS, type WorkItemState } from '../src/lib/workItems.js'
import { makeUser } from './helpers.js'

// A job superseded as a duplicate is failed by the index migration, but the work
// item it was running used to stay `in_progress` forever: the board showed work
// that could never move. The item sits on the *older* running row on purpose —
// the sweep keeps the newest running row, so an item on the kept row would pass
// whether or not the reset exists.
test('a superseded duplicate resets its work item to triaged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-dupe-item-'))
  const path = join(dir, 'fledge.db')
  try {
    const store = new Store(path)
    const user = makeUser(store, { login: 'dupe-item-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_dupe_item',
      userId: user.id,
      owner: 'o',
      name: 'dupe-item',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    // A file written before the invariant existed may already hold two active
    // rows for one repository; seed exactly that so reopening has to resolve it.
    store.db.exec('DROP INDEX IF EXISTS jobs_one_active_per_repo')
    store.createJob({ id: 'job_item_old', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'old', callbackHash: 'cb_old', platformTokenHash: '', workItemId: 'work_item_dupe' })
    store.createJob({ id: 'job_item_new', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'new', callbackHash: 'cb_new', platformTokenHash: '' })
    store.updateJob('job_item_old', { status: 'running' })
    store.updateJob('job_item_new', { status: 'running' })
    store.db.exec("UPDATE jobs SET created_at = '2026-01-01T00:00:01.000Z' WHERE id = 'job_item_old'")
    store.db.exec("UPDATE jobs SET created_at = '2026-01-01T00:00:02.000Z' WHERE id = 'job_item_new'")
    // The dispatching job had already moved the item to in_progress.
    store.createWorkItem({ id: 'work_item_dupe', repoId: repo.id, userId: user.id, title: 'claim this', state: 'in_progress', jobId: 'job_item_old' })
    store.close()

    const reopened = new Store(path)
    try {
      // The sweep keeps the newest running row and fails the older one.
      assert.equal(reopened.getJob('job_item_new')?.status, 'running')
      assert.equal(reopened.getJob('job_item_old')?.status, 'failed')
      assert.equal(reopened.getJob('job_item_old')?.error, 'JOB_DUPLICATE_ACTIVE_SUPERSEDED')
      // Exactly triaged: the item needs a new dispatch decision, not a vague
      // "not in progress", so a future state cannot satisfy this by accident.
      assert.equal(reopened.getWorkItem('work_item_dupe')?.state, 'triaged')
      // The audit line names both ids, so the record explains itself.
      const superseded = reopened.listAudit(20).filter((row) => row.action === 'job.duplicate_active_superseded')
      assert.equal(superseded.length, 1)
      const detail = superseded[0]?.detail ?? ''
      assert.match(detail, /job_item_old/)
      assert.match(detail, /work_item_dupe/)
      // The reset is a legal edge in the published map, not a new one.
      assert.ok((WORK_ITEM_TRANSITIONS.in_progress as readonly WorkItemState[]).includes('triaged'))
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
