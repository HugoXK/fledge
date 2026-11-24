// #1271: capture the before/after pair a UI pull request needs, from one command.
//
//   npm run evidence:ui -- --issue 1230 --path /admin/metrics --selector '#sqlite-health'
//   npm run evidence:ui -- --issue 1263 --path '/repos/repo_evidence_ui#repo-settings' --selector 'details[data-advanced="repo-settings"]' --open summary
//
// The tool builds the base and head in throwaway worktrees, seeds one shared
// fixture database, starts each app, signs in with the dev login, clicks every
// `--open` selector and screenshots the same selector. It writes the images on
// an `evidence/<issue>` branch and prints a ready-to-paste body table; it never
// opens a PR and never moves the tip.

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import { Store } from '../src/db.js'
import {
  evidenceBranch,
  evidencePlan,
  evidenceSummary,
  parseEvidenceArgs,
  seedEvidenceFixture,
  type EvidenceArgs,
  type EvidencePlanItem,
} from './lib/evidenceUi.js'

const USAGE = [
  'usage: npm run evidence:ui -- --issue <n> --path </route> --selector <css>',
  '  [--base origin/main] [--head HEAD] [--locales en,zh] [--widths 1280,390]',
  '  [--open <css>]... [--push] [--keep] [--dry-run]',
].join('\n')

function fail(message: string): never {
  console.error(`evidence-ui: ${message}`)
  process.exit(2)
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-4).join(' ')
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)}): ${detail}`)
  }
}

function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`)
  return result.stdout ?? ''
}

function waitForServer(base: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const deadline = Date.now() + 30_000
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch(`${base}/healthz`)
        if (response.ok) return resolvePromise()
      } catch {
        // Retry until the deadline; the first boot can be slow.
      }
      if (Date.now() > deadline) return reject(new Error(`server did not answer ${base}/healthz`))
      setTimeout(() => void poll(), 250)
    }
    void poll()
  })
}

function startServer(root: string, dataDir: string, port: number): { child: ReturnType<typeof spawn>; base: string } {
  const base = `http://127.0.0.1:${String(port)}`
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
  return { child, base }
}

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise()
    }, 5_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise()
    })
  })
}

async function capture(root: string, dataDir: string, port: number, args: EvidenceArgs, item: EvidencePlanItem, out: string): Promise<void> {
  const { child, base } = startServer(root, dataDir, port)
  try {
    await waitForServer(base)
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext({
        viewport: { width: item.width, height: item.width <= 390 ? 844 : 900 },
        locale: item.locale === 'zh' ? 'zh-CN' : 'en-US',
      })
      const page = await context.newPage()
      await page.goto(`${base}/auth/dev`, { waitUntil: 'domcontentloaded' })
      await page.goto(`${base}/lang/${item.locale}?next=${encodeURIComponent('/dashboard')}`, { waitUntil: 'domcontentloaded' })
      await page.goto(`${base}${args.path}`, { waitUntil: 'networkidle' })
      for (const selector of args.open) {
        const opener = page.locator(selector).first()
        await opener.waitFor({ state: 'visible', timeout: 15_000 })
        await opener.click()
      }
      const target = page.locator(args.selector).first()
      await target.waitFor({ state: 'visible', timeout: 15_000 })
      await target.screenshot({ path: out })
      console.log(`captured ${item.file}`)
    } finally {
      await browser.close()
    }
  } finally {
    await stopServer(child)
  }
}

async function main(): Promise<void> {
  const parsed = parseEvidenceArgs(process.argv.slice(2))
  if (!parsed.ok) fail(`${parsed.error}\n${USAGE}`)
  const args = parsed.args
  const plan = evidencePlan(args)
  if (args.dryRun) {
    console.log(`evidence-ui: #${String(args.issue)} on ${args.base}..${args.head}`)
    for (const item of plan) console.log(`${item.phase} ${item.locale} ${String(item.width)} -> ${item.file}`)
    console.log(evidenceSummary(args, plan))
    return
  }

  const repoRoot = process.cwd()
  const dirty = git(['status', '--porcelain'], repoRoot).trim()
  if (dirty !== '') fail('the worktree is dirty; commit or stash it before capturing evidence')
  if (!existsSync(join(repoRoot, 'node_modules'))) fail('node_modules is missing; run npm ci first')
  if (!existsSync(join(repoRoot, 'node_modules', 'playwright'))) fail('playwright is missing; run npm ci and npx playwright install chromium')

  const temp = mkdtempSync(join(tmpdir(), 'fledge-evidence-'))
  const dataDir = join(temp, 'data')
  mkdirSync(dataDir, { recursive: true })
  const worktrees: string[] = []
  try {
    const addWorktree = (name: string, ref: string): string => {
      const root = join(temp, name)
      git(['worktree', 'add', '--detach', root, ref], repoRoot)
      worktrees.push(root)
      symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
      run('npm', ['run', 'build'], root)
      return root
    }
    const baseRoot = addWorktree('base', args.base)
    const headRoot = addWorktree('head', args.head)

    const seedStore = new Store(join(dataDir, 'fledge.db'))
    try {
      seedEvidenceFixture(seedStore)
    } finally {
      seedStore.close()
    }

    const captured: Array<{ item: EvidencePlanItem; path: string }> = []
    let port = 18230
    for (const item of plan) {
      const root = item.phase === 'before' ? baseRoot : headRoot
      const out = join(temp, 'images', item.file)
      mkdirSync(dirname(out), { recursive: true })
      await capture(root, dataDir, port, args, item, out)
      port += 1
      captured.push({ item, path: out })
    }

    const evidenceRoot = join(temp, 'evidence')
    git(['worktree', 'add', '-B', evidenceBranch(args.issue), evidenceRoot, 'origin/main'], repoRoot)
    worktrees.push(evidenceRoot)
    for (const entry of captured) {
      const dest = join(evidenceRoot, 'docs/images', String(args.issue), entry.item.file.split('/').pop() ?? 'image.png')
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(entry.path, dest)
    }
    git(['add', `docs/images/${String(args.issue)}`], evidenceRoot)
    const name = spawnSync('git', ['config', 'user.name'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim() ?? ''
    const email = spawnSync('git', ['config', 'user.email'], { cwd: repoRoot, encoding: 'utf8' }).stdout?.trim() ?? ''
    if (name === '' || email === '') fail('git user.name and user.email must be configured before the evidence commit')
    git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', `Evidence: before/after for #${String(args.issue)}`], evidenceRoot)

    if (args.push) {
      git(['push', '-u', 'origin', evidenceBranch(args.issue)], evidenceRoot)
      console.log(`pushed ${evidenceBranch(args.issue)}`)
    } else {
      console.log(`evidence branch committed in ${evidenceRoot}`)
      console.log(`push it with: git -C ${evidenceRoot} push -u origin ${evidenceBranch(args.issue)}`)
      console.log('the temporary worktree is kept so the branch can be pushed; rerun with --push to do it here')
    }
    console.log('')
    console.log(evidenceSummary(args, plan))
  } finally {
    // A push (without --keep) owns the whole temporary tree. Without a push the
    // evidence worktree is kept so the printed command can still push it; the
    // user removes it when the branch is on the remote.
    if (args.push && !args.keep) {
      for (const root of worktrees) {
        try { git(['worktree', 'remove', '--force', root], repoRoot) } catch { /* best effort */ }
      }
      rmSync(temp, { recursive: true, force: true })
    } else if (!args.keep) {
      console.log(`kept ${temp}`)
    }
  }
}

void main().catch((error: unknown) => {
  console.error(`evidence-ui: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
