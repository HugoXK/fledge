// Evidence capture for #867: the four controls that used to type a glyph, at the
// base tree (typed) and at the tip (drawn). One run per tree produces every frame.
import { chromium } from 'playwright'
import { buildApp } from './src/app.js'
import { Store } from './src/db.js'
import { MockRunner } from './src/jobs/mock.js'
import { encryptSecret } from './src/lib/secrets.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './test/helpers.js'

const outDir = process.argv[2] ?? '.'
const tag = process.argv[3] ?? 'tip'
const port = 18500 + Math.floor(Math.random() * 90)

const config = testConfig()
const store = new Store(':memory:')
const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
try {
  const user = makeUser(store, { login: `icons-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_icons_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    upstreamHtmlUrl: 'https://github.com',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const { cookie } = sessionFor(built, user)
  await built.app.listen({ port, host: '127.0.0.1' })

  const browser = await chromium.launch()
  try {
    for (const lang of ['en', 'zh']) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { cookie: `${cookie}; fledge_lang=${lang}` } })
      // A padded crop, not a bare element shot: a 15px circle on its own is not
      // evidence a reader can judge. `padLeft` pulls in the label the control
      // sits beside, so the frame shows the sentence a glyph used to punctuate.
      const shot = async (selector: string, name: string, padLeft = 28): Promise<string> => {
        const node = page.locator(selector).first()
        await node.waitFor({ state: 'visible', timeout: 15000 })
        await node.scrollIntoViewIfNeeded()
        const box = await node.boundingBox()
        if (box === null) throw new Error(`${selector} has no box`)
        const clip = {
          x: Math.max(0, box.x - padLeft),
          y: Math.max(0, box.y - 26),
          width: box.width + padLeft + 28,
          height: box.height + 52,
        }
        const path = `${outDir}/${name}-867-${tag}-${lang}-1280.png`
        await page.screenshot({ path, clip })
        return `${selector} -> ${(await node.textContent() ?? '').replace(/\s+/g, ' ').trim()} [${await node.evaluate((el) => el.outerHTML.slice(0, 200))}]`
      }
      const rows: string[] = []

      await page.goto(`http://127.0.0.1:${port}/settings`, { waitUntil: 'networkidle' })
      rows.push(`info-tip ${await shot('.info-tip', 'tip', 230)}`)

      await page.goto(`http://127.0.0.1:${port}/repos/${repo.id}?paused=1`, { waitUntil: 'networkidle' })
      rows.push(`banner ${await shot('.banner-dismiss', 'banner')}`)

      await page.locator('[data-open-dialog="feedback-dialog"]').first().click()
      await page.locator('#feedback-dialog').waitFor({ state: 'visible', timeout: 15000 })
      rows.push(`dialog-close ${await shot('#feedback-dialog [data-close-dialog]', 'dialog')}`)
      await page.keyboard.press('Escape')

      await page.goto(`http://127.0.0.1:${port}/dashboard`, { waitUntil: 'networkidle' })
      // The checklist lives inside the closed "Your first run" disclosure, so it
      // is opened the way a reader opens it before the frame is taken.
      await page.locator('details.secondary').first().evaluate((el) => { (el as HTMLDetailsElement).open = true })
      rows.push(`setup-check ${await shot('.setup-step.is-done .setup-mark', 'check')}`)

      console.log(JSON.stringify({ lang, rows }, null, 1))
      await page.close()
    }
  } finally {
    await browser.close()
  }
} finally {
  await built.app.close()
  store.close()
}
