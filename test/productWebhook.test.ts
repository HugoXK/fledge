import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { readFileSync } from 'node:fs'
import { PRODUCT_PUSH_KEY, pushProductLoopWebhook } from '../src/metrics/productWebhook.js'
import { makeUser, testConfig } from './helpers.js'

// #635: the optional receiver is the one path where loop numbers leave the
// process, so these cases are about the boundary rather than the happy path:
// unset means no request at all, switched-off beats a configured URL, the
// payload names no repository and no account, and a failed day is retried.

function memoryStore(): Store {
  return new Store(':memory:')
}

function repoFor(store: Store, userId: string, id: string): string {
  store.createRepo({
    id,
    userId,
    owner: 'o',
    name: id,
    defaultBranch: 'main',
    tokenEnc: encryptSecret('token', testConfig().tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return id
}

function fakeFetch(status = 200): { fetch: typeof fetch; calls: Array<{ url: string; body: string; agent: string }> } {
  const calls: Array<{ url: string; body: string; agent: string }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? ''), agent: String((init?.headers as Record<string, string> | undefined)?.['user-agent'] ?? '') })
    return new Response('', { status })
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

const resolvePublic = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '93.184.216.34', family: 4 }]

test('the receiver stays off until an operator names an address, and off beats a configured one', async () => {
  const store = memoryStore()
  const user = makeUser(store)
  const repoId = repoFor(store, user.id, 'repo-receiver-off')
  store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId })
  const nothing = fakeFetch(200)
  const unset = await pushProductLoopWebhook({ store, config: testConfig(), now: Date.parse('2026-11-19T12:00:00.000Z'), fetch: nothing.fetch, resolve: resolvePublic })
  assert.equal(unset.state, 'off')
  assert.equal(nothing.calls.length, 0, 'no URL means no request of any kind')
  const configured = testConfig({ productWebhookUrl: 'https://receiver.example.com/hook' })
  store.setSetting('product.analytics', 'off')
  const switchedOff = fakeFetch(200)
  const off = await pushProductLoopWebhook({ store, config: configured, now: Date.parse('2026-11-19T12:00:00.000Z'), fetch: switchedOff.fetch, resolve: resolvePublic })
  assert.equal(off.state, 'off')
  assert.equal(switchedOff.calls.length, 0, 'a configured receiver does not override the off switch')
  assert.equal(store.getSetting('product_push:last'), undefined, 'nothing marked a day it did not push')
})

test('the push carries counts and rates only, once a day, and retries a failed day', async () => {
  const store = memoryStore()
  const owner = makeUser(store, { login: 'receiver-owner' })
  const repoId = repoFor(store, owner.id, 'repo-receiver')
  const at = '2026-11-19T10:00:00.000Z'
  store.recordProductEvent({ name: 'repo_connected', repoId, subject: repoId, at })
  store.recordProductEvent({ name: 'first_job_started', repoId, subject: repoId, at })
  store.recordProductEvent({ name: 'job_failed', repoId, subject: 'job-receiver', at })
  store.recordProductEvent({ name: 'human_action_retry', repoId, subject: 'job-receiver', at })
  const config = testConfig({ productWebhookUrl: 'https://receiver.example.com/hook' })
  const now = Date.parse('2026-11-19T12:00:00.000Z')

  const failing = fakeFetch(503)
  const retry = await pushProductLoopWebhook({ store, config, now, fetch: failing.fetch, resolve: resolvePublic })
  assert.equal(retry.state, 'retry')
  assert.equal(failing.calls.length, 1)
  assert.equal(store.getSetting(PRODUCT_PUSH_KEY), undefined, 'a failed push does not consume the day')

  const sent = fakeFetch(200)
  const pushed = await pushProductLoopWebhook({ store, config, now, fetch: sent.fetch, resolve: resolvePublic })
  assert.equal(pushed.state, 'sent')
  const call = sent.calls[0]
  assert.ok(call, 'the retry reached the receiver')
  const body = JSON.parse(call.body) as Record<string, any>
  assert.equal(body.event, 'product.loop')
  assert.equal(body.funnel.connected, 1)
  assert.equal(body.funnel.firstJob, 1)
  assert.equal(body.rescue.failed, 1)
  assert.equal(body.rescue.actions, 1)
  assert.equal(body.rescue.rate, 100)
  assert.equal(body.window.days, 30)
  // #635 review: the receiver identifies the sender by the version it runs, not
  // by a literal that goes stale at the next release.
  const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  assert.equal(call.agent, `fledge/${packageVersion}`, 'the user-agent names the running version')
  // The boundary is the payload's shape: no digest, no id, no login, no free text.
  const text = JSON.stringify(body)
  for (const secret of [store.productRepoHash(repoId), owner.id, owner.login, repoId]) {
    assert.equal(text.includes(secret), false, `the push leaked ${secret}`)
  }
  assert.deepEqual(Object.keys(body).sort(), ['durations', 'event', 'evidence', 'funnel', 'rescue', 'returning', 'window'])

  const again = fakeFetch(200)
  const duplicate = await pushProductLoopWebhook({ store, config, now, fetch: again.fetch, resolve: resolvePublic })
  assert.equal(duplicate.state, 'duplicate')
  assert.equal(again.calls.length, 0, 'one push a day, read from the marker rather than a process clock')

  const nextDay = fakeFetch(200)
  const tomorrow = await pushProductLoopWebhook({ store, config, now: now + 86_400_000, fetch: nextDay.fetch, resolve: resolvePublic })
  assert.equal(tomorrow.state, 'sent')
})
