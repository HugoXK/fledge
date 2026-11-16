#!/usr/bin/env node
// Refuse a rollout that does not serve the release it claims (issue #658).
//
//   METRICS_TOKEN=… node scripts/rollout-check.mjs --version 0.3.5 \
//     --commit <40-hex> --base-url https://fledge.example --release-dir /path/to/tag-worktree
//   node scripts/rollout-check.mjs --version 0.3.5 --commit <40-hex> \
//     --fixtures /path/to/saved-probe --release-dir /path/to/tag-worktree
//
// Production served `0.3.2` while the static asset directory had been replaced
// with a pre-release tree, and nothing in the deploy path could tell. The three
// facts a rollout can prove on its own are compared here: the running process
// (`/healthz` version and commit, which needs METRICS_TOKEN or a loopback
// caller), the page it renders (the footer version and the `?v=` token on its
// asset URLs, #700), and the bytes it serves for `/assets/app.css`. The expected
// bytes come from the release artifact — the tag worktree the deploy built from,
// or a recorded sha256 — never from the running tree, because the running tree
// is the thing that was replaced by hand.
//
// It writes nothing and deploys nothing. Exit codes: 0 every link agrees,
// 1 a link disagrees (refuse the rollout), 2 the command could not read its
// input (never a green verdict).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const VERSION = /^\d+\.\d+\.\d+$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const ASSET = '/assets/app.css'
const USAGE =
  'usage: node scripts/rollout-check.mjs --version X.Y.Z --commit <40-hex> (--base-url URL | --fixtures DIR) ' +
  '(--release-dir DIR | --expect-css-sha256 <64-hex>) [--public-dir DIR] [--json] [--write FILE]'
const FATAL = 2

class UsageError extends Error {}

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return ''
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} needs a value`)
  return value
}

function has(name) {
  return process.argv.includes(name)
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// The footer is the page's own claim: ` · <span class="foot-release">v0.3.2</span>`
// (src/views/layout.ts:308). A page without it names no release, which is a
// finding rather than a skipped link.
export function footerVersion(html) {
  const match = /foot-release">v(\d+\.\d+\.\d+)</.exec(String(html ?? ''))
  return match === null ? null : (match[1] ?? null)
}

// #700 versions every `/assets/…` URL with the first twelve hex of the digest of
// the bytes it serves, so a page rendered from one tree and an asset directory
// from another disagree here before the browser ever loads the file.
export function assetToken(html, path = ASSET) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:href|src)="${escaped}(?:\\?v=([0-9a-f]+))?"`).exec(String(html ?? ''))
  if (match === null) return { present: false, token: null }
  return { present: true, token: match[1] ?? null }
}

// Every file under a public tree, sorted with POSIX separators, so the release
// and the running copy are compared as the same set — an extra file is as much
// a mismatch as a changed one.
export function hashTree(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UsageError(`no public tree at ${dir}`)
  const files = {}
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files[relative(dir, full).split(sep).join('/')] = sha256(readFileSync(full))
    }
  }
  walk(dir)
  return files
}

function treeDiff(release, running) {
  const problems = []
  for (const rel of Object.keys(release).sort()) {
    if (!Object.hasOwn(running, rel)) problems.push(`${rel} is missing from the running public/`)
    else if (running[rel] !== release[rel]) problems.push(`${rel} differs: release ${release[rel].slice(0, 12)}, running ${running[rel].slice(0, 12)}`)
  }
  for (const rel of Object.keys(running).sort()) {
    if (!Object.hasOwn(release, rel)) problems.push(`${rel} is not in the release public/`)
  }
  return problems
}

export function evaluateRollout(input) {
  const { version, commit, expectedCss, healthz, html, servedCss, releaseTree = null, runningTree = null } = input
  const links = []
  const problems = []
  const link = (id, ok, detail) => {
    links.push({ id, state: ok ? 'ok' : 'mismatch', detail })
    if (!ok) problems.push(`${id}: ${detail}`)
  }

  // The process: an old build answers its own version, and a rebuilt tree under
  // the same version still answers the commit it was built from.
  link('healthz version', healthz.version === version, `served ${healthz.version || 'nothing'}, expected ${version}`)
  link(
    'healthz commit',
    healthz.commit === commit,
    healthz.commit === '' ? 'served no commit: pass METRICS_TOKEN or probe loopback' : `served ${healthz.commit}, expected ${commit}`,
  )

  const footer = footerVersion(html)
  link('footer version', footer === version, footer === null ? 'the page names no release' : `served v${footer}, expected v${version}`)

  const served = sha256(servedCss)
  link('served asset', served === expectedCss, `served ${served.slice(0, 16)} (${servedCss.length} bytes), expected ${expectedCss.slice(0, 16)}`)

  const asset = assetToken(html)
  const token = asset.token ?? ''
  link(
    'page asset',
    asset.present && token === expectedCss.slice(0, 12),
    asset.present ? `page versions ${token || 'no token'}, bytes hash to ${expectedCss.slice(0, 12)}` : `the page loads no ${ASSET}`,
  )

  if (releaseTree !== null && runningTree !== null) {
    const diff = treeDiff(releaseTree, runningTree)
    link('public tree', diff.length === 0, diff.length === 0 ? `${Object.keys(releaseTree).length} file(s) match the release` : diff.join('; '))
  }

  return { version, commit, expectedCss, servedCssSha256: served, links, problems, ok: problems.length === 0 }
}

function readFixtures(dir) {
  const read = (name) => {
    const path = join(dir, name)
    if (!existsSync(path)) throw new UsageError(`no ${name} in ${dir}`)
    return readFileSync(path)
  }
  let healthz
  try {
    const payload = JSON.parse(read('healthz.json').toString('utf8'))
    healthz = { version: String(payload?.version ?? ''), commit: String(payload?.commit ?? '') }
  } catch (error) {
    throw new UsageError(`cannot read ${join(dir, 'healthz.json')}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { healthz, html: read('index.html').toString('utf8'), servedCss: read(join('assets', 'app.css')) }
}

async function readLive(baseUrl, token) {
  const headers = token === '' ? {} : { authorization: `Bearer ${token}` }
  const get = async (path) => {
    const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new UsageError(`GET ${baseUrl}${path} answered ${response.status}`)
    return response
  }
  const healthzResponse = await get('/healthz')
  const payload = await healthzResponse.json()
  const healthz = { version: String(payload?.version ?? ''), commit: String(payload?.commit ?? '') }
  const html = await (await get('/')).text()
  const servedCss = Buffer.from(await (await get(ASSET)).arrayBuffer())
  return { healthz, html, servedCss }
}

function printResult(result) {
  const verdict = result.ok
    ? `rollout-check: ok v${result.version} commit ${result.commit} app.css ${result.expectedCss.slice(0, 12)}`
    : `rollout-check: refused — ${result.links.filter((entry) => entry.state !== 'ok').length} link(s) disagree with v${result.version} (${result.commit})`
  const lines = [verdict]
  for (const entry of result.links) lines.push(`${entry.id.padEnd(16)} ${entry.state.padEnd(9)} ${entry.detail}`)
  return lines.join('\n')
}

async function main() {
  if (has('--help')) {
    console.log(USAGE)
    return 0
  }
  const version = argument('--version')
  const commit = argument('--commit')
  if (!VERSION.test(version)) throw new UsageError(`--version "${version}" is not an X.Y.Z version`)
  if (!COMMIT.test(commit)) throw new UsageError(`--commit "${commit}" is not a 40-hex commit`)
  const baseUrl = argument('--base-url').replace(/\/$/, '')
  const fixtures = argument('--fixtures')
  if (baseUrl === '' && fixtures === '') throw new UsageError('nothing to check: pass --base-url or --fixtures')
  if (baseUrl !== '' && fixtures !== '') throw new UsageError('--base-url and --fixtures are exclusive')

  const releaseDir = argument('--release-dir')
  const expectedFlag = argument('--expect-css-sha256')
  if (releaseDir !== '' && expectedFlag !== '') throw new UsageError('--release-dir and --expect-css-sha256 are exclusive')
  let expectedCss = ''
  let releaseTree = null
  if (releaseDir !== '') {
    const artifact = join(releaseDir, 'public', 'app.css')
    if (!existsSync(artifact)) throw new UsageError(`no release artifact at ${artifact}`)
    expectedCss = sha256(readFileSync(artifact))
    releaseTree = hashTree(join(releaseDir, 'public'))
  } else {
    if (!SHA256.test(expectedFlag)) throw new UsageError('--expect-css-sha256 needs a 64-hex sha256 of the release public/app.css')
    expectedCss = expectedFlag
  }

  const publicDir = argument('--public-dir')
  const runningTree = publicDir === '' ? null : hashTree(publicDir)
  if (runningTree !== null && releaseTree === null) throw new UsageError('--public-dir needs --release-dir to compare against')

  const probe = fixtures === '' ? await readLive(baseUrl, String(process.env.METRICS_TOKEN ?? '')) : readFixtures(fixtures)
  const result = evaluateRollout({
    version,
    commit,
    expectedCss,
    healthz: probe.healthz,
    html: probe.html,
    servedCss: probe.servedCss,
    releaseTree,
    runningTree,
  })
  console.log(has('--json') ? JSON.stringify(result, null, 2) : printResult(result))
  const write = argument('--write')
  if (write !== '') {
    try {
      writeFileSync(write, `${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
      throw new UsageError(`cannot write ${write}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result.ok ? 0 : 1
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`rollout-check: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = FATAL
  }
}
