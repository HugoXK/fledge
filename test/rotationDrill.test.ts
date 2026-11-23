import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Store } from '../src/db.js'
import { makeUser } from './helpers.js'
import { drillDbRefusal, runRotationDrill } from '../scripts/lib/rotationDrill.js'

function fixture(store: Store) {
  const user = makeUser(store, { login: 'rotation-owner', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_rotation',
    userId: user.id,
    owner: 'octo',
    name: 'rotation',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const job = store.createJob({
    id: 'job_rotation',
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'rotation drill',
    callbackHash: 'cb_rotation',
    platformTokenHash: '',
  })
  return { userId: user.id, repoId: repo.id, jobId: job.id }
}

function key(): string {
  return randomBytes(32).toString('base64')
}

test('the drill refuses an old token and accepts its replacement', () => {
  const store = new Store(':memory:')
  try {
    const ids = fixture(store)
    const result = runRotationDrill({ store, ...ids, key: key() })
    assert.equal(result.ok, true, result.reason ?? 'the drill failed')
    assert.match(result.steps.join('\n'), /refused both old tokens and accepted both replacements/)

    const audit = store.listAudit(20)
    const actions = audit.map((row) => row.action)
    assert.ok(actions.includes('rotation.drill.minted'))
    assert.ok(actions.includes('rotation.drill.rotated'))
    assert.ok(actions.includes('rotation.drill.passed'))
    for (const row of audit) {
      assert.doesNotMatch(String(row.detail ?? ''), /flg_/, 'an audit row must not carry a token')
    }
  } finally {
    store.close()
  }
})

test('a rotation that leaves an old token live fails and records the failure', () => {
  const store = new Store(':memory:')
  try {
    const ids = fixture(store)
    // Simulate a rotation that mints the replacement but never revokes the old
    // rows. The drill must notice and must not report a pass.
    ;(store as unknown as { revokeApiToken: () => void }).revokeApiToken = () => {}
    const result = runRotationDrill({ store, ...ids, key: key() })
    assert.equal(result.ok, false)
    assert.match(String(result.reason), /still accepted/)
    const actions = store.listAudit(20).map((row) => row.action)
    assert.ok(actions.includes('rotation.drill.failed'))
    assert.equal(actions.includes('rotation.drill.passed'), false)
  } finally {
    store.close()
  }
})

test('the drill refuses production, the configured live path and a path outside the temporary root', () => {
  assert.match(
    String(drillDbRefusal({ dbPath: '/tmp/drill.db', env: { NODE_ENV: 'production' } })),
    /NODE_ENV=production/,
  )
  assert.match(
    String(drillDbRefusal({ dbPath: '/tmp/live/drill.db', tempRoot: '/tmp', env: { DATA_DIR: '/tmp/live' } })),
    /live database/,
  )
  assert.match(
    String(drillDbRefusal({ dbPath: '/var/lib/fledge.db', tempRoot: '/tmp', env: {} })),
    /outside the temporary directory/,
  )
  assert.equal(drillDbRefusal({ dbPath: '/tmp/fledge-drill/drill.db', tempRoot: '/tmp', env: {} }), null)
  assert.equal(drillDbRefusal({ env: {} }), null)
})
