import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { assertSafeNotificationWebhook, assertSafeWebhookUrl, sendNotificationWebhook, type WebhookResolver } from '../src/lib/webhook.js'
import { parseHostAllowlist } from '../src/config.js'
import { MemoryMailer, testConfig } from './helpers.js'

const publicResolve: WebhookResolver = async () => [{ address: '203.0.113.10', family: 4 }]
const privateResolve: WebhookResolver = async () => [{ address: '10.0.0.1', family: 4 }]

test('a public https webhook is accepted', async () => {
  const accepted = await assertSafeWebhookUrl('https://hooks.example.com/fledge', { resolve: publicResolve })
  assert.equal(accepted.toString(), 'https://hooks.example.com/fledge')

  let calls = 0
  await sendNotificationWebhook(
    testConfig({ notifyWebhookUrl: 'https://hooks.example.com/fledge' }),
    'job.succeeded',
    { text: 'iterate job job_1 succeeded' },
    {
      resolve: publicResolve,
      fetch: async () => {
        calls += 1
        return new Response('', { status: 200 })
      },
    },
  )
  assert.equal(calls, 1)
})

test('loopback, RFC1918, metadata, link-local, multicast and IPv4-mapped private targets are refused', async () => {
  const refused = [
    'https://127.0.0.1/hook',
    'https://10.0.0.1/hook',
    'https://172.16.0.1/hook',
    'https://192.168.1.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'https://[fc00::1]/hook',
    'https://[fe80::1]/hook',
    'https://224.0.0.1/hook',
    'https://[::ffff:10.0.0.1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
  ]
  for (const url of refused) {
    await assert.rejects(() => assertSafeWebhookUrl(url), /host .* (?:is a private or reserved address|resolves to a private or reserved address)/, url)
  }
})

test('a hostname that resolves to a private address is refused and names the host in the error', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://internal.example/hook', { resolve: privateResolve }),
    /internal\.example.*private or reserved/,
  )
})

test('the allowlist environment value is comma separated and empty by default', () => {
  assert.deepEqual(parseHostAllowlist(''), [])
  assert.deepEqual(parseHostAllowlist(' Hooks.Example.com. , 127.0.0.1, ,Hooks.Example.com '), ['hooks.example.com', '127.0.0.1'])
})

test('the optional allowlist admits a self-hosted target and nothing else', async () => {
  assert.doesNotThrow(() => assertSafeWebhookUrl('http://127.0.0.1:9000/hook', { allowedHosts: ['127.0.0.1'] }))
  await assert.rejects(
    () => assertSafeWebhookUrl('https://public.example/hook', { allowedHosts: ['127.0.0.1'], resolve: publicResolve }),
    /public\.example.*not in NOTIFY_WEBHOOK_ALLOWED_HOSTS/,
  )
})

test('an error names the host and never the credentials or query string', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('https://user:supersecret@127.0.0.1/hook?token=othersecret'),
    (error: unknown) => {
      const message = String(error)
      assert.doesNotMatch(message, /supersecret|othersecret/)
      assert.doesNotMatch(message, /\/hook/)
      return true
    },
  )
  await assert.rejects(
    () => assertSafeWebhookUrl('https://127.0.0.1/hook?token=othersecret'),
    (error: unknown) => {
      const message = String(error)
      assert.match(message, /127\.0\.0\.1/)
      assert.doesNotMatch(message, /othersecret|\/hook/)
      return true
    },
  )
})

test('a redirect to a private address is refused before the body is sent there', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const redirectingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body })
    return new Response(null, { status: 307, headers: { location: 'https://10.0.0.1/internal' } })
  }) as typeof fetch

  await sendNotificationWebhook(
    testConfig({ notifyWebhookUrl: 'https://hooks.example.com/fledge', notifyWebhookSecret: 'hook-secret' }),
    'ops.alert',
    { text: 'disk almost full' },
    { resolve: publicResolve, fetch: redirectingFetch },
  )

  assert.equal(calls.length, 1, 'only the public https target may receive a request')
  assert.equal(calls[0]?.url, 'https://hooks.example.com/fledge')
  assert.equal(calls.some((call) => call.url.includes('10.0.0.1')), false, 'the private redirect must not receive the payload')
})

test('production startup refuses a webhook that points at a private address', async () => {
  await assert.rejects(
    () => assertSafeNotificationWebhook(testConfig({ env: 'production', notifyWebhookUrl: 'https://127.0.0.1/hook' })),
    /127\.0\.0\.1.*private or reserved/,
  )

  const config = testConfig({ env: 'production', metrics: { token: 'metrics-secret' }, notifyWebhookUrl: 'https://169.254.169.254/latest/meta-data' })
  const store = new Store(':memory:')
  try {
    await assert.rejects(
      () => buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false }),
      /169\.254\.169\.254.*private or reserved/,
    )
  } finally {
    store.close()
  }
})

test('production startup accepts a public webhook resolved through the injected resolver', async () => {
  const config = testConfig({ env: 'production', notifyWebhookUrl: 'https://hooks.example.com/fledge' })
  await assert.doesNotThrow(() => assertSafeNotificationWebhook(config, { resolve: publicResolve }))
})
