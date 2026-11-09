import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { rateLimitKey } from '../src/lib/rateLimit.js'
import { MemoryMailer, testConfig } from './helpers.js'

async function withApp(run: (built: Awaited<ReturnType<typeof buildApp>>) => Promise<void>): Promise<void> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    await run(built)
  } finally {
    await built.close()
  }
}

function tokenLogin(built: Awaited<ReturnType<typeof buildApp>>, remoteAddress: string, forwardedFor?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor
  return built.app.inject({ method: 'POST', url: '/auth/token', headers, payload: 'token=', remoteAddress })
}

function metrics(built: Awaited<ReturnType<typeof buildApp>>, remoteAddress: string, forwardedFor?: string) {
  const headers: Record<string, string> = forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }
  return built.app.inject({ method: 'GET', url: '/metrics', headers, remoteAddress })
}

test('the bucket key is the client address, not a raw string a client can mint', () => {
  assert.equal(rateLimitKey({ ip: '203.0.113.9' }), '203.0.113.9')
  assert.equal(rateLimitKey({ ip: '::ffff:203.0.113.9' }), '203.0.113.9')
  // One IPv6 client commonly controls a whole /64, so the low 64 bits are free to rotate.
  assert.equal(rateLimitKey({ ip: '2001:db8:1:2::1' }), rateLimitKey({ ip: '2001:db8:1:2::beef' }))
  assert.equal(rateLimitKey({ ip: '2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd' }), rateLimitKey({ ip: '2001:db8:1:2::1' }))
  assert.notEqual(rateLimitKey({ ip: '2001:db8:1:2::1' }), rateLimitKey({ ip: '2001:db8:1:3::1' }))
  assert.equal(rateLimitKey({ ip: '::1' }), rateLimitKey({ ip: '::ffff:0:1' }))
})

test('a rotating forged X-Forwarded-For from one untrusted peer does not mint new buckets', async () => {
  await withApp(async (built) => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i += 1) {
      const response = await tokenLogin(built, '203.0.113.9', `198.51.100.${i + 1}`)
      statuses.push(response.statusCode)
    }
    assert.equal(statuses[30], 429, `the 31st request answered ${statuses[30]} instead of 429; statuses ${statuses.join(',')}`)
  })
})

test('from a trusted proxy the key is the hop nginx appended, not the forged left end', async () => {
  await withApp(async (built) => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i += 1) {
      // The peer is the documented loopback hop; everything left of the appended
      // address is caller-supplied and must not decide the bucket.
      const response = await tokenLogin(built, '127.0.0.1', `203.0.113.${i + 1}, 198.51.100.7`)
      statuses.push(response.statusCode)
    }
    assert.equal(statuses[30], 429, `the 31st request answered ${statuses[30]} instead of 429; statuses ${statuses.join(',')}`)
  })
})

test('/metrics is throttled on the api bucket', async () => {
  await withApp(async (built) => {
    const statuses: number[] = []
    for (let i = 0; i < 121; i += 1) {
      const response = await metrics(built, '203.0.113.55')
      statuses.push(response.statusCode)
    }
    assert.equal(statuses[120], 429, `the 121st /metrics request answered ${statuses[120]} instead of 429`)
  })
})

test('one IPv6 /64 is one client even when the address rotates', async () => {
  await withApp(async (built) => {
    for (let i = 0; i < 120; i += 1) {
      const response = await metrics(built, '2001:db8:1:2::1')
      assert.equal(response.statusCode, 403, `/metrics answered ${response.statusCode} before the limit`)
    }
    const rotated = await metrics(built, '2001:db8:1:2::beef')
    assert.equal(rotated.statusCode, 429, `a second address in the same /64 answered ${rotated.statusCode} instead of 429`)
  })
})

test('two different clients do not share a bucket', async () => {
  await withApp(async (built) => {
    for (let i = 0; i < 120; i += 1) {
      const response = await metrics(built, '203.0.113.9')
      assert.equal(response.statusCode, 403, `/metrics answered ${response.statusCode} before the limit`)
    }
    const other = await metrics(built, '198.51.100.7')
    assert.equal(other.statusCode, 403, `a different client answered ${other.statusCode} instead of 403`)
  })
})
