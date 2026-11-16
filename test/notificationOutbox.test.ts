import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { MemoryMailer, makeUser, testConfig } from './helpers.js'
import { classifyEmailError, emailTransport, webhookTransport } from '../src/notifications/transports.js'
import { deliverOutbox, OUTBOX_LEASE_MS, retryDelayMs } from '../src/notifications/outbox.js'
import type { NotificationOutboxRow } from '../src/db.js'

// #544 slice 7: the notification outbox. A notification used to be a call that
// either worked or vanished into a log line: a webhook that timed out and an
// email that was never sent looked the same, and a restart forgot both. This
// slice gives every send a durable row and a state machine:
//
//   pending -> sending -> sent | retry | unknown | dead | blocked
//
// The two states that must never be guessed are the ones these tests pin.
// `unknown` means the request may have crossed the external commit boundary, so
// it is not resent automatically; `blocked` means the destination cannot receive
// the message now, so a human has to fix something. `sending` carries a lease,
// and a lapsed lease becomes `unknown` rather than a retry.

const T0 = Date.parse('2026-01-01T00:00:00Z')

function harness(name: string): { store: Store; userId: string } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: `${name}-user`, status: 'approved' })
  return { store, userId: user.id }
}

function enqueue(store: Store, key: string, transport: 'email' | 'webhook' = 'webhook') {
  return store.enqueueNotification({
    transport,
    destination: transport === 'email' ? 'user@example.com' : 'webhook',
    userId: null,
    payload: { subject: 'Subject', text: 'Body' },
    idempotencyKey: key,
    now: T0,
  })
}

function row(id: string): NotificationOutboxRow {
  return { id, payload_json: JSON.stringify({ event: 'ops.alert', text: 'disk almost full' }) } as NotificationOutboxRow
}

test('the outbox table and its state machine exist at user_version 44', () => {
  const store = new Store(':memory:')
  try {
    const version = store.get<{ user_version: number }>('PRAGMA user_version')
    assert.equal(Number(version?.user_version), 44, 'the notification outbox moves the refusal boundary from 43 to 44')
    const columns = store.all<{ name: string }>('PRAGMA table_info(notification_outbox)').map((column) => column.name)
    for (const column of ['transport', 'destination', 'payload_json', 'idempotency_key', 'state', 'attempts', 'next_attempt_at', 'lease_token', 'lease_expires_at', 'last_error', 'sent_at']) {
      assert.equal(columns.includes(column), true, `notification_outbox must have ${column}`)
    }
  } finally {
    store.close()
  }
})

test('enqueue is idempotent on the transport and idempotency key', () => {
  const h = harness('enqueue')
  try {
    const first = enqueue(h.store, 'digest:one')
    assert.equal(first.created, true)
    assert.equal(first.row.state, 'pending')
    assert.equal(first.row.attempts, 0)

    const second = enqueue(h.store, 'digest:one')
    assert.equal(second.created, false, 'the same logical notification is one row')
    assert.equal(second.row.id, first.row.id)
    assert.equal(h.store.countNotificationOutbox({}), 1)

    const other = enqueue(h.store, 'digest:two')
    assert.equal(other.created, true)
    assert.equal(h.store.countNotificationOutbox({}), 2)
  } finally {
    h.store.close()
  }
})

test('a live lease cannot be claimed twice and a lapsed one becomes unknown, never a retry', () => {
  const h = harness('lease')
  try {
    enqueue(h.store, 'webhook:one')
    const first = h.store.claimNotificationOutbox(T0, OUTBOX_LEASE_MS, 10)
    assert.equal(first.length, 1)
    assert.equal(first[0]?.state, 'sending')
    assert.equal(first[0]?.attempts, 1)

    const second = h.store.claimNotificationOutbox(T0 + OUTBOX_LEASE_MS - 1, OUTBOX_LEASE_MS, 10)
    assert.equal(second.length, 0, 'a live sending lease is not claimable')

    const swept = h.store.expireNotificationLeases(T0 + OUTBOX_LEASE_MS)
    assert.equal(swept.expired, 1)
    const after = h.store.getNotificationOutbox(first[0]!.id)
    assert.equal(after?.state, 'unknown')
    assert.equal(after?.last_error, 'lease-expired')
    assert.equal(after?.lease_token, null)

    const third = h.store.claimNotificationOutbox(T0 + OUTBOX_LEASE_MS + 1, OUTBOX_LEASE_MS, 10)
    assert.equal(third.length, 0, 'unknown is not resent automatically')

    const resent = h.store.resendNotification(first[0]!.id, T0 + OUTBOX_LEASE_MS + 1)
    assert.equal(resent.requeued, true)
    assert.equal(resent.row.state, 'pending')
    assert.equal(resent.row.idempotency_key, 'webhook:one', 'the human resend reuses the idempotency key')
    assert.equal(resent.row.attempts, 1, 'the attempt history is kept')
  } finally {
    h.store.close()
  }
})

test('delivery settles sent, schedules a retry with backoff, and keeps dead terminal', async () => {
  const h = harness('deliver')
  try {
    enqueue(h.store, 'webhook:sent')
    enqueue(h.store, 'webhook:retry')
    enqueue(h.store, 'webhook:dead')
    const outcomes = new Map<string, 'sent' | 'retry' | 'dead'>([
      ['webhook:sent', 'sent'],
      ['webhook:retry', 'retry'],
      ['webhook:dead', 'dead'],
    ])
    const seen: string[] = []
    const result = await deliverOutbox(h.store, {
      email: { send: async () => ({ state: 'sent' }) },
      webhook: {
        send: async (entry) => {
          seen.push(entry.idempotency_key)
          return { state: outcomes.get(entry.idempotency_key) ?? 'dead', ...(outcomes.get(entry.idempotency_key) === 'retry' ? { error: '503' } : {}) }
        },
      },
    }, { now: T0, leaseMs: OUTBOX_LEASE_MS })
    assert.deepEqual(seen.sort(), ['webhook:dead', 'webhook:retry', 'webhook:sent'])
    assert.equal(result.sent, 1)
    assert.equal(result.retry, 1)
    assert.equal(result.dead, 1)

    const retry = h.store.listNotificationOutbox({ state: 'retry' }, 10, 0)[0]
    assert.equal(retry?.last_error, '503')
    assert.equal(retry?.next_attempt_at, T0 + retryDelayMs(1))
    assert.equal(h.store.claimNotificationOutbox(T0 + retryDelayMs(1) - 1, OUTBOX_LEASE_MS, 10).length, 0, 'a retry waits for its backoff')
    const due = h.store.claimNotificationOutbox(T0 + retryDelayMs(1), OUTBOX_LEASE_MS, 10)
    assert.equal(due.length, 1)
    assert.equal(due[0]?.attempts, 2)

    const dead = h.store.listNotificationOutbox({ state: 'dead' }, 10, 0)[0]
    assert.equal(h.store.claimNotificationOutbox(T0 + retryDelayMs(10), OUTBOX_LEASE_MS, 10).length, 0, 'dead is terminal')
    assert.equal(dead?.state, 'dead')
  } finally {
    h.store.close()
  }
})

test('the email transport re-checks the recipient before it sends', async () => {
  const h = harness('recipient')
  try {
    const mailer = new MemoryMailer()
    h.store.setUserStatus(h.userId, 'rejected', 'test')
    const transport = emailTransport(h.store, mailer)
    const queued = h.store.enqueueNotification({
      transport: 'email',
      destination: 'recipient@example.com',
      userId: h.userId,
      payload: { subject: 'Digest', text: 'Body' },
      idempotencyKey: 'digest:revoked',
      now: T0,
    })
    const outcome = await transport.send(queued.row)
    assert.equal(outcome.state, 'blocked')
    assert.equal(outcome.error, 'recipient-inactive')
    assert.equal(mailer.messages.length, 0, 'a revoked recipient receives nothing')
  } finally {
    h.store.close()
  }
})

test('an email row with no address blocks instead of sending to an empty recipient', async () => {
  const h = harness('missing')
  try {
    const mailer = new MemoryMailer()
    h.store.run("UPDATE users SET email = '' WHERE id = ?", h.userId)
    const transport = emailTransport(h.store, mailer)
    const queued = h.store.enqueueNotification({
      transport: 'email',
      destination: '',
      userId: h.userId,
      payload: { subject: 'Digest', text: 'Body' },
      idempotencyKey: 'digest:missing',
      now: T0,
    })
    const outcome = await transport.send(queued.row)
    assert.equal(outcome.state, 'blocked')
    assert.equal(outcome.error, 'recipient-missing')
    assert.equal(mailer.messages.length, 0)
  } finally {
    h.store.close()
  }
})

test('the webhook transport maps a status to sent, retry or dead, and a timeout to unknown', async () => {
  const config = testConfig({ notifyWebhookUrl: 'https://hooks.example.com/fledge' })
  const resolve = async () => [{ address: '203.0.113.10', family: 4 }]
  const ok = webhookTransport(config, {
    resolve,
    fetch: async () => new Response('', { status: 200 }),
  })
  assert.equal((await ok.send(row('ok'))).state, 'sent')

  const retry = webhookTransport(config, { resolve, fetch: async () => new Response('', { status: 503 }) })
  assert.equal((await retry.send(row('busy'))).state, 'retry')

  const dead = webhookTransport(config, { resolve, fetch: async () => new Response('', { status: 400 }) })
  assert.equal((await dead.send(row('bad'))).state, 'dead')

  const unknown = webhookTransport(config, {
    resolve,
    fetch: async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }) },
  })
  assert.equal((await unknown.send(row('timeout'))).state, 'unknown')

  const blocked = webhookTransport(testConfig({ notifyWebhookUrl: '' }))
  assert.equal((await blocked.send(row('off'))).state, 'blocked')
})

test('a fetch-level network error is retried, but a private destination is blocked', async () => {
  const config = testConfig({ notifyWebhookUrl: 'https://hooks.example.com/fledge' })
  const resolve = async () => [{ address: '203.0.113.10', family: 4 }]
  const dns = webhookTransport(config, {
    resolve,
    fetch: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) },
  })
  assert.equal((await dns.send(row('dns'))).state, 'retry')

  const privateTransport = webhookTransport(config, { resolve: async () => [{ address: '10.0.0.1', family: 4 }] })
  const refused = await privateTransport.send(row('private'))
  assert.equal(refused.state, 'blocked', 'a refused destination is not retried forever')
})

test('a reset on the fetch cause is unknown and is not claimed on the next pass', async () => {
  const config = testConfig({ notifyWebhookUrl: 'https://hooks.example.com/fledge' })
  const resolve = async () => [{ address: '203.0.113.10', family: 4 }]
  const transport = webhookTransport(config, {
    resolve,
    fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) },
  })
  assert.equal((await transport.send(row('cause-reset'))).state, 'unknown')

  const h = harness('cause-reset')
  try {
    enqueue(h.store, 'webhook:cause-reset')
    const first = await deliverOutbox(h.store, {
      email: { send: async () => ({ state: 'sent' }) },
      webhook: transport,
    }, { now: T0, leaseMs: OUTBOX_LEASE_MS })
    assert.equal(first.unknown, 1)

    const second = await deliverOutbox(h.store, {
      email: { send: async () => ({ state: 'sent' }) },
      webhook: { send: async () => { throw new Error('must not be called') } },
    }, { now: T0 + 60_000, leaseMs: OUTBOX_LEASE_MS })
    assert.equal(second.claimed, 0)
  } finally {
    h.store.close()
  }
})

test('a webhook resolver failure is retryable, while a private destination stays blocked', async () => {
  const config = testConfig({ notifyWebhookUrl: 'https://hooks.example.com/fledge' })
  const retry = webhookTransport(config, {
    resolve: async () => { throw new Error('getaddrinfo EAI_AGAIN') },
    fetch: async () => new Response('', { status: 200 }),
  })
  assert.equal((await retry.send(row('resolver-fail'))).state, 'retry')

  const blocked = webhookTransport(config, { resolve: async () => [{ address: '10.0.0.1', family: 4 }] })
  assert.equal((await blocked.send(row('resolver-private'))).state, 'blocked')
})

// Rule the whole slice turns on: a timeout is not a failure to send, it is a
// send whose outcome nobody knows. It must not be retried by the machine.
test('a timeout outcome is unknown and is not claimed on the next pass', async () => {
  const h = harness('unknown')
  try {
    enqueue(h.store, 'webhook:unknown')
    const first = await deliverOutbox(h.store, {
      email: { send: async () => ({ state: 'sent' }) },
      webhook: { send: async () => ({ state: 'unknown', error: 'timeout' }) },
    }, { now: T0, leaseMs: OUTBOX_LEASE_MS })
    assert.equal(first.unknown, 1)

    const second = await deliverOutbox(h.store, {
      email: { send: async () => ({ state: 'sent' }) },
      webhook: { send: async () => { throw new Error('must not be called') } },
    }, { now: T0 + 60_000, leaseMs: OUTBOX_LEASE_MS })
    assert.equal(second.claimed, 0)
  } finally {
    h.store.close()
  }
})

test('email failures classify by the SMTP response code', () => {
  assert.equal(classifyEmailError(Object.assign(new Error('busy'), { responseCode: 451 })), 'retry')
  assert.equal(classifyEmailError(Object.assign(new Error('refused'), { responseCode: 550 })), 'dead')
  assert.equal(classifyEmailError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 'unknown')
})
