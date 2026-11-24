import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { buildIncidentBundle, configFingerprint, incidentMarkdown, parseIncidentWindow } from '../src/lib/incident.js'
import { MemoryMailer, makeUser, sessionFor, testConfig } from './helpers.js'

test('a window is 1h through 24h, and nothing else', () => {
  const now = new Date('2026-11-24T12:00:00.000Z')
  const one = parseIncidentWindow('1h', now)
  assert.equal(one.ok, true)
  if (!one.ok) return
  assert.equal(one.window.hours, 1)
  assert.equal(one.window.since, '2026-11-24T11:00:00.000Z')

  const day = parseIncidentWindow('24h', now)
  assert.equal(day.ok, true)
  for (const value of ['0h', '25h', '1d', 'abc', '']) {
    assert.equal(parseIncidentWindow(value, now).ok, false, value)
  }
})

test('the config fingerprint carries names only', () => {
  const config = testConfig()
  const fingerprint = configFingerprint(config)
  assert.ok(fingerprint.sections.includes('quota'))
  assert.ok(fingerprint.keys.includes('quota.initialCny'))
  assert.ok(fingerprint.keys.includes('sessionSecret'))
  assert.equal(JSON.stringify(fingerprint).includes(config.sessionSecret), false)
})

test('the bundle redacts a planted token in an audit row and a job event', () => {
  const store = new Store(':memory:')
  try {
    const config = testConfig()
    const user = makeUser(store, { login: 'incident-owner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_incident',
      userId: user.id,
      owner: 'octo',
      name: 'incident',
      defaultBranch: 'main',
      tokenEnc: 'x',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const job = store.createJob({
      id: 'job_incident',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'incident bundle',
      callbackHash: 'cb_incident',
      platformTokenHash: '',
    })
    const now = new Date()
    const parsed = parseIncidentWindow('1h', now)
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    const token = `flg_${'A'.repeat(32)}`
    store.audit(user.id, 'incident.test', `token ${token}`)
    store.run(
      'INSERT INTO job_events (at, job_id, repo_id, user_id, kind, role, step, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      now.toISOString(),
      job.id,
      repo.id,
      user.id,
      'step',
      'dev1',
      'test',
      `meta ${token}`,
    )

    const bundle = buildIncidentBundle({ store, config, window: parsed.window, now: now.toISOString() })
    assert.equal(bundle.window.label, '1h')
    assert.ok(bundle.counts.jobs >= 1)
    assert.ok(bundle.jobEvents.length >= 1)
    assert.ok(bundle.audit.length >= 1)
    assert.ok(bundle.unavailable.some((entry) => entry.startsWith('clock:')))
    assert.ok(bundle.unavailable.some((entry) => entry.startsWith('router:')))
    assert.ok(bundle.unavailable.some((entry) => entry.startsWith('deployments:')))
    assert.ok(bundle.alerts.every((alert) => !alert.message.includes(token)))

    const text = JSON.stringify(bundle)
    assert.equal(text.includes(token), false)
    assert.match(text, /redacted-fledge-token/)
    assert.equal(text.includes(config.sessionSecret), false)
    const markdown = incidentMarkdown(bundle)
    assert.match(markdown, /# Fledge incident bundle/)
    assert.equal(markdown.includes(token), false)
  } finally {
    store.close()
  }
})

test('the admin route exports JSON and markdown, refuses a wide window, and is superadmin-only', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'incident-admin', superadmin: true, status: 'approved' })
    const normal = makeUser(store, { login: 'incident-user', status: 'approved' })
    const adminSession = sessionFor(built, admin)
    const normalSession = sessionFor(built, normal)

    const json = await built.app.inject({ method: 'GET', url: '/admin/incident/1h', headers: { cookie: adminSession.cookie } })
    assert.equal(json.statusCode, 200, json.body)
    assert.match(String(json.headers['content-type']), /application\/json/)
    const body = json.json() as { window: { label: string }; counts: { jobs: number } }
    assert.equal(body.window.label, '1h')
    assert.ok(body.counts.jobs >= 0)

    const markdown = await built.app.inject({ method: 'GET', url: '/admin/incident/1h?format=markdown', headers: { cookie: adminSession.cookie } })
    assert.equal(markdown.statusCode, 200, markdown.body)
    assert.match(String(markdown.headers['content-type']), /text\/markdown/)
    assert.match(markdown.body, /# Fledge incident bundle/)

    const tooWide = await built.app.inject({ method: 'GET', url: '/admin/incident/25h', headers: { cookie: adminSession.cookie } })
    assert.equal(tooWide.statusCode, 400)

    const refused = await built.app.inject({ method: 'GET', url: '/admin/incident/1h', headers: { cookie: normalSession.cookie } })
    assert.equal(refused.statusCode, 403)
  } finally {
    await built.close()
  }
})
