/// <reference lib="dom" />
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  GATE_SCHEMES,
  GATE_WIDTHS,
  VISUAL_NARROW_CASES,
  VISUAL_PATHS,
  VISUAL_WIDTHS,
  focusFailures,
  leftoverFailures,
  nameFailures,
  overflowFailure,
  pageSlug,
  touchFailures,
  viewportHeight,
} from '../src/lib/visualMatrix.js'
import type { FocusStyle } from '../src/lib/visualMatrix.js'

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
  // No helper functions inside `evaluate`: the runner's esbuild pass injects a
  // `__name` helper into named functions, and the browser context has no such
  // binding, so a function here fails with "ReferenceError: __name".
  const result = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth
    const bad: {
      name: string
      waiver: boolean
      clipped: boolean
      scrollerAncestor: boolean
      isScroller: boolean
    }[] = []
    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.right <= clientWidth + 1) continue
      const style = getComputedStyle(element)
      if (style.position === 'fixed') continue
      const scroll = element.closest('.table-scroll')
      // #557: the class name says where a scrollbar would live, not that there is
      // content to scroll to. An inert `overflow: visible` box carrying the class
      // waived every descendant, so the ancestor has to prove it scrolls.
      const scrollStyle = scroll === null ? null : getComputedStyle(scroll)
      const clippedByScroller = scroll !== null && scroll !== element && scrollStyle !== null
        && (scrollStyle.overflowX === 'auto' || scrollStyle.overflowX === 'scroll')
        && scroll.scrollWidth > scroll.clientWidth + 1
      // `data-allow-overflow` is a request, not a verdict: the ancestor walk
      // decides whether a scroller can bring the element into view, and an
      // element that is itself the overflowing scroller stays a failure. A
      // scroller only hides content when it has somewhere to scroll to, so
      // `scrollWidth > clientWidth` is part of the test, not just overflow-x.
      let scrollerAncestor = false
      for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent)
        if (parentStyle.overflowX !== 'auto' && parentStyle.overflowX !== 'scroll') continue
        if (parent.scrollWidth > parent.clientWidth + 1) {
          scrollerAncestor = true
          break
        }
      }
      const name = element.tagName.toLowerCase()
      const classes = typeof element.className === 'string'
        ? element.className.split(/\s+/).filter((value) => value !== '').slice(0, 2).join('.')
        : ''
      bad.push({
        name: classes === '' ? name : `${name}.${classes}`,
        waiver: element.hasAttribute('data-allow-overflow'),
        clipped: clippedByScroller,
        scrollerAncestor,
        isScroller: (style.overflowX === 'auto' || style.overflowX === 'scroll')
          && element.scrollWidth > element.clientWidth + 1,
      })
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
      const nav = document.querySelector('.settings-shell > .section-nav')
      const cards: { id: string; left: number; width: number }[] = []
      for (const card of document.querySelectorAll('.settings-shell > section.card')) {
        const rect = card.getBoundingClientRect()
        cards.push({ id: card.id, left: rect.left, width: rect.width })
      }
      return {
        target: target === null ? null : target.getBoundingClientRect().top,
        header: header === null ? 0 : header.getBoundingClientRect().height,
        wide: window.matchMedia('(min-width: 961px)').matches,
        navRight: nav === null ? null : nav.getBoundingClientRect().right,
        cards,
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
    // #998: from 961px the shell is a two-column grid and the rail takes column 1.
    // Auto-placement put the second and fourth card inside that 208px column, so
    // each card has to start to the right of the rail. The overflow rule above
    // cannot see it: every card still fits the viewport, it just sits in the
    // wrong column. Measured after the `#tokens` scroll, so the horizontal
    // numbers are the landing layout, not a transient.
    const railRight = positions.navRight
    if (positions.wide && railRight !== null) {
      const inside = positions.cards.filter((card) => card.left < railRight - 1)
      if (inside.length > 0) {
        const named = inside.map((card) => `#${card.id} (x=${String(Math.round(card.left))} w=${String(Math.round(card.width))})`).join(', ')
        failures.push(`${locale} ${width}px /settings: card inside the rail column instead of beside it: ${named}`)
      }
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
      // #950: a page whose narrowest layout needs a width below the sweep is
      // measured here, so a 320-only overflow reaches a failure instead of a
      // clean run because the width was never rendered.
      for (const narrow of VISUAL_NARROW_CASES) {
        await page.setViewportSize({ width: narrow.width, height: viewportHeight(narrow.width) })
        try {
          await checkPage(page, locale, narrow.width, narrow.path)
        } catch (error) {
          failures.push(`${locale} ${narrow.width}px ${narrow.path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      await context.close()
      // #870: the measured gate runs after the screenshot sweep, so a screenshot
      // failure and a gate failure are still one job with one list.
      await runGatePass(browser, locale)
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
  console.log(`visual matrix: ${VISUAL_PATHS.length} pages x ${VISUAL_WIDTHS.length} widths x 2 locales + ${String(VISUAL_NARROW_CASES.length)} narrow case(s) clean`)
  console.log(`visual gate: ${VISUAL_PATHS.length} pages x ${GATE_WIDTHS.length} widths x ${GATE_SCHEMES.length} schemes x 2 locales, touch/focus/name/leftover clean`)
  console.log(`screenshots: ${outDir}`)
}

// #870: the gate pass. Nine widths stay the screenshot sweep; the measured
// matrix is three widths by two schemes, because a colour scheme the host
// happened to carry is not a decision the matrix made. Every failure names the
// four coordinates and the control, so a red job points at one row of the board
// instead of a screenshot nobody can diff.
async function checkGatePage(
  page: import('playwright').Page,
  locale: string,
  width: number,
  scheme: string,
  path: string,
): Promise<void> {
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(150)
  // No helper functions inside `evaluate`: the runner's esbuild pass injects a
  // `__name` helper into named functions and the browser context has no such
  // binding (the overflow walk above hit the same wall).
  const collected = await page.evaluate(() => {
    const selector = 'button, .btn, input, select, textarea, summary, .section-nav a'
    const elements = Array.from(document.querySelectorAll(selector))
    const controls: {
      index: number
      name: string
      width: number
      height: number
      compact: boolean
      inline: boolean
      disclosure: boolean
    }[] = []
    const names: { tag: string; text: string; ariaLabel: string | null; title: string | null; hasSvg: boolean }[] = []
    const baseline: { index: number; style: FocusStyle }[] = []
    let index = 0
    for (const element of elements) {
      const tag = element.tagName.toLowerCase()
      const classes = typeof element.className === 'string'
        ? element.className.trim().split(/\s+/).filter((value) => value !== '').slice(0, 2).join('.')
        : ''
      const name = classes === '' ? tag : `${tag}.${classes}`
      const rendered = (element as unknown as { checkVisibility?: () => boolean }).checkVisibility?.() ?? true
      // A checkbox is 13px by nature; the label around it is the box a pointer
      // hits, so the label is what the 44px floor measures.
      const label = element.tagName === 'INPUT' ? element.closest('label') : null
      const target = label ?? element
      const rect = target.getBoundingClientRect()
      // A closed `<details>` keeps a non-zero rect in Chromium but is not
      // rendered (`checkVisibility()` is false), so a control inside it is not a
      // target a reader can reach until the disclosure opens.
      if (rendered && rect.width > 0 && rect.height > 0) {
        element.setAttribute('data-gate-index', String(index))
        const style = getComputedStyle(element)
        baseline.push({
          index,
          style: {
            outlineWidth: style.outlineWidth,
            outlineStyle: style.outlineStyle,
            boxShadow: style.boxShadow,
            borderColor: style.borderColor,
            backgroundColor: style.backgroundColor,
          },
        })
        controls.push({
          index,
          name,
          width: rect.width,
          height: rect.height,
          compact: element.hasAttribute('data-compact-target'),
          inline: element.hasAttribute('data-inline-target'),
          disclosure: tag === 'summary',
        })
        index += 1
      }
      if (rendered && (tag === 'button' || tag === 'a')) {
        names.push({
          tag,
          text: ((element as HTMLElement).innerText ?? '').trim(),
          ariaLabel: element.getAttribute('aria-label'),
          title: element.getAttribute('title'),
          hasSvg: element.querySelector('svg') !== null,
        })
      }
    }
    return { controls, names, baseline, html: document.documentElement.outerHTML }
  })

  // A programmatic `focus()` does not match `:focus-visible` in this browser, so
  // the resting style stays put and every control reads as unringed. Tabbing is
  // how a keyboard reader actually reaches the control, and it is the only way
  // the product's `*:focus-visible` rule is exercised.
  const focused = new Map<number, FocusStyle>()
  const wanted = new Set(collected.baseline.map((entry) => entry.index))
  const limit = Math.min(400, wanted.size + 15)
  for (let press = 0; press < limit && focused.size < wanted.size; press += 1) {
    await page.keyboard.press('Tab')
    const hit = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null
      const raw = active === null ? null : active.getAttribute('data-gate-index')
      if (raw === null || active === null) return null
      const style = getComputedStyle(active)
      return {
        index: Number(raw),
        style: {
          outlineWidth: style.outlineWidth,
          outlineStyle: style.outlineStyle,
          boxShadow: style.boxShadow,
          borderColor: style.borderColor,
          backgroundColor: style.backgroundColor,
        },
      }
    })
    if (hit !== null && !focused.has(hit.index)) focused.set(hit.index, hit.style)
  }

  const prefix = `${locale} width=${String(width)} scheme=${scheme} ${path}`
  for (const message of touchFailures(collected.controls)) failures.push(`${prefix}: ${message}`)
  const samples: { name: string; before: FocusStyle; after: FocusStyle }[] = []
  for (const entry of collected.baseline) {
    const after = focused.get(entry.index)
    if (after === undefined) continue
    const control = collected.controls.find((candidate) => candidate.index === entry.index)
    samples.push({ name: control?.name ?? `control #${String(entry.index)}`, before: entry.style, after })
  }
  for (const message of focusFailures(samples)) failures.push(`${prefix}: ${message}`)
  for (const message of nameFailures(collected.names)) failures.push(`${prefix}: ${message}`)
  for (const message of leftoverFailures(collected.html)) failures.push(`${prefix}: ${message}`)
}

/**
 * An explicit palette has to win over the host preference: the stylesheet keeps
 * a light media branch and pins an explicit `data-theme`, and only a real
 * document shows which one painted the page. The host is asked for light while
 * the saved choice is dark, so a page that quietly follows the host fails here
 * instead of passing because both sides agreed.
 */
async function checkExplicitTheme(
  browser: import('playwright').Browser,
  locale: string,
  width: number,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width, height: viewportHeight(width) },
    locale: locale === 'en' ? 'en-US' : 'zh-CN',
    colorScheme: 'light',
  })
  try {
    await context.addCookies([{ name: 'fledge_theme', value: 'dark', url: base }])
    const page = await context.newPage()
    await page.goto(`${base}/auth/dev`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${base}/lang/${locale}?next=/dashboard`, { waitUntil: 'domcontentloaded' })
    await page.goto(`${base}/dashboard`, { waitUntil: 'domcontentloaded' })
    const seen = await page.evaluate(() => ({
      theme: document.documentElement.getAttribute('data-theme') ?? '',
      meta: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? '',
      background: getComputedStyle(document.body).backgroundColor,
    }))
    if (seen.theme !== 'dark' || seen.meta !== 'dark') {
      failures.push(
        `${locale} width=${String(width)} scheme=explicit-dark /dashboard: the saved dark theme did not win over a light host preference (data-theme="${seen.theme}", color-scheme meta="${seen.meta}")`,
      )
    }
    if (seen.background === 'rgb(238, 241, 234)' || seen.background === 'rgb(248, 250, 245)') {
      failures.push(
        `${locale} width=${String(width)} scheme=explicit-dark /dashboard: the page kept the light palette (body background ${seen.background})`,
      )
    }
  } finally {
    await context.close()
  }
}

async function runGatePass(browser: import('playwright').Browser, locale: string): Promise<void> {
  for (const width of GATE_WIDTHS) {
    for (const scheme of GATE_SCHEMES) {
      const signedIn = await browser.newContext({
        viewport: { width, height: viewportHeight(width) },
        locale: locale === 'en' ? 'en-US' : 'zh-CN',
        colorScheme: scheme,
      })
      try {
        const page = await signedIn.newPage()
        await page.goto(`${base}/auth/dev`, { waitUntil: 'domcontentloaded' })
        await page.goto(`${base}/lang/${locale}?next=/dashboard`, { waitUntil: 'domcontentloaded' })
        for (const path of VISUAL_PATHS) {
          // `/` answers 302 to /dashboard once a session exists; the guest
          // context below is the only place it can be measured.
          if (path === '/') continue
          try {
            await checkGatePage(page, locale, width, scheme, path)
          } catch (error) {
            failures.push(`${locale} width=${String(width)} scheme=${scheme} ${path}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      } finally {
        await signedIn.close()
      }
      // The landing page only exists for a signed-out visitor (#453).
      const guest = await browser.newContext({
        viewport: { width, height: viewportHeight(width) },
        locale: locale === 'en' ? 'en-US' : 'zh-CN',
        colorScheme: scheme,
      })
      try {
        const page = await guest.newPage()
        await page.goto(`${base}/lang/${locale}?next=/`, { waitUntil: 'domcontentloaded' })
        try {
          await checkGatePage(page, locale, width, scheme, '/')
        } catch (error) {
          failures.push(`${locale} width=${String(width)} scheme=${scheme} /: ${error instanceof Error ? error.message : String(error)}`)
        }
      } finally {
        await guest.close()
      }
    }
    await checkExplicitTheme(browser, locale, width)
  }
}

void main()
