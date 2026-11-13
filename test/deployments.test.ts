import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { assessDeploymentDrift, evaluateCanaryGate, latestReleaseFromStatus } from '../src/lib/deployments.js'
import { MockRunner } from '../src/jobs/mock.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const DIGEST_OLD = `sha256:${'1'.repeat(64)}`
const DIGEST_NEW = `sha256:${'2'.repeat(64)}`

function deployment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    environment: 'production',
    version: '0.3.2',
    commit: C,
    imageDigest: DIGEST_NEW,
    deployedAt: '2026-11-13T10:00:00.000Z',
    operator: 'release-bot',
    healthz: { ok: true, status: 200, version: '0.3.2', commit: C },
    readyz: { ok: true, status: 200 },
    releaseUrl: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.2',
    ...overrides,
  }
}

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: '0.3.2', commit: C, tag: 'v0.3.2', url: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.2', ...overrides }
}

function canary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    healthz: { ok: true, status: 200, version: '0.3.2', commit: C },
    readyz: { ok: true, status: 200 },
    smoke: { ok: true, jobId: 'job_smoke_1' },
    errorWindow: { ok: true, windowMinutes: 30, errors: 0 },
    latencyWindow: { ok: true, windowMinutes: 30, p95Ms: 120 },
    ...overrides,
  }
}

function promotionBody(overrides: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
  return {
    environment: 'production',
    version: '0.3.2',
    commit: C,
    image_digest: DIGEST_NEW,
    deployed_at: '2026-11-13T10:00:00.000Z',
    operator: 'release-bot',
    release_url: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.2',
    healthz_ok: '1',
    healthz_status: 200,
    healthz_version: '0.3.2',
    healthz_commit: C,
    readyz_ok: '1',
    readyz_status: 200,
    smoke_ok: '1',
    smoke_job: 'job_smoke_1',
    error_ok: '1',
    error_window_minutes: 30,
    error_count: 0,
    latency_ok: '1',
    latency_window_minutes: 30,
    latency_p95_ms: 120,
    ...overrides,
  }
}

function rollbackBody(overrides: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
  return {
    environment: 'production',
    previous_digest: DIGEST_OLD,
    previous_commit: A,
    owner: 'on-call',
    command: `docker pull ghcr.io/hugoxk/fledge@${DIGEST_OLD}`,
    decision: 'rollback',
    healthz_ok: '1',
    healthz_status: 200,
    healthz_commit: A,
    ...overrides,
  }
}

test('production at v0.3.0 while v0.3.2 is released shows drift and alerts', () => {
  const drift = assessDeploymentDrift({
    deployment: deployment({ version: '0.3.0', commit: A, imageDigest: DIGEST_OLD }),
    release: release(),
  })
  assert.equal(drift.state, 'behind')
  assert.equal(drift.alert, true)
  assert.match(drift.summary, /v0\.3\.0/)
  assert.match(drift.summary, /v0\.3\.2/)
  assert.equal(drift.release?.version, '0.3.2')
  assert.equal(drift.deployment?.version, '0.3.0')
})

test('a release snapshot with no tag target is not a released version', () => {
  const snapshot = {
    schema: 1,
    version: '0.3.2',
    checkedAt: '2026-11-13T12:00:00.000Z',
    baseUrl: '',
    ok: false,
    links: [],
    problems: ['tag: missing'],
    targetSha: '',
    releaseUrl: '',
  }
  assert.equal(latestReleaseFromStatus(snapshot), null)
  assert.equal(latestReleaseFromStatus({ ...snapshot, targetSha: C })?.version, '0.3.2')
})

test('a released version that matches the running deployment with matching healthz is not drift', () => {
  const drift = assessDeploymentDrift({ deployment: deployment(), release: release(), healthz: { ok: true, version: '0.3.2', commit: C } })
  assert.equal(drift.state, 'ok')
  assert.equal(drift.alert, false)
})

test('a /healthz commit that does not match the recorded deploy is a mismatch', () => {
  const live = assessDeploymentDrift({ deployment: deployment(), release: release(), healthz: { ok: true, version: '0.3.2', commit: D } })
  assert.equal(live.state, 'mismatch')
  assert.equal(live.alert, true)
  assert.match(live.summary, /healthz/i)

  const recorded = assessDeploymentDrift({
    deployment: deployment({ healthz: { ok: true, status: 200, version: '0.3.2', commit: D } }),
    release: release(),
  })
  assert.equal(recorded.state, 'mismatch')
  assert.equal(recorded.alert, true)
})

test('the canary gate fails closed when evidence is missing and blocks a failed smoke job', () => {
  assert.equal(evaluateCanaryGate(canary(), { commit: C, version: '0.3.2' }).ok, true)

  const smoke = evaluateCanaryGate(canary({ smoke: { ok: false, jobId: 'job_smoke_1' } }), { commit: C })
  assert.equal(smoke.ok, false)
  assert.ok(smoke.blocked.some((entry) => entry.includes('smoke')))

  const missing = evaluateCanaryGate(canary({ errorWindow: null }), { commit: C })
  assert.equal(missing.ok, false)
  assert.ok(missing.blocked.some((entry) => entry.includes('error window')))

  const noCommit = evaluateCanaryGate(canary({ healthz: { ok: true, status: 200 } }), { commit: C })
  assert.equal(noCommit.ok, false)
})

test('a failed canary smoke job blocks the promotion record', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fledge-deployments-'))
  const config = testConfig({ dataDir })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'deploy-admin', admin: true, status: 'approved' })
    const session = sessionFor(built, admin)
    const blocked = await built.app.inject({
      method: 'POST',
      url: '/admin/deployments/promote',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, ...promotionBody({ smoke_ok: '0' }) }),
    })
    assert.equal(blocked.statusCode, 302)
    assert.match(String(blocked.headers.location), /error=/)
    assert.equal(store.listDeployments('production').length, 0, 'a failed gate must not create a deployment record')

    const promoted = await built.app.inject({
      method: 'POST',
      url: '/admin/deployments/promote',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, ...promotionBody() }),
    })
    assert.equal(promoted.statusCode, 302)
    assert.match(String(promoted.headers.location), /notice=/)
    const rows = store.listDeployments('production')
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.version, '0.3.2')
    assert.equal(rows[0]?.commit_sha, C)
    assert.equal(rows[0]?.image_digest, DIGEST_NEW)
  } finally {
    await built.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a rollback plan names the previous digest and commit, and records a verified healthz', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fledge-deployments-'))
  const config = testConfig({ dataDir })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'rollback-admin', admin: true, status: 'approved' })
    const session = sessionFor(built, admin)
    store.recordDeployment({
      environment: 'production',
      version: '0.3.2',
      commit: C,
      imageDigest: DIGEST_NEW,
      deployedAt: '2026-11-13T10:00:00.000Z',
      operator: 'release-bot',
      healthz: { ok: true, status: 200, version: '0.3.2', commit: C },
      readyz: { ok: true, status: 200 },
      releaseUrl: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.2',
      gate: { ok: true, checks: [], blocked: [] },
    })
    store.recordDeployment({
      environment: 'production',
      version: '0.3.0',
      commit: A,
      imageDigest: DIGEST_OLD,
      deployedAt: '2026-11-10T10:00:00.000Z',
      operator: 'release-bot',
      healthz: { ok: true, status: 200, version: '0.3.0', commit: A },
      readyz: { ok: true, status: 200 },
      releaseUrl: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.0',
      gate: { ok: true, checks: [], blocked: [] },
    })

    const missing = await built.app.inject({
      method: 'POST',
      url: '/admin/deployments/rollback',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, ...rollbackBody({ previous_digest: `sha256:${'9'.repeat(64)}` }) }),
    })
    assert.equal(missing.statusCode, 302)
    assert.match(String(missing.headers.location), /error=/)
    assert.equal(store.listDeploymentRollbacks('production').length, 0)

    const recorded = await built.app.inject({
      method: 'POST',
      url: '/admin/deployments/rollback',
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf, ...rollbackBody() }),
    })
    assert.equal(recorded.statusCode, 302)
    assert.match(String(recorded.headers.location), /notice=/)
    const plans = store.listDeploymentRollbacks('production')
    assert.equal(plans.length, 1)
    assert.equal(plans[0]?.previous_digest, DIGEST_OLD)
    assert.equal(plans[0]?.previous_commit, A)
    assert.equal(plans[0]?.owner, 'on-call')
    assert.match(String(plans[0]?.command), /sha256:/)
    assert.equal(plans[0]?.verified, 1)

    const page = await built.app.inject({ method: 'GET', url: '/admin/deployments', headers: { cookie: session.cookie, 'accept-language': 'en' } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, new RegExp(DIGEST_OLD))
    assert.match(page.body, new RegExp(A.slice(0, 12)))
  } finally {
    await built.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a non-admin cannot read or write deployment records', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fledge-deployments-'))
  const config = testConfig({ dataDir })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'plain-user', status: 'approved' })
    const session = sessionFor(built, user)
    for (const url of ['/admin/deployments', '/api/admin/deployments']) {
      const page = await built.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } })
      assert.equal(page.statusCode, 403, `${url} must be admin-only`)
    }
    for (const url of ['/admin/deployments/promote', '/admin/deployments/rollback']) {
      const write = await built.app.inject({
        method: 'POST',
        url,
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: formBody({ csrf: session.csrf, ...promotionBody() }),
      })
      assert.equal(write.statusCode, 403, `${url} must refuse a non-admin`)
    }
    assert.equal(store.listDeployments(null).length, 0)
  } finally {
    await built.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('the deployment page shows release drift without exposing tokens or host paths', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fledge-deployments-'))
  writeFileSync(
    join(dataDir, 'release-status.json'),
    JSON.stringify({
      schema: 1,
      version: '0.3.2',
      checkedAt: '2026-11-13T11:00:00.000Z',
      baseUrl: 'https://fledge.example',
      ok: true,
      links: [{ id: 'release', state: 'ok', detail: 'released' }],
      problems: [],
      targetSha: C,
      releaseUrl: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.2',
    }),
  )
  const secret = 'metrics-secret-value'
  const config = testConfig({ dataDir, metrics: { token: secret } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'drift-admin', admin: true, status: 'approved' })
    const session = sessionFor(built, admin)
    store.recordDeployment({
      environment: 'production',
      version: '0.3.0',
      commit: A,
      imageDigest: DIGEST_OLD,
      deployedAt: '2026-11-10T10:00:00.000Z',
      operator: 'release-bot',
      healthz: { ok: true, status: 200, version: '0.3.0', commit: A },
      readyz: { ok: true, status: 200 },
      releaseUrl: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.0',
      gate: { ok: true, checks: [], blocked: [] },
    })
    store.recordDeploymentRollback({
      environment: 'production',
      fromDeploymentId: null,
      previousDeploymentId: store.listDeployments('production')[0]!.id,
      previousDigest: DIGEST_OLD,
      previousCommit: A,
      owner: 'on-call',
      command: `deploy token=${secret} --image ghcr.io/hugoxk/fledge@${DIGEST_OLD}`,
      decision: 'rollback',
      healthz: { ok: true, status: 200, commit: A },
      verified: true,
    })

    const page = await built.app.inject({ method: 'GET', url: '/admin/deployments', headers: { cookie: session.cookie, 'accept-language': 'en' } })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /behind/)
    assert.match(page.body, /v0\.3\.2/)
    assert.doesNotMatch(page.body, new RegExp(secret))
    assert.doesNotMatch(page.body, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const json = await built.app.inject({ method: 'GET', url: '/api/admin/deployments', headers: { cookie: session.cookie } })
    assert.equal(json.statusCode, 200)
    assert.doesNotMatch(json.body, new RegExp(secret))
    assert.doesNotMatch(json.body, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(JSON.parse(json.body).environments[0].drift.state, 'behind')
  } finally {
    await built.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

function chainFixture(): Record<string, unknown> {
  return {
    version: '0.3.2',
    packageVersion: '0.3.2',
    checkedAt: '2026-11-13T12:00:00Z',
    plan: { version: '0.3.2', mainSha: A, plannedAt: '2026-11-13T11:00:00Z' },
    branch: { name: 'release/v0.3.2', tip: B, deleted: false },
    pull: { number: 395, state: 'merged', headSha: B, mergeCommitSha: C, mergedAt: '2026-11-13T11:20:00Z', base: 'main' },
    tag: { name: 'v0.3.2', objectSha: D, objectType: 'tag', targetSha: C },
    image: { tag: 'ghcr.io/hugoxk/fledge:v0.3.2', digest: DIGEST_NEW },
    sbom: { present: true, name: 'fledge-sbom-v0.3.2' },
    attestation: { present: true, subjectDigest: DIGEST_NEW },
    release: { url: 'https://github.com/HugoXK/fledge/releases/tag/v0.3.2', tagName: 'v0.3.2', publishedAt: '2026-11-13T11:30:00Z', draft: false },
    baseUrl: '',
    healthz: null,
  }
}

test('verify-release alerts when a supplied deployment is behind the released tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-deployments-'))
  try {
    const fixtures = join(dir, 'chain.json')
    const recorded = join(dir, 'deployment.json')
    writeFileSync(fixtures, JSON.stringify(chainFixture()))
    writeFileSync(recorded, JSON.stringify(deployment({ version: '0.3.0', commit: A, imageDigest: DIGEST_OLD })))
    const behind = spawnSync(
      process.execPath,
      ['scripts/verify-release.mjs', '--fixtures', fixtures, '--version', '0.3.2', '--deployment', recorded],
      { encoding: 'utf8' },
    )
    assert.equal(behind.status, 1, behind.stderr)
    assert.match(behind.stdout, /deployment\s+mismatch\s+behind:/)
    assert.match(behind.stdout, /v0\.3\.0/)

    writeFileSync(recorded, JSON.stringify(deployment({ version: '0.3.2', commit: C, imageDigest: DIGEST_NEW })))
    const green = spawnSync(
      process.execPath,
      ['scripts/verify-release.mjs', '--fixtures', fixtures, '--version', '0.3.2', '--deployment', recorded],
      { encoding: 'utf8' },
    )
    assert.equal(green.status, 0, green.stderr)
    assert.match(green.stdout, /deployment\s+ok\s+ok:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
