import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { MemoryMailer, testConfig } from './helpers.js'

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
