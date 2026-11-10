import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { rateLimitKey } from '../src/lib/rateLimit.js'
import { MemoryMailer, testConfig } from './helpers.js'

async function withApp(run: (built: Awaited<ReturnType<typeof buildApp>>) => Promise<void>, overrides: Partial<Config> = {}): Promise<void> {
  const config = testConfig(overrides)
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

function withTrustProxy<T>(raw: string | undefined, run: () => T): T {
  const previous = process.env.TRUST_PROXY
  if (raw === undefined) delete process.env.TRUST_PROXY
  else process.env.TRUST_PROXY = raw
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TRUST_PROXY
    else process.env.TRUST_PROXY = previous
  }
}

test('TRUST_PROXY defaults to loopback and a two-hop list keeps both hops', () => {
  withTrustProxy(undefined, () => assert.deepEqual(loadConfig({ env: 'test' }).trustProxy, ['127.0.0.1', '::1'], 'the default is the direct-nginx loopback hop'))
  withTrustProxy('127.0.0.1,10.0.0.5', () => assert.deepEqual(loadConfig({ env: 'test' }).trustProxy, ['127.0.0.1', '10.0.0.5'], 'a two-hop list keeps both hops'))
  withTrustProxy(' 172.17.0.0/16 , ::1 ', () => assert.deepEqual(loadConfig({ env: 'test' }).trustProxy, ['172.17.0.0/16', '::1']))
})

test('the app refuses to start when TRUST_PROXY is not an address or CIDR', () => {
  for (const refused of ['true', '*', 'all', '0.0.0.0/0', '::/0', '10.0.0.0/33', 'localhost']) {
    withTrustProxy(refused, () => assert.throws(() => loadConfig({ env: 'test' }), /TRUST_PROXY/, `"${refused}" must be refused`))
  }
})

test('a configured proxy hop is trusted: the appended client address, not the peer, decides the bucket', async () => {
  await withApp(async (built) => {
    for (let i = 0; i < 30; i += 1) {
      // 10.0.0.2 is the inner hop; it appended the real client 203.0.113.77.
      const response = await tokenLogin(built, '10.0.0.2', `198.51.100.${i + 1}, 203.0.113.77`)
      assert.notEqual(response.statusCode, 429, `request ${i + 1} was throttled before the limit`)
    }
    const other = await tokenLogin(built, '10.0.0.2', '198.51.100.9, 203.0.113.88')
    assert.equal(other.statusCode, 400, `a different appended client answered ${other.statusCode} instead of 400`)
  }, { trustProxy: ['10.0.0.1', '10.0.0.2'] })
})

test('every throttle in src/app.ts takes its key from the normalized client address', () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  const takes = source.split('\n').map((line) => line.trim()).filter((line) => line.includes('.take('))
  assert.equal(takes.length, 11, `the limiter call count changed: ${takes.length}`)
  assert.equal(takes.filter((line) => line.includes('rateLimitKey(request)')).length, 10, 'nine sites use the normalized key')
  assert.equal(takes.filter((line) => line.includes('reauth:${viewer.user.id}')).length, 1, 'reauth stays keyed on the user id')
  for (const line of takes) {
    assert.ok(line.includes('rateLimitKey(request)') || line.includes('reauth:${viewer.user.id}'), `a limiter key is not client-choosable-proof: ${line}`)
  }
  for (const prefix of ['metrics:', 'token:', 'login:', 'callback:', 'approve:', 'credential:', 'webhook:', 'inbound:']) {
    assert.ok(takes.some((line) => line.includes(`\`${prefix}`)), `no throttle joins the ${prefix} bucket`)
  }
})

