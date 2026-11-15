import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { layout } from '../src/views/layout.js'
import type { Viewer } from '../src/views/layout.js'
import { applicationStatusPage, repoPage, teamPage } from '../src/views/pages.js'
import { rewriteWorkspaceHtml } from '../src/flybot/workspace.js'
import { makeUser, testConfig } from './helpers.js'

// #700: the four-hour cache on /assets is the host's, so the in-repo fix is the
// URL. Every emitter has to carry a token derived from the bytes it serves:
// the layout's four files, the repository page's two, the team and application
// pages' one each, and the two the workspace snippet injects. A slice that
// versions the layout alone leaves the defect alive on the pages where a stale
// script actually hurts.

const PUBLIC = new URL('../public/', import.meta.url)

function digestOf(file: string): string {
  return createHash('sha256').update(readFileSync(new URL(file, PUBLIC))).digest('hex').slice(0, 12)
}

/** Every `/assets/…` URL on the page, with the token it carries when it has one. */
function assets(html: string): Array<{ path: string; token: string | null }> {
  return [...html.matchAll(/(?:href|src)="(\/assets\/[^"?#]+)(?:\?v=([0-9a-f]+))?"/g)].map((match) => ({
    path: match[1] ?? '',
    token: match[2] ?? null,
  }))
}

function versioned(html: string, label: string): string[] {
  const found = assets(html)
  assert.ok(found.length > 0, `${label}: rendered no /assets/ URL at all, so this fixture proves nothing`)
  for (const asset of found) {
    const file = asset.path.slice('/assets/'.length)
    assert.ok(asset.token !== null, `${label}: ${asset.path} carries no content version, so a cached copy outlives a deploy`)
    assert.match(asset.token ?? '', /^[0-9a-f]{8,}$/, `${label}: ${asset.path} version is not a hex digest`)
    // The token must be the digest of the file the server will serve, not of
    // the commit: /healthz withholds config.build.commit behind diagnostics.
    assert.equal(asset.token, digestOf(file), `${label}: ${asset.path} version is not the digest of public/${file}`)
  }
  return found.map((asset) => asset.path).sort()
}

function fixtures(): { store: Store; repo: ReturnType<Store['createRepo']>; viewer: Viewer } {
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'asset-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_asset',
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, repo, viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' } }
}

test('the shared layout versions all four of its asset URLs', () => {
  const config = testConfig()
  const { store, viewer } = fixtures()
  try {
    const html = layout({ title: 'console', viewer, body: '<p>body</p>', config, locale: 'zh' })
    assert.deepEqual(versioned(html, 'layout'), ['/assets/app.css', '/assets/app.js', '/assets/questions.js', '/assets/section-nav.js'])
  } finally {
    store.close()
  }
})

test('the repository page versions the two scripts it loads, wherever the session lands', () => {
  const config = testConfig()
  const { store, repo, viewer } = fixtures()
  try {
    const html = repoPage({ config, locale: 'en', viewer, repo, jobs: [] })
    const found = versioned(html, 'repository page')
    assert.ok(found.includes('/assets/repoTabs.js'), 'the repository page no longer loads repoTabs.js')
    for (const path of found) {
      assert.ok(path === '/assets/repoTabs.js' || path === '/assets/chief.js' || path === '/assets/app.css' || path === '/assets/app.js' || path === '/assets/questions.js' || path === '/assets/section-nav.js', `repository page: unexpected asset ${path}`)
    }
  } finally {
    store.close()
  }
})

test('the team page and the application page version the script each one loads', () => {
  const config = testConfig()
  const { store, repo, viewer } = fixtures()
  try {
    const team = teamPage({ config, locale: 'en', viewer, repo, jobs: [] })
    assert.ok(versioned(team, 'team page').includes('/assets/team.js'), 'the team page no longer loads team.js')
    const application = applicationStatusPage({ config, locale: 'en', viewer, position: 2, total: 5 })
    assert.ok(versioned(application, 'application page').includes('/assets/application.js'), 'the application page no longer loads application.js')
  } finally {
    store.close()
  }
})

test('the workspace snippet versions the two files it injects into the proxied page', () => {
  const { store, repo } = fixtures()
  try {
    const html = rewriteWorkspaceHtml('<!doctype html><html><head></head><body></body></html>', repo, '/repos/repo_asset/workspace/app/')
    assert.deepEqual(versioned(html, 'workspace snippet'), ['/assets/workspace-brand.css', '/assets/workspace-brand.js'])
  } finally {
    store.close()
  }
})

test('the token is the file digest, so a content change moves it and a repeat does not', async () => {
  const module = (await import('../src/lib/assetVersion.js')) as typeof import('../src/lib/assetVersion.js')
  const { assetUrl, assetVersionOf } = module
  assert.equal(assetVersionOf('body{color:red}'), assetVersionOf(Buffer.from('body{color:red}')), 'the same bytes must give the same token')
  assert.notEqual(assetVersionOf('body{color:red}'), assetVersionOf('body{color:blue}'), 'a changed file must give a different token')
  assert.match(assetVersionOf('a{}'), /^[0-9a-f]{8,}$/)
  assert.equal(assetUrl('/assets/app.css'), `/assets/app.css?v=${digestOf('app.css')}`)
  assert.equal(assetUrl('/assets/app.css'), assetUrl('/assets/app.css'), 'the digest is memoised per path, not per call')
})
