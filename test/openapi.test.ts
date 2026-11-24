import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { randomToken, sha256Hex } from '../src/lib/secrets.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #1243: the OpenAPI 3.1 contract for the token-authenticated API v1. The
// document is data beside the routes it describes, so these tests pin it to
// what `src/app.ts` actually registers: a `/api/v1/*` route with no entry in the
// contract fails here, and so does a contract path that is not a real route.
//
// The route list is read out of the app source on purpose. Importing the
// document module would let the test agree with itself; reading the registration
// calls is what makes "an undocumented route fails" true.

const APP_SOURCE = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')

function registeredApiRoutes(): string[] {
  return [...APP_SOURCE.matchAll(/\bapp\.get\('(\/api\/v1\/[^']*)'/g)].map((match) => match[1] as string)
}

async function serveContract(): Promise<{ app: Awaited<ReturnType<typeof buildApp>>['app']; status: number; document: Record<string, unknown> }> {
  const built = await buildApp({ config: testConfig(), store: new Store(':memory:'), mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  const response = await built.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
  return { app: built.app, status: response.statusCode, document: response.statusCode === 200 ? (response.json() as Record<string, unknown>) : {} }
}

test('the contract is served at GET /api/v1/openapi.json as OpenAPI 3.1', async () => {
  const { app, status, document } = await serveContract()
  try {
    assert.equal(status, 200, 'a control room cannot generate a client without the contract')
    assert.equal(document.openapi, '3.1.0')
    const info = document.info as { title?: string; version?: string } | undefined
    assert.equal(typeof info?.title, 'string')
    assert.equal(typeof info?.version, 'string')
  } finally {
    await app.close()
  }
})

test('every /api/v1 route src/app.ts registers appears exactly once in the contract', async () => {
  const { app, document } = await serveContract()
  try {
    const paths = Object.keys((document.paths ?? {}) as Record<string, unknown>)
    const registered = registeredApiRoutes()
    assert.ok(registered.length > 0, 'the app registers at least one public API route')
    for (const route of registered) {
      assert.equal(paths.filter((path) => path === route).length, 1, `${route} is registered in src/app.ts but is not declared exactly once in the contract`)
    }
    for (const path of paths.filter((entry) => entry.startsWith('/api/v1/'))) {
      assert.ok(registered.includes(path), `the contract declares ${path}, but src/app.ts registers no such route`)
    }
  } finally {
    await app.close()
  }
})

test('the contract carries no session-only, console or callback route', async () => {
  const { app, document } = await serveContract()
  try {
    const paths = Object.keys((document.paths ?? {}) as Record<string, unknown>)
    assert.ok(paths.length > 0, 'the contract declares at least one path')
    for (const path of paths) {
      assert.ok(path.startsWith('/api/v1/'), `${path} is not part of the token-authenticated API`)
    }
    for (const forbidden of ['/login', '/callback', '/console', '/admin', '/app']) {
      assert.ok(!paths.includes(forbidden), `${forbidden} is a session surface and must never appear in the contract`)
    }
  } finally {
    await app.close()
  }
})

test('the contract names the bearer scheme and every error shape the route can answer with', async () => {
  const { app, document } = await serveContract()
  try {
    const components = (document.components ?? {}) as {
      securitySchemes?: Record<string, { type?: string; scheme?: string }>
      schemas?: Record<string, { properties?: { error?: { properties?: { type?: { enum?: string[] } } } } }>
    }
    assert.equal(components.securitySchemes?.bearerAuth?.type, 'http')
    assert.equal(components.securitySchemes?.bearerAuth?.scheme, 'bearer')
    const types = components.schemas?.Error?.properties?.error?.properties?.type?.enum ?? []
    for (const shape of ['invalid_api_key', 'insufficient_scope', 'rate_limited']) {
      assert.ok(types.includes(shape), `the gateway answers ${shape}, so the contract must name it`)
    }
    const documented = JSON.stringify(document.paths)
    for (const shape of ['invalid_api_key', 'insufficient_scope', 'rate_limited']) {
      assert.ok(!documented.includes(`"${shape}`), 'the shapes are declared once, in components, not restated inline')
    }
  } finally {
    await app.close()
  }
})

// The document has to be answerable, not merely well-shaped: every `$ref` must
// resolve inside the document, and a reader generating a client needs an
// operationId and at least one response on every operation.
function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out)
    return out
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '$ref' && typeof value === 'string') out.push(value)
      else collectRefs(value, out)
    }
  }
  return out
}

test('every $ref in the contract resolves and every operation is answerable', async () => {
  const { app, document } = await serveContract()
  try {
    for (const ref of collectRefs(document)) {
      assert.ok(ref.startsWith('#/'), `${ref} must point inside the document`)
      const target = ref
        .slice(2)
        .split('/')
        .reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], document)
      assert.notEqual(target, undefined, `${ref} does not resolve`)
    }
    const schemes = Object.keys(((document.components ?? {}) as { securitySchemes?: Record<string, unknown> }).securitySchemes ?? {})
    const paths = (document.paths ?? {}) as Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown>; security?: Array<Record<string, unknown>> }>>
    const operations = Object.entries(paths).flatMap(([path, item]) => Object.entries(item).map(([method, operation]) => ({ path, method, operation })))
    assert.ok(operations.length >= 2, 'both shipped routes are described')
    for (const { path, method, operation } of operations) {
      assert.equal(typeof operation.operationId, 'string', `${method.toUpperCase()} ${path} needs an operationId`)
      assert.ok(Object.keys(operation.responses ?? {}).length > 0, `${method.toUpperCase()} ${path} declares no response`)
      for (const requirement of operation.security ?? []) {
        for (const name of Object.keys(requirement)) {
          assert.ok(schemes.includes(name), `${method.toUpperCase()} ${path} requires "${name}", which no securityScheme declares`)
        }
      }
    }
  } finally {
    await app.close()
  }
})

// The fixture half of the card's acceptance: the documented shape is the shape
// the route actually answers with. A field renamed in the mapper without a
// matching change in `src/api/openapi.ts` fails here.
test('the documented job fields are the fields GET /api/v1/jobs answers with', async () => {
  const store = new Store(':memory:')
  const built = await buildApp({ config: testConfig(), store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'openapi-owner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_openapi', userId: user.id, owner: 'acme', name: 'demo', defaultBranch: 'main',
      tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 60,
    })
    store.createJob({ id: 'job_openapi', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'goal', callbackHash: 'h', platformTokenHash: 'p', createdAt: '2026-11-24T01:00:00.000Z' })
    store.updateJob('job_openapi', { status: 'succeeded', finished_at: '2026-11-24T01:01:00.000Z', pr_url: 'https://github.com/acme/demo/pull/1', issue_url: null, review_score: 91, cost_usd: 0.25 })
    const raw = `flg_${randomToken(32)}`
    store.createApiToken({ id: 'tok_openapi', userId: user.id, kind: 'pat', name: 'openapi', tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), repoId: null, scope: 'jobs:read', expiresAt: null })

    const response = await built.app.inject({ method: 'GET', url: '/api/v1/jobs', headers: { authorization: `Bearer ${raw}` } })
    assert.equal(response.statusCode, 200)
    const body = response.json() as { data: Array<Record<string, unknown>>; next_cursor: string | null }
    const contract = (await built.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json() as {
      components: { schemas: { JobSummary: { properties: Record<string, unknown> }; JobPage: { properties: Record<string, unknown> } } }
    }
    assert.deepEqual(Object.keys(body.data[0] ?? {}).sort(), Object.keys(contract.components.schemas.JobSummary.properties).sort())
    assert.deepEqual(Object.keys(body).sort(), Object.keys(contract.components.schemas.JobPage.properties).sort())
    assert.equal(body.next_cursor, null)
  } finally {
    await built.app.close()
  }
})
