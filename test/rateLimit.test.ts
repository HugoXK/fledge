import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { loadConfig, parseTrustProxy, type Config } from '../src/config.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { OPAQUE_ADDRESS_KEY, rateLimitKey } from '../src/lib/rateLimit.js'
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

test('a malformed address cannot crash the bucket key or mint a bucket per spelling', () => {
  // A trusted hop forwards the client header verbatim, so more than eight groups
  // reach request.ip. It used to throw RangeError: Invalid array length.
  assert.equal(typeof rateLimitKey({ ip: '1:2:3:4:5:6:7:8:9' }), 'string')
  assert.equal(typeof rateLimitKey({ ip: '1:2:3:4:5:6:7:8:9:a' }), 'string')
  // One constant key, not a key per malformed spelling: a derived key would be
  // an oracle that mints a fresh bucket for every request.
  assert.equal(rateLimitKey({ ip: '1:2:3:4:5:6:7:8:9' }), OPAQUE_ADDRESS_KEY)
  assert.equal(rateLimitKey({ ip: '1:2:3:4:5:6:7:8:9:a' }), OPAQUE_ADDRESS_KEY)
  assert.equal(rateLimitKey({ ip: 'not-an-address' }), OPAQUE_ADDRESS_KEY)
  // The mapped pattern checks digit shape, not validity. A spelling that matches
  // it but is not an address must share the opaque key, not mint one per value.
  for (const spelling of ['::ffff:1.2.3.999', '::ffff:1.2.3.998', '::ffff:256.0.0.1', '::ffff:001.2.3.4']) {
    assert.equal(rateLimitKey({ ip: spelling }), OPAQUE_ADDRESS_KEY, `${spelling} minted its own key`)
  }
  // Guards, unchanged by the fallback: the zone id is stripped and a mapped
  // address stays the IPv4 address it is.
  assert.equal(rateLimitKey({ ip: 'fe80::1%eth0' }), 'fe80:0:0:0::/64')
  assert.equal(rateLimitKey({ ip: '::ffff:127.0.0.1' }), '127.0.0.1')
})

test('a trusted hop forwarding malformed mapped spellings answers too many requests, not a fresh bucket', async () => {
  await withApp(async (built) => {
    const statuses: number[] = []
    for (let i = 0; i < 31; i += 1) {
      // Every value has a different digit shape, so a key derived from the text
      // would open a new bucket for each one.
      const response = await tokenLogin(built, '10.0.0.2', `::ffff:1.2.3.${999 - i}`)
      statuses.push(response.statusCode)
    }
    assert.equal(statuses[30], 429, `the 31st malformed mapped value answered ${statuses[30]} instead of 429; statuses ${statuses.join(',')}`)
  }, { trustProxy: ['10.0.0.1', '10.0.0.2'] })
})

test('a nine-group address forwarded by a trusted hop answers 400, never 500', async () => {
  await withApp(async (built) => {
    // The two-hop shape: the inner hop forwarded the malformed value verbatim,
    // so request.ip is the nine-group address and it decides the bucket.
    const forwarded = await tokenLogin(built, '10.0.0.2', '1:2:3:4:5:6:7:8:9')
    assert.ok(forwarded.statusCode === 400 || forwarded.statusCode === 429, `a forwarded nine-group address answered ${forwarded.statusCode} instead of 400 or 429`)
    // The peer itself carries the malformed address.
    const peer = await tokenLogin(built, '1:2:3:4:5:6:7:8:9')
    assert.ok(peer.statusCode === 400 || peer.statusCode === 429, `a nine-group peer answered ${peer.statusCode} instead of 400 or 429`)
  }, { trustProxy: ['10.0.0.1', '10.0.0.2'] })
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

test('the app refuses to start when the hops together cover the whole space', () => {
  // Each entry below is a legal prefix on its own; the union is what trusts
  // every caller, so the check has to be numeric, not per entry.
  for (const covering of ['0.0.0.0/1,128.0.0.0/1', '::/1,8000::/1', '0.0.0.0/1,128.0.0.0/2,192.0.0.0/2', '::ffff:0:0/96', '::ffff:0.0.0.0/96', '::ffff:0.0.0.0/97,::ffff:128.0.0.0/97']) {
    withTrustProxy(covering, () => assert.throws(() => loadConfig({ env: 'test' }), /TRUST_PROXY/, `"${covering}" must be refused`))
  }
  // The message names the covering entries and the space, so an operator can fix
  // the env without guessing which line did it.
  withTrustProxy('0.0.0.0/1,128.0.0.0/1', () => assert.throws(() => loadConfig({ env: 'test' }), /"0\.0\.0\.0\/1" and "128\.0\.0\.0\/1" together cover the whole IPv4 space/))
  withTrustProxy('::ffff:0:0/96', () => assert.throws(() => loadConfig({ env: 'test' }), /"::ffff:0:0\/96" \(an IPv4-mapped prefix\) covers the whole IPv4 space/))
  // Directly on the parser too: the refusal is not only reachable through boot.
  assert.throws(() => parseTrustProxy('0.0.0.0/1,128.0.0.0/1'), /TRUST_PROXY/)
  assert.throws(() => parseTrustProxy('::/1,8000::/1'), /TRUST_PROXY/)
})

test('a hop list that stops short of the whole space still starts', () => {
  // Three quarters of IPv4, host bits set, a mapped single address, a mapped
  // prefix below the marker that matches nothing, and the default list: none of
  // these cover the space, so none may lock an operator out.
  assert.deepEqual(parseTrustProxy('0.0.0.0/1,128.0.0.0/2'), ['0.0.0.0/1', '128.0.0.0/2'])
  assert.deepEqual(parseTrustProxy('10.1.2.3/8'), ['10.1.2.3/8'])
  assert.deepEqual(parseTrustProxy('127.0.0.1,::1'), ['127.0.0.1', '::1'])
  assert.deepEqual(parseTrustProxy('172.17.0.0/16'), ['172.17.0.0/16'])
  assert.deepEqual(parseTrustProxy('::ffff:127.0.0.1'), ['::ffff:127.0.0.1'])
  assert.deepEqual(parseTrustProxy('::ffff:0:0/95'), ['::ffff:0:0/95'])
  assert.deepEqual(parseTrustProxy('fe80:0:0:0:0:0:0:1'), ['fe80:0:0:0:0:0:0:1'])
  withTrustProxy('0.0.0.0/1,128.0.0.0/2', () => assert.deepEqual(loadConfig({ env: 'test' }).trustProxy, ['0.0.0.0/1', '128.0.0.0/2']))
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
  // #708 removed the pinned call count that used to sit here. A total is a
  // property of the file, not of the rule, so every throttle added by a later
  // slice turned this red for no security reason — and #708 itself adds four.
  // The loop below is the actual rule: a throttle either uses the normalized
  // client address or the one user-keyed bucket, and nothing else.
  assert.equal(takes.filter((line) => line.includes('rateLimitKey(request)')).length, takes.length - 1, 'every throttle but reauth uses the normalized key')
  assert.equal(takes.filter((line) => line.includes('reauth:${viewer.user.id}')).length, 1, 'reauth stays keyed on the user id')
  for (const line of takes) {
    assert.ok(line.includes('rateLimitKey(request)') || line.includes('reauth:${viewer.user.id}'), `a limiter key is not client-choosable-proof: ${line}`)
  }
  for (const prefix of ['metrics:', 'token:', 'login:', 'callback:', 'approve:', 'credential:', 'webhook:', 'inbound:', 'platform-stop:', 'platform-resume:', 'deployment-promote:', 'deployment-rollback:', 'session-revoke:', 'session-revoke-others:', 'session-rotate:', 'admin-role:', 'repo-add:', 'rules-save:', 'job-start:', 'api-v1-jobs:']) {
    assert.ok(takes.some((line) => line.includes(`\`${prefix}`)), `no throttle joins the ${prefix} bucket`)
  }
})


test('the destructive routes ask the route-level limiter for their bucket, on the same normalized key', () => {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  // @fastify/rate-limit models a limit only as a three-argument route with
  // `config.rateLimit`, which is also the shape CodeQL's Fastify model reads; a
  // helper that calls a hand-rolled limiter is invisible to both.
  const limited = source.split('\n').filter((line) => line.includes('config: { rateLimit: destructiveLimit }'))
  assert.deepEqual(limited.map((line) => /app\.post\('([^']+)'/.exec(line)?.[1]), [
    '/repos/:id/skill-source',
    '/repos/:id/instance/stop',
    '/repos/:id/settings',
    '/repos/:id/delete',
    '/settings/tokens',
    '/settings/tokens/:id/revoke',
    '/admin/users/:id/approve',
    '/admin/users/:id/reject',
    '/admin/users/:id/quota',
    '/admin/users/:id/delete',
  ], 'the ten destructive registrations must carry the route-level limit')
  const block = /const destructiveLimit = \{([\s\S]*?)\n  \}/.exec(source)?.[1] ?? ''
  assert.match(block, /max: 60,/, 'the ceiling has to stay stated in code')
  assert.match(block, /timeWindow: 60_000,/, 'the window has to stay stated in code')
  assert.match(block, /keyGenerator: \(request: FastifyRequest\): string => rateLimitKey\(request\)/, 'the key generator must go through rateLimitKey, not the plugin default')
  assert.match(source, /await app\.register\(fastifyRateLimit, \{ global: false \}\)/, 'the plugin must stay scoped to the routes that name it')
})

test('the gateway throttles join the normalized key instead of raw request.ip', () => {
  const source = readFileSync(new URL('../src/gateway/gateway.ts', import.meta.url), 'utf8')
  const takes = source.split('\n').map((line) => line.trim()).filter((line) => line.includes('.take('))
  assert.equal(takes.length, 2, `the gateway limiter call count changed: ${takes.length}`)
  for (const line of takes) {
    assert.ok(line.includes('rateLimitKey(request)'), `a gateway limiter key skips the normalizer: ${line}`)
    assert.ok(!line.includes('${request.ip}'), `a gateway limiter keys on raw request.ip: ${line}`)
  }
})
