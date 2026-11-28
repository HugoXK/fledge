import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/db.js'
import { makeTerminalJob, makeUser } from './helpers.js'

// #1300: `makeTerminalJob` stamped `finished_at` with the wall clock and took no
// instant, so a page rendered from one of its rows could not be reproduced. The
// fixture now accepts the instant it should store; the default stays the wall
// clock so the existing call sites are untouched.
test('a fixture written for a fixed instant keeps that instant', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'clock-fixture-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_clock_fixture',
      userId: user.id,
      owner: 'acme',
      name: 'demo',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: true,
      intervalMinutes: 1440,
    })
    const instant = '2026-11-23T21:25:43.500Z'
    const job = makeTerminalJob(store, {
      id: 'job_clock_fixture',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'g',
      callbackHash: 'h',
      platformTokenHash: 't',
      kind: 'iterate',
      baseBranch: 'main',
      createdAt: instant,
    }, { finishedAt: instant })
    assert.equal(job.finished_at, instant, 'the fixture stores the instant it was given instead of the wall clock')
  } finally {
    store.close()
  }
})
