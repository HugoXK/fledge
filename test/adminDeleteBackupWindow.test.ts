import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #1286: the deletion preview and `docs/security.md` stated a fixed backup
// window ("local encrypted 30 days, GitHub 14"). The policy is a keep count per
// class: `src/config.ts` reads BACKUP_KEEP_ENCRYPTED through `keepCount()` and
// `scripts/backup-prune.mjs` keeps the newest N copies of each class, so a weekly
// backup keeps thirty weeks rather than thirty days, and nothing in the tree
// sources the GitHub-side 14. Both sentences must name the configured count
// instead of a number of days, and the warning itself must survive.

// The banner is the only `banner warn` block on the read-only preview that talks
// about backups, so the assertion can be scoped to that sentence instead of the
// whole page (where other numbers appear).
async function backupBanner(options: { keepEncrypted?: number; locale: 'en' | 'zh' }): Promise<string> {
  const config = testConfig()
  if (options.keepEncrypted !== undefined) config.backup.keepEncrypted = options.keepEncrypted
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: new MockRunner(),
    startScheduler: false,
  })
  try {
    const boss = makeUser(store, { login: 'root', superadmin: true, status: 'approved' })
    const victim = makeUser(store, { login: 'victim', status: 'approved' })
    const { cookie } = sessionFor(built, boss)
    const page = await built.app.inject({
      method: 'GET',
      url: `/admin/users/${victim.id}/delete`,
      headers: { cookie: `${cookie}; fledge_lang=${options.locale}` },
    })
    assert.equal(page.statusCode, 200)
    const banners = [...page.body.matchAll(/<div class="banner warn">([\s\S]*?)<\/div>/g)]
      .map((match) => match[1] ?? '')
      .filter((body) => /backup|备份/i.test(body))
    assert.equal(banners.length, 1, 'the preview must carry exactly one backup banner')
    const [banner] = banners
    assert.ok(banner !== undefined, 'the backup banner must be readable')
    return banner
  } finally {
    await built.close()
  }
}

test('the deletion preview states the configured backup keep count, not a fixed window', async () => {
  const english = await backupBanner({ keepEncrypted: 7, locale: 'en' })
  assert.match(english, /\b7\b/, 'the banner must name the configured keep count')
  assert.doesNotMatch(english, /\b30\b/, 'the banner must not keep the default count when it is configured to 7')
  assert.doesNotMatch(english, /\bdays?\b/i, 'a keep count is not a number of days: a weekly backup keeps weeks')
  assert.doesNotMatch(english, /GitHub\s*14/, 'nothing sources the GitHub-side 14, so the banner must drop it')
  assert.match(english, /local encrypted cop/i, 'the banner must still describe which copies are kept')
  assert.match(english, /does not erase backups/i, 'the warning must survive: a deletion does not erase backups')

  const chinese = await backupBanner({ keepEncrypted: 7, locale: 'zh' })
  assert.match(chinese, /\b7\b/, 'the zh banner must name the configured keep count')
  assert.doesNotMatch(chinese, /\b30\b/, 'the zh banner must not keep the default count when it is configured to 7')
  assert.doesNotMatch(chinese, /天/, 'a keep count is not a number of days in zh either')
  assert.doesNotMatch(chinese, /GitHub\s*14/, 'the zh banner must drop the unsourced GitHub-side 14')
  assert.match(chinese, /本地加密副本/, 'the zh banner must still describe which copies are kept')
  assert.match(chinese, /不会擦除备份/, 'the zh warning must survive')
})

test('the default configuration still names 30 and the warning survives', async () => {
  const english = await backupBanner({ keepEncrypted: 30, locale: 'en' })
  assert.match(english, /\b30\b/, 'the default keep count is 30 and the banner must name it')
  assert.match(english, /backups?/i, 'the banner must still warn that backups keep the account')

  const chinese = await backupBanner({ keepEncrypted: 30, locale: 'zh' })
  assert.match(chinese, /\b30\b/, 'the zh default banner must name the default keep count')
  assert.match(chinese, /备份/, 'the zh banner must still warn that backups keep the account')
})

test('neither the trial-purge paragraph nor the view states the fixed window', () => {
  const security = readFileSync(new URL('../docs/security.md', import.meta.url), 'utf8')
  const paragraph = security
    .split('\n\n')
    .find((block) => /Backups keep the account/.test(block))
  assert.ok(paragraph !== undefined, 'docs/security.md must keep the trial-purge backup sentence')
  // Markdown wraps the sentence across lines, so the assertion reads it as one
  // run of text; a line break is not a different sentence.
  const sentence = paragraph.replace(/\s+/g, ' ')
  assert.doesNotMatch(sentence, /GitHub\s*14/, 'the doc must drop the unsourced GitHub-side 14')
  assert.doesNotMatch(sentence, /\b30\s*days\b/i, 'the doc must not state the keep count as a number of days')
  assert.match(sentence, /BACKUP_KEEP_ENCRYPTED/, 'the doc must name the knob that sets the keep count')
  assert.match(sentence, /erasing a backup early is not part of this control/, 'the doc must keep the control boundary')

  const view = readFileSync(new URL('../src/views/pages.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(view, /GitHub 14/, 'the view must not carry the unsourced GitHub-side 14 literal')
})
