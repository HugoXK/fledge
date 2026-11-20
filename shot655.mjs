import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const base = '/home/xuke/.dsh/bot/workspace/fledge-dev-2/.tmpcheck/shots655'
const browser = await chromium.launch()
const out = []
for (const state of ['before', 'after']) {
  for (const locale of ['en', 'zh']) {
    for (const width of [1280, 360]) {
      const page = await browser.newPage({ viewport: { width, height: width === 360 ? 780 : 900 }, deviceScaleFactor: 1 })
      await page.goto(`file://${base}/${state}/dashboard-${locale}.html`)
      await page.waitForLoadState('load')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      mkdirSync(`${base}/frames`, { recursive: true })
      const file = `${base}/frames/${state}-${locale}-${width}.png`
      await page.screenshot({ path: file, fullPage: true })
      out.push({ state, locale, width, overflow, file })
      await page.close()
    }
  }
}
await browser.close()
console.log(JSON.stringify(out, null, 1))
