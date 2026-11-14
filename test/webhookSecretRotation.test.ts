import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { MemoryMailer, testConfig } from './helpers.js'

// #466: the webhook secret is a single global value with no rotation path, so a
// leak means a flag day. The pair below is the whole mechanism: the previous
// value is accepted only until its own ISO instant, and the same two values are
// what `/healthz` reports, so the status cannot drift from the verifier.
const CURRENT = 'rotation-current-secret-466'
const PREVIOUS = 'rotation-previous-secret-466'
const NEW = 'rotation-new-secret-466'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// The pair is turned into a decision in one place, and `/healthz` reads that
// decision rather than keeping a second copy of the rules. A tree that has not
// learned this yet must fail here, loudly, instead of passing by accident.
type WebhookSecretConfig = Pick<Config['githubApp'], 'webhookSecret' | 'webhookSecretPrevious' | 'webhookSecretPreviousUntil'>
interface RotationHelpers {
  webhookSecretSlot(app: WebhookSecretConfig, now?: number): 'none' | 'current' | 'previous'
  checkWebhookSignature(app: WebhookSecretConfig, payload: Buffer, signature: string, now?: number): { ok: boolean; slot: 'current' | 'previous' | null; superseded: boolean }
}

async function rotationHelpers(): Promise<RotationHelpers> {
  const module = (await import('../src/repos/app.js')) as unknown as Partial<RotationHelpers>
  assert.equal(typeof module.webhookSecretSlot, 'function', 'the verifier must expose the active slot, not just a boolean')
  assert.equal(typeof module.checkWebhookSignature, 'function', 'the verifier must report which slot matched and whether a retired one was used')
  return module as RotationHelpers
}

function sign(secret: string, raw: Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`
}

function appConfig(rotation: { previous?: string; until?: string } = {}, metricsToken = ''): Config {
  return testConfig({
    metrics: { token: metricsToken },
    githubApp: {
      id: '1',
      slug: 'fledge-platform',
      privateKeyPath: '/tmp/fake.pem',
      webhookSecret: CURRENT,
      webhookSecretPrevious: rotation.previous ?? '',
      webhookSecretPreviousUntil: rotation.until ?? '',
      useUserToken: false,
    },
  })
}

async function build(rotation: { previous?: string; until?: string } = {}, metricsToken = '') {
  const config = appConfig(rotation, metricsToken)
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  return { built, store, config }
}

let deliveries = 0
async function deliver(
  built: Awaited<ReturnType<typeof build>>['built'],
  secret: string,
  options: { signature?: string; headers?: Record<string, string> } = {},
): Promise<number> {
  const raw = Buffer.from(JSON.stringify({ zen: 'keep it simple' }))
  deliveries += 1
  const response = await built.app.inject({
    method: 'POST',
    url: '/api/github/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'ping',
      'x-github-delivery': `rotation-${deliveries}`,
      'x-hub-signature-256': options.signature ?? sign(secret, raw),
      ...options.headers,
    },
    payload: raw,
  })
  return response.statusCode
}

function isoIn(hours: number): string {
  return new Date(Date.now() + hours * 3600_000).toISOString()
}

test('the current secret is accepted and a payload signed with a secret that is not configured is refused', async () => {
  const { built } = await build()
  try {
    assert.equal(await deliver(built, CURRENT), 200, 'the current value must keep working; a rotation must not break deliveries')
    assert.equal(await deliver(built, PREVIOUS), 401, 'a value that is neither current nor previous is not a signature')
    assert.equal(await deliver(built, CURRENT, { signature: 'sha256=deadbeef' }), 401)
  } finally {
    await built.close()
  }
})

test('inside the window the previous secret is accepted; after it the same payload is 401 with one audit row naming no secret', async () => {
  const open = await build({ previous: PREVIOUS, until: isoIn(1) })
  try {
    assert.equal(await deliver(open.built, PREVIOUS), 200, 'GitHub still signs with the old value while the window is open')
    assert.equal(await deliver(open.built, CURRENT), 200, 'the new value works immediately, not only after the window')
  } finally {
    await open.built.close()
  }

  const closed = await build({ previous: PREVIOUS, until: isoIn(-1) })
  try {
    assert.equal(await deliver(closed.built, PREVIOUS), 401, 'a retired secret must not keep working after its own instant')
    const rows = closed.store.searchAudit(null, { action: 'app.webhook_secret_superseded' }, 10, 0)
    assert.equal(rows.length, 1, 'exactly one record per refused delivery, so the operator can see a stale deployment signing')
    const detail = rows[0]?.detail ?? ''
    assert.ok(!detail.includes(PREVIOUS), 'the audit detail must carry no secret')
    assert.ok(!detail.includes(CURRENT), 'the audit detail must carry no secret')
    assert.equal(await deliver(closed.built, CURRENT), 200, 'the current value is unaffected by a closed window')
  } finally {
    await closed.built.close()
  }
})

test('the window ends at its own ISO instant, not at a wall-clock guess: the same signature flips one millisecond later', async () => {
  const { checkWebhookSignature } = await rotationHelpers()
  const until = '2026-11-14T12:00:00.000Z'
  const config = appConfig({ previous: PREVIOUS, until })
  const raw = Buffer.from(JSON.stringify({ zen: 'keep it simple' }))
  const signature = sign(PREVIOUS, raw)

  const inside = checkWebhookSignature(config.githubApp, raw, signature, Date.parse(until))
  assert.equal(inside.ok, true, 'at the instant the window ends the previous value is still accepted')
  assert.equal(inside.slot, 'previous')

  const outside = checkWebhookSignature(config.githubApp, raw, signature, Date.parse(until) + 1)
  assert.equal(outside.ok, false, 'one millisecond after the window the previous value is refused')
  assert.equal(outside.superseded, true, 'a refusal that matched the retired value is what the audit records')

  const current = checkWebhookSignature(config.githubApp, raw, sign(CURRENT, raw), Date.parse(until) + 1)
  assert.equal(current.ok, true, 'the current value is never subject to the window')
  assert.equal(current.slot, 'current')
})

test('a previous value with no end refuses to boot and names the variable, instead of opening an endless window', () => {
  const saved = {
    secret: process.env.GITHUB_APP_WEBHOOK_SECRET,
    previous: process.env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS,
    until: process.env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL,
  }
  try {
    process.env.GITHUB_APP_WEBHOOK_SECRET = CURRENT
    process.env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS = PREVIOUS
    delete process.env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL
    assert.throws(
      () => loadConfig({ env: 'test' }),
      /GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL/,
      'an overlap with no clock would accept a retired secret forever',
    )

    process.env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL = 'the day after tomorrow'
    assert.throws(
      () => loadConfig({ env: 'test' }),
      /GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL/,
      'an unparseable instant is the same defect as an empty one: the window never closes',
    )

    // The undo in the runbook: clear `_PREVIOUS` and the process boots again.
    delete process.env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS
    process.env.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL = ''
    assert.doesNotThrow(() => loadConfig({ env: 'test' }), 'clearing the previous value is the documented way back')
  } finally {
    for (const [name, value] of [
      ['GITHUB_APP_WEBHOOK_SECRET', saved.secret],
      ['GITHUB_APP_WEBHOOK_SECRET_PREVIOUS', saved.previous],
      ['GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL', saved.until],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('the slot reported for the operator is current, previous or none, and never a value', async () => {
  const { webhookSecretSlot } = await rotationHelpers()
  assert.equal(webhookSecretSlot({ webhookSecret: CURRENT, webhookSecretPrevious: '', webhookSecretPreviousUntil: '' }), 'current')
  assert.equal(webhookSecretSlot({ webhookSecret: CURRENT, webhookSecretPrevious: PREVIOUS, webhookSecretPreviousUntil: isoIn(1) }), 'previous')
  assert.equal(webhookSecretSlot({ webhookSecret: CURRENT, webhookSecretPrevious: PREVIOUS, webhookSecretPreviousUntil: isoIn(-1) }), 'current')
  assert.equal(webhookSecretSlot({ webhookSecret: '', webhookSecretPrevious: '', webhookSecretPreviousUntil: '' }), 'none')

  for (const [rotation, expected] of [
    [{}, 'current'],
    [{ previous: PREVIOUS, until: isoIn(1) }, 'previous'],
    [{ previous: PREVIOUS, until: isoIn(-1) }, 'current'],
  ] as const) {
    const { built } = await build(rotation)
    try {
      const response = await built.app.inject({ method: 'GET', url: '/healthz' })
      assert.equal(response.statusCode, 200)
      const payload = response.json() as Record<string, unknown>
      assert.equal(payload.webhookSecretSlot, expected, '/healthz must name the slot the verifier is actually using')
      assert.ok(!response.body.includes(CURRENT), 'no response body may carry the secret')
      assert.ok(!response.body.includes(PREVIOUS), 'no response body may carry the secret')
    } finally {
      await built.close()
    }
  }

  const none = await build({})
  try {
    const disabled = await none.built.app.inject({ method: 'GET', url: '/healthz' })
    assert.equal((disabled.json() as Record<string, unknown>).webhookSecretSlot, 'current')
  } finally {
    await none.built.close()
  }
})

// The status is gated exactly like `commit` and `builtAt`: an unauthenticated
// caller learns that the instance is alive, not which secret slot it trusts.
test('the slot is a diagnostics field: a caller without the metrics credential never sees it', async () => {
  const { built } = await build({ previous: PREVIOUS, until: isoIn(1) }, 'metrics-token-466')
  try {
    const denied = await built.app.inject({ method: 'GET', url: '/healthz' })
    assert.equal(denied.statusCode, 200, 'liveness must never be refused')
    assert.equal('webhookSecretSlot' in (denied.json() as Record<string, unknown>), false)
    const allowed = await built.app.inject({ method: 'GET', url: '/healthz', headers: { authorization: 'Bearer metrics-token-466' } })
    assert.equal((allowed.json() as Record<string, unknown>).webhookSecretSlot, 'previous')
  } finally {
    await built.close()
  }
})

test('a signature of the right length that is not hex is refused, not turned into a crash', async () => {
  const { built } = await build()
  try {
    assert.equal(await deliver(built, CURRENT, { signature: `sha256=${'z'.repeat(64)}` }), 401)
  } finally {
    await built.close()
  }
})

function rotationEnv(dir: string, contents = `NODE_ENV=production\nPORT=8080\nGITHUB_APP_WEBHOOK_SECRET=${CURRENT}\n`): string {
  const path = join(dir, 'fledge.env')
  writeFileSync(path, contents, { mode: 0o600 })
  return path
}

function rotate(args: string[], env: Record<string, string | undefined>, input?: string): string {
  return execFileSync(process.execPath, ['scripts/rotate-webhook-secret.mjs', ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

test('the rotation script moves the current value to the previous slot, writes the window end, and prints neither secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-rotate-466-'))
  const path = rotationEnv(dir)
  const before = Date.now()
  const output = rotate(['--env-file', path, '--window-hours', '6'], { GITHUB_APP_WEBHOOK_SECRET_NEW: NEW })
  const written = readFileSync(path, 'utf8')

  assert.match(written, new RegExp(`^GITHUB_APP_WEBHOOK_SECRET=${NEW}$`, 'm'), 'the new value is now current')
  assert.match(written, new RegExp(`^GITHUB_APP_WEBHOOK_SECRET_PREVIOUS=${CURRENT}$`, 'm'), 'the old value keeps working inside the window')
  const until = /^GITHUB_APP_WEBHOOK_SECRET_PREVIOUS_UNTIL=(.+)$/m.exec(written)?.[1] ?? ''
  const instant = Date.parse(until)
  assert.ok(Number.isFinite(instant), `the window end must be an ISO instant, got ${JSON.stringify(until)}`)
  assert.ok(instant >= before + 6 * 3600_000 - 5_000 && instant <= Date.now() + 6 * 3600_000 + 5_000, 'the window end is now plus the window')
  assert.match(written, /^PORT=8080$/m, 'untouched keys keep their value')
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the env file holds a live secret: 0600 after the write')
  assert.ok(!output.includes(NEW), 'the script must never print the new secret')
  assert.ok(!output.includes(CURRENT), 'the script must never print the old secret')
})

test('the script takes the new value from stdin, and refuses an empty one without touching the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-rotate-466-'))
  const path = rotationEnv(dir)
  rotate(['--env-file', path], {}, `${NEW}\n`)
  assert.match(readFileSync(path, 'utf8'), new RegExp(`^GITHUB_APP_WEBHOOK_SECRET=${NEW}$`, 'm'), 'stdin is the shape that keeps the value out of the process table')

  const untouched = readFileSync(path, 'utf8')
  assert.throws(
    () => rotate(['--env-file', path], { GITHUB_APP_WEBHOOK_SECRET_NEW: '' }, ''),
    /rotate-webhook-secret/,
    'an empty new value must fail loudly, not blank the secret',
  )
  assert.equal(readFileSync(path, 'utf8'), untouched)
})

test('the script refuses a secret passed as an argument, because argv is visible to every account on the host', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-rotate-466-'))
  const path = rotationEnv(dir)
  const untouched = readFileSync(path, 'utf8')
  assert.throws(() => rotate(['--env-file', path, '--secret', NEW], {}), /rotate-webhook-secret/)
  assert.equal(readFileSync(path, 'utf8'), untouched)
})
