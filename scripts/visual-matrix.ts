/// <reference lib="dom" />
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  caseRows,
  cellLabel,
  focusFailures,
  leftoverFailures,
  nameFailures,
  overflowFailure,
  pageSlug,
  partitionWorkload,
  shardFailures,
  summaryMarkdown,
  touchFailures,
  viewportHeight,
  visualWorkload,
} from '../src/lib/visualMatrix.js'
import type { FocusStyle, VisualCell, VisualLocale, VisualShardResult } from '../src/lib/visualMatrix.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.VISUAL_PORT ?? '18180')
const base = `http://127.0.0.1:${port}`
const outDir = process.env.VISUAL_OUT ?? join(root, 'visual-matrix')
const failures: string[] = []
// A share owns one server and one temp database; the coordinator never starts
// either, so the directory is created on first use.
let dataDir: string | null = null

function startServer(): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, [join(root, 'dist/index.js')], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: String(port),
      BASE_URL: base,
      DATA_DIR: ensureDataDir(),
      DB_PATH: join(ensureDataDir(), 'fledge.db'),
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

function ensureDataDir(): string {
  dataDir ??= mkdtempSync(join(tmpdir(), 'fledge-visual-'))
  return dataDir
}

interface ShareRequest {
  readonly index: number
  readonly total: number
}

/** `--share 2/4`, or `null` for the coordinator that spawns the shares. */
function parseShare(argv: readonly string[]): ShareRequest | null {
  const at = argv.findIndex((arg) => arg === '--share' || arg.startsWith('--share='))
  if (at === -1) return null
  const flag = argv[at]
  if (flag === undefined) return null
  const raw = flag === '--share' ? argv[at + 1] : flag.slice('--share='.length)
  const match = raw === undefined ? null : /^(\d+)\/(\d+)$/.exec(raw)
  if (match === null) throw new Error('--share takes I/N, for example --share 2/4')
  const index = Number(match[1])
  const total = Number(match[2])
  if (!Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    throw new Error(`--share ${String(raw)} is not a share of that split`)
  }
  return { index, total }
}

/**
 * One share per core, capped at the workload size. Measured on the 4-core
 * runner: four shares cut the matrix from 54-66s to 31s, and eight shares (two
 * per core) were slower at 35s, because a share is CPU-bound in the browser
 * rather than waiting on it. VISUAL_SHARDS overrides it for a measurement.
 */
function shardCount(cells: number): number {
  const requested = Number(process.env.VISUAL_SHARDS ?? '')
  const wanted = Number.isInteger(requested) && requested > 0 ? requested : Math.min(4, availableParallelism())
  return Math.max(1, Math.min(wanted, cells))
}

interface PooledPage {
  readonly context: import('playwright').BrowserContext
  readonly page: import('playwright').Page
}

/**
 * One page per locale and mode, reused across the cells of a share: the viewport
 * changes per width, the signed-in session and the forced colour scheme do not.
 */
async function pageFor(
  browser: import('playwright').Browser,
  pool: Map<string, PooledPage>,
  key: string,
  locale: VisualLocale,
  options: { readonly scheme?: 'light' | 'dark'; readonly signedIn: boolean },
): Promise<import('playwright').Page> {
  const pooled = pool.get(key)
  if (pooled !== undefined) return pooled.page
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: locale === 'en' ? 'en-US' : 'zh-CN',
    ...(options.scheme === undefined ? {} : { colorScheme: options.scheme }),
  })
  const page = await context.newPage()
  if (options.signedIn) await page.goto(`${base}/auth/dev`, { waitUntil: 'domcontentloaded' })
  await page.goto(`${base}/lang/${locale}?next=${options.signedIn ? '/dashboard' : '/'}`, { waitUntil: 'domcontentloaded' })
  pool.set(key, { context, page })
  return page
}

/** Measure one cell. Every failure keeps the cell's label, which is its identity. */
async function runCell(
  browser: import('playwright').Browser,
  pool: Map<string, PooledPage>,
  cell: VisualCell,
): Promise<void> {
  const prefix = cellLabel(cell)
  try {
    if (cell.kind === 'theme') {
      await checkExplicitTheme(browser, cell.locale, cell.width)
      return
    }
    const signedIn = cell.path !== '/'
    const mode = cell.kind === 'gate' ? `gate-${cell.scheme}` : 'sweep'
    const page = await pageFor(browser, pool, `${cell.locale}|${mode}|${signedIn ? 'in' : 'guest'}`, cell.locale, {
      scheme: cell.kind === 'gate' ? cell.scheme : undefined,
      signedIn,
    })
    await page.setViewportSize({ width: cell.width, height: viewportHeight(cell.width) })
    if (cell.kind === 'gate') await checkGatePage(page, cell.locale, cell.width, cell.scheme, cell.path)
    else await checkPage(page, cell.locale, cell.width, cell.path)
  } catch (error) {
    failures.push(`${prefix}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function shardResultPath(dir: string, share: number): string {
  return join(dir, `shard-${String(share)}.json`)
}

async function runShare(share: ShareRequest): Promise<void> {
  const parts = partitionWorkload(visualWorkload(), share.total)
  const cells = parts[share.index - 1] ?? []
  const resultDir = join(outDir, 'shares')
  mkdirSync(resultDir, { recursive: true })
  for (const locale of new Set(cells.map((cell) => cell.locale))) mkdirSync(join(outDir, locale), { recursive: true })
  const visited: string[] = []
  const child = startServer()
  let browser: import('playwright').Browser | null = null
  try {
    await waitForServer()
    browser = await chromium.launch()
    const pool = new Map<string, PooledPage>()
    try {
      for (const cell of cells) {
        // Recorded before it runs: a cell that throws is still a cell this share
        // measured, and its failure names it.
        visited.push(cellLabel(cell))
        await runCell(browser, pool, cell)
      }
    } finally {
      for (const pooled of pool.values()) await pooled.context.close()
    }
  } catch (error) {
    failures.push(
      `share ${String(share.index)}/${String(share.total)} stopped: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await browser?.close()
    await stopServer(child)
    if (dataDir !== null) rmSync(dataDir, { recursive: true, force: true })
  }
  const result: VisualShardResult = { share: share.index, cells: visited, failures }
  writeFileSync(shardResultPath(resultDir, share.index), `${JSON.stringify(result, null, 2)}\n`)
  report(`share ${String(share.index)}/${String(share.total)} measured ${String(visited.length)} cell(s)`)
}

/** Read one share's result; anything unreadable counts as a result that never arrived. */
function readShardResult(dir: string, share: number): VisualShardResult | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(shardResultPath(dir, share), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as { cells?: unknown; failures?: unknown }
    if (!Array.isArray(record.cells) || !Array.isArray(record.failures)) return null
    if (!record.cells.every((cell) => typeof cell === 'string')) return null
    if (!record.failures.every((failure) => typeof failure === 'string')) return null
    return { share, cells: record.cells as string[], failures: record.failures as string[] }
  } catch {
    return null
  }
}

function spawnShare(share: ShareRequest): ChildProcess {
  // Each share owns a port and a temp database: two servers on one port would
  // measure whichever booted first, and a shared database is a write conflict.
  return spawn(process.execPath, ['--import', 'tsx', 'scripts/visual-matrix.ts', '--share', `${String(share.index)}/${String(share.total)}`], {
    cwd: root,
    env: { ...process.env, VISUAL_PORT: String(port + share.index), VISUAL_OUT: outDir },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
}

function exitCode(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? null : 1)))
  })
}

function report(summary: string): void {
  if (failures.length === 0) {
    console.log(`visual matrix: ${summary} clean`)
    return
  }
  console.error(`visual matrix: ${String(failures.length)} failure(s)`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
}

/** The aggregate's reasons that belong to no single row: a share that died, a cell counted twice. */
function aggregateNotes(problems: readonly string[], cells: readonly VisualCell[]): string[] {
  const labels = cells.map((cell) => cellLabel(cell))
  return problems.filter((problem) => !labels.some((label) => problem.startsWith(`${label}: `)))
}

/** The job summary is optional: a local run has no GITHUB_STEP_SUMMARY to append to. */
function writeStepSummary(rows: readonly import('../src/lib/visualMatrix.js').VisualCaseResult[], notes: readonly string[]): void {
  const target = process.env.GITHUB_STEP_SUMMARY
  if (target === undefined || target === '') return
  try {
    appendFileSync(target, summaryMarkdown(rows, notes))
  } catch (error) {
    console.error(`visual matrix: the job summary was not written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runCoordinator(): Promise<void> {
  const workload = visualWorkload()
  const shares = shardCount(workload.length)
  const resultDir = join(outDir, 'shares')
  mkdirSync(resultDir, { recursive: true })
  // A result left by an earlier run in the same checkout would answer for a
  // share that never ran this time.
  for (const file of readdirSync(resultDir)) {
    if (/^shard-\d+\.json$/.test(file)) rmSync(join(resultDir, file), { force: true })
  }
  const requests: ShareRequest[] = []
  for (let index = 1; index <= shares; index += 1) requests.push({ index, total: shares })
  const children = requests.map((request) => spawnShare(request))
  const codes = await Promise.all(children.map((child) => exitCode(child)))
  const results = requests.map((request) => readShardResult(resultDir, request.index))
  const problems = shardFailures(workload, shares, results)
  codes.forEach((code, position) => {
    const result = results[position] ?? null
    if (code !== 0 && (result === null || result.failures.length === 0)) {
      problems.push(
        `share ${String(position + 1)}/${String(shares)} exited ${String(code)} without naming a failure: its cells are unverified`,
      )
    }
  })
  failures.push(...problems)
  // The table is written before the exit code is decided, so a red run still
  // names every page, viewport and scheme instead of one line for the matrix.
  writeStepSummary(caseRows(workload, results), aggregateNotes(problems, workload))
  report(`${String(workload.length)} cell(s) over ${String(shares)} share(s)`)
}

const share = parseShare(process.argv.slice(2))
void (share === null ? runCoordinator() : runShare(share)).catch((error: unknown) => {
  console.error(`visual matrix: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
