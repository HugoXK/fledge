import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { filterTrials, trialCounts, trialStateOf } from '../src/lib/trials.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #279: after the preview sweep (#265) the only record of a trial decision is a
// `trial.expired` audit row, so an operator had to open the database to see who is
// approaching expiry, who is exempt and who was revoked. These cases pin the
// derivation (registration age, repository use, role, status, audit row) and the
// admin-only read path. Age is simulated by moving the clock, not the row, so the
// fixture stays a plain registration.

const DAY = 86_400_000

function candidates(store: Store) {
  return store.trialCandidates()
}

test('six days without a repository is expiring soon, not expired', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'day6', status: 'approved' })
    const row = candidates(store).find((entry) => entry.id === user.id)!
    const view = trialStateOf(row, Date.parse(row.created_at) + 6 * DAY + 3_600_000)
    assert.equal(view.days, 6)
    assert.equal(view.state, 'expiring')
  } finally {
    store.close()
  }
})

test('eight days without a repository is eligible, with a repository it is exempt', () => {
  const store = new Store(':memory:')
  try {
    const bare = makeUser(store, { login: 'bare8', status: 'approved' })
    const used = makeUser(store, { login: 'used8', status: 'approved' })
    store.createRepo({ id: 'repo_used8', userId: used.id, owner: 'acme', name: 'demo', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const rows = candidates(store)
    const now = Date.parse(rows[0]!.created_at) + 8 * DAY
    assert.equal(trialStateOf(rows.find((entry) => entry.id === bare.id)!, now).state, 'eligible')
    assert.equal(trialStateOf(rows.find((entry) => entry.id === used.id)!, now).state, 'exempt_used')
  } finally {
    store.close()
  }
})

test('a repository that was added and removed still exempts the account', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'past-repo', status: 'approved' })
    store.audit(user.id, 'repo.added', 'acme/demo')
    const row = candidates(store).find((entry) => entry.id === user.id)!
    assert.equal(trialStateOf(row, Date.parse(row.created_at) + 8 * DAY).state, 'exempt_used')
  } finally {
    store.close()
  }
})

test('an admin without a repository is exempt as an admin', () => {
  const store = new Store(':memory:')
  try {
    const admin = makeUser(store, { login: 'boss', admin: true, status: 'approved' })
    const row = candidates(store).find((entry) => entry.id === admin.id)!
    assert.equal(trialStateOf(row, Date.parse(row.created_at) + 8 * DAY).state, 'exempt_admin')
  } finally {
    store.close()
  }
})

test('a revoked account shows expired with the sweep time and is not counted again', () => {
  const store = new Store(':memory:')
  try {
    const revoked = makeUser(store, { login: 'revoked', status: 'approved' })
    const expiredAt = new Date(Date.parse(candidates(store).find((entry) => entry.id === revoked.id)!.created_at) + 8 * DAY).toISOString()
    store.audit(revoked.id, 'trial.expired', null)
    const rows = candidates(store).map((row) => trialStateOf(row, Date.parse(expiredAt) + 60_000))
    const view = rows.find((row) => row.id === revoked.id)!
    assert.equal(view.state, 'expired')
    assert.notEqual(view.expiredAt, null)
    assert.deepEqual(filterTrials(rows, 'eligible').filter((row) => row.id === revoked.id), [], 'an expired account is counted as eligible again')
    assert.equal(trialCounts(rows).expired, 1)
  } finally {
    store.close()
  }
})

test('a pending account is neither eligible nor expiring', () => {
  const store = new Store(':memory:')
  try {
    const pending = makeUser(store, { login: 'pending-user', status: 'pending' })
    const row = candidates(store).find((entry) => entry.id === pending.id)!
    assert.equal(trialStateOf(row, Date.parse(row.created_at) + 9 * DAY).state, 'inactive')
  } finally {
    store.close()
  }
})

test('the admin console shows the trial states and no email address', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'boss', admin: true, status: 'approved' })
    const eligible = makeUser(store, { login: 'eligible-user', status: 'approved' })
    const expiring = makeUser(store, { login: 'expiring-user', status: 'approved' })
    const revoked = makeUser(store, { login: 'revoked-user', status: 'approved' })
    store.audit(revoked.id, 'trial.expired', null)
    const createdAt = Date.parse(candidates(store).find((entry) => entry.id === eligible.id)!.created_at)

    // The route reads the wall clock, so age is driven through the store: a row
    // registered 8 days ago is what an operator sees, whichever clock runs.
    const backdate = (days: number, id: string): void => {
      const at = new Date(createdAt - days * DAY + 60_000).toISOString()
      store['run'](`UPDATE users SET created_at = ? WHERE id = ?`, at, id)
    }
    backdate(8, eligible.id)
    backdate(6, expiring.id)
    backdate(8, revoked.id)
    backdate(0, admin.id)

    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin/trials', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /eligible-user/)
    assert.match(page.body, /expiring-user/)
    assert.match(page.body, /revoked-user/)
    assert.match(page.body, /for expiry|可到期/, 'the eligible badge is missing')
    assert.match(page.body, /expiring soon|即将到期/, 'the expiring badge is missing')
    assert.match(page.body, /trial\.expired|已过期|expired/i, 'the expired badge or audit time is missing')
    assert.doesNotMatch(page.body, /eligible-user@example\.com/, 'the table leaked an email address')
    assert.doesNotMatch(page.body, /<form[^>]*method="post"[^>]*action="\/admin\/trials/, 'the trial view must not write anything')

    const filtered = await built.app.inject({ method: 'GET', url: '/admin/trials?trial=eligible', headers: { cookie } })
    assert.equal(filtered.statusCode, 200)
    assert.match(filtered.body, /eligible-user/)
    assert.doesNotMatch(filtered.body, /expiring-user/, 'the eligible filter kept an expiring account')
  } finally {
    // built.close() closes the store it was handed.
    await built.close()
  }
})

test('a non-admin cannot open the trial view', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const plain = makeUser(store, { login: 'plain', status: 'approved' })
    const { cookie } = sessionFor(built, plain)
    const page = await built.app.inject({ method: 'GET', url: '/admin/trials', headers: { cookie } })
    assert.ok(page.statusCode === 403 || page.statusCode === 404, `a non-admin got ${page.statusCode}`)
  } finally {
    // built.close() closes the store it was handed.
    await built.close()
  }
})
