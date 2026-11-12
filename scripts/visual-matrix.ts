/// <reference lib="dom" />
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { VISUAL_PATHS, VISUAL_WIDTHS, overflowFailure, pageSlug, viewportHeight } from '../src/lib/visualMatrix.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.VISUAL_PORT ?? '18180')
const base = `http://127.0.0.1:${port}`
const outDir = process.env.VISUAL_OUT ?? join(root, 'visual-matrix')
const dataDir = mkdtempSync(join(tmpdir(), 'fledge-visual-'))
const failures: string[] = []
// `/` is captured signed out above; every other path needs the development login.
const SIGNED_IN_PATHS = VISUAL_PATHS.filter((path) => path !== '/')

function startServer(): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(port),
      BASE_URL: base,
      DATA_DIR: dataDir,
      DB_PATH: join(dataDir, 'fledge.db'),
      SESSION_SECRET: randomBytes(32).toString('hex'),
      TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      ALLOW_TOKEN_LOGIN_ONLY: 'true',
      DEV_LOGIN_LOGIN: 'visual-matrix',
      DEV_LOGIN_ADMIN: 'true',
      MAIL_TRANSPORT: 'console',
      RUNNER_MODE: 'mock',
      TRUST_PROXY: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.resume()
  child.stderr?.resume()
  return child
}

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/healthz`)
      if (response.ok) return
    } catch {
      // The next tick retries; a slow first boot is not a failure yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`server did not answer ${base}/healthz within 30s`)
}

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function checkPage(page: import('playwright').Page, locale: string, width: number, path: string): Promise<void> {
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(150)
  const result = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth
    const bad: string[] = []
    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.right <= clientWidth + 1) continue
      const scroll = element.closest('.table-scroll')
      if (scroll !== null && scroll !== element) continue
      if (getComputedStyle(element).position === 'fixed') continue
      if (element.getAttribute('data-allow-overflow') !== null) continue
      const name = element.tagName.toLowerCase()
      const classes = typeof element.className === 'string'
        ? element.className.split(/\s+/).filter((value) => value !== '').slice(0, 2).join('.')
        : ''
      bad.push(classes === '' ? name : `${name}.${classes}`)
      if (bad.length >= 3) break
    }
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth, bad }
  })
  const failure = overflowFailure(result)
  if (failure !== null) failures.push(`${locale} ${width}px ${path}: ${failure}`)
  await page.screenshot({
    path: join(outDir, locale, `${width}-${pageSlug(path)}.png`),
    fullPage: true,
  })
  if (path === '/settings') {
    await page.goto(`${base}/settings#tokens`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(150)
    const positions = await page.evaluate(() => {
      const target = document.getElementById('tokens')
      const header = document.querySelector('.top')
      return {
        target: target === null ? null : target.getBoundingClientRect().top,
        header: header === null ? 0 : header.getBoundingClientRect().height,
      }
    })
    // A missing target used to skip this assertion, so the guard passed on a page
    // that had no anchor at all. The zero-token empty state links to `#tokens`, so
    // a settings page without it is a broken link, not a page to measure (#453).
    if (positions.target === null) {
      failures.push(`${locale} ${width}px /settings#tokens: the page has no #tokens anchor to scroll to`)
    } else if (positions.target < positions.header - 1) {
      failures.push(`${locale} ${width}px /settings#tokens: section starts under the sticky header`)
    }
  }
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true })
  const child = startServer()
  let browser: import('playwright').Browser | null = null
  try {
    await waitForServer()
    browser = await chromium.launch()
    for (const locale of ['zh', 'en'] as const) {
      mkdirSync(join(outDir, locale), { recursive: true })
      // The landing page only exists for a signed-out visitor: src/app.ts answers
      // `/` with a 302 to /dashboard once a session exists, so signing in first
      // photographed the dashboard twice and called one copy "landing" (#453).
      const guest = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: locale === 'en' ? 'en-US' : 'zh-CN',
      })
      const guestPage = await guest.newPage()
      await guestPage.goto(`${base}/lang/${locale}?next=/`, { waitUntil: 'domcontentloaded' })
      for (const width of VISUAL_WIDTHS) {
        await guestPage.setViewportSize({ width, height: viewportHeight(width) })
        try {
          await checkPage(guestPage, locale, width, '/')
        } catch (error) {
          failures.push(`${locale} ${width}px /: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await guest.close()

      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        locale: locale === 'en' ? 'en-US' : 'zh-CN',
      })
      const page = await context.newPage()
      await page.goto(`${base}/auth/dev`, { waitUntil: 'domcontentloaded' })
      await page.goto(`${base}/lang/${locale}?next=/dashboard`, { waitUntil: 'domcontentloaded' })
      for (const width of VISUAL_WIDTHS) {
        await page.setViewportSize({ width, height: viewportHeight(width) })
        for (const path of SIGNED_IN_PATHS) {
          try {
            await checkPage(page, locale, width, path)
          } catch (error) {
            failures.push(`${locale} ${width}px ${path}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      await context.close()
    }
  } finally {
    await browser?.close()
    await stopServer(child)
    rmSync(dataDir, { recursive: true, force: true })
  }
  if (failures.length > 0) {
    console.error(`visual matrix: ${failures.length} failure(s)`)
    for (const failure of failures) console.error(`- ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`visual matrix: ${VISUAL_PATHS.length} pages x ${VISUAL_WIDTHS.length} widths x 2 locales clean`)
  console.log(`screenshots: ${outDir}`)
}

void main()
