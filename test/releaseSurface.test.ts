import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adminPage } from '../src/views/pages.js'
import { layout } from '../src/views/layout.js'
import { readReleaseSurface } from '../src/lib/releaseSurface.js'
import { Store } from '../src/db.js'
import { makeUser, testConfig } from './helpers.js'

// An operator has to be able to answer three questions from the console without
// a shell: which release is running, what the newest shipped section is, and how
// many fragments are pending. The surface reads local files only, so these cases
// build a fixture root instead of touching the checkout.

const ABSENT_EN = /not available in this build/i
const ABSENT_ZH = /此构建中不可用/

function makeRoot(input: { withChangelog: boolean; withFragments: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), 'fledge-release-surface-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fledge', version: '0.3.0' }, null, 2))
  if (input.withChangelog) {
    writeFileSync(join(root, 'CHANGELOG.md'), [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [0.3.0] — 2026-11-09',
      '',
      '### Fixed',
      '',
      '- Something shipped.',
      '',
      '## [0.2.0] — 2026-11-01',
      '',
      '- Something older.',
      '',
    ].join('\n'))
  }
  if (input.withFragments) {
    mkdirSync(join(root, 'changelog.d'))
    writeFileSync(join(root, 'changelog.d', 'README.md'), 'Fragments live here.\n')
    writeFileSync(join(root, 'changelog.d', '151-release-surface.added.md'), 'One pending change.\n')
    writeFileSync(join(root, 'changelog.d', '152-something.fixed.md'), 'Another pending change.\n')
  }
  return root
}

function renderAdmin(locale: 'en' | 'zh', root: string): string {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: `release-${locale}`, status: 'approved', superadmin: true })
    const page = adminPage({
      config: testConfig(),
      locale,
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      users: [],
      jobs: [],
      jobsPage: 1,
      jobsTotal: 0,
      audit: [],
      auditPage: 1,
      auditTotal: 0,
      perPage: 10,
      release: readReleaseSurface(root),
    })
    return page
  } finally {
    store.close()
  }
}

test('the console states the running version, the newest changelog section and the pending fragment count', () => {
  const root = makeRoot({ withChangelog: true, withFragments: true })
  try {
    const surface = readReleaseSurface(root)
    assert.equal(surface.version, '0.3.0')
    assert.equal(surface.releasedAt, '2026-11-09')
    assert.equal(surface.changelogVersion, '0.3.0')
    assert.equal(surface.fragments, 2, 'README.md is not a fragment')

    const footer = layout({ title: 'x', body: '', config: testConfig(), locale: 'en', release: surface })
    assert.match(footer, /v0\.3\.0/, 'the footer of every page names the running version')
    const footerZh = layout({ title: 'x', body: '', config: testConfig(), locale: 'zh', release: surface })
    assert.match(footerZh, /v0\.3\.0/, 'the Chinese footer names the same version')

    for (const locale of ['en', 'zh'] as const) {
      const page = renderAdmin(locale, root)
      assert.match(page, /0\.3\.0/, `the ${locale} admin card names the running version`)
      assert.match(page, /2026-11-09/, `the ${locale} admin card names the newest section date`)
      assert.match(page, locale === 'en' ? /2 pending/ : /2 个待发布片段/, `the ${locale} admin card counts the fragments`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a missing changelog or fragment directory says so instead of printing zero', () => {
  const root = makeRoot({ withChangelog: false, withFragments: false })
  try {
    const surface = readReleaseSurface(root)
    assert.equal(surface.version, '0.3.0')
    assert.equal(surface.releasedAt, null)
    assert.equal(surface.fragments, null)

    const en = renderAdmin('en', root)
    assert.match(en, ABSENT_EN)
    assert.doesNotMatch(en, /0 pending/i, 'a missing directory must not read as an empty queue')
    const zh = renderAdmin('zh', root)
    assert.match(zh, ABSENT_ZH)
    assert.doesNotMatch(zh, /0 个待发布片段/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the runtime image carries CHANGELOG.md and changelog.d so the card is never blank', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'))
  assert.ok(runtime !== '', 'the Dockerfile has a runtime stage')
  assert.match(runtime, /^COPY CHANGELOG\.md /m, 'the runtime stage copies CHANGELOG.md')
  assert.match(runtime, /^COPY changelog\.d /m, 'the runtime stage copies changelog.d')
})
