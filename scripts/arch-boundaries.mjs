#!/usr/bin/env node
// Enforce the import-direction and file-size rules in `src/`.
//
//   npm run arch:check
//
// Reads the tree, not a git diff: the gate is about the shape the next reader
// sees, not only the lines this pull request touched.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkArchitecture } from './lib/arch-boundaries.mjs'
import { isPullRequestEvent, readBaseLedger, selectLedger, violationLine } from './lib/arch-ledger.mjs'

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) walk(absolute, out)
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(absolute)
  }
  return out
}

const root = process.cwd()
const sourceRoot = join(root, 'src')
if (!existsSync(sourceRoot)) {
  console.error(`arch: no src/ directory under ${root}`)
  process.exit(1)
}

const files = walk(sourceRoot)
  .map((absolute) => ({
    path: relative(root, absolute).replaceAll('\\', '/'),
    content: readFileSync(absolute, 'utf8'),
  }))
  .sort((left, right) => left.path.localeCompare(right.path))

// #1333: the ceiling map belongs to the base branch. Reading it from the tree
// under test lets a pull request raise its own limit in the same diff, which is
// the bypass this gate exists to refuse. A named base ref must be readable; a
// local run without one reads the working tree and says so in the report line.
const LEDGER = 'scripts/lib/arch-grandfather.json'
const grandfatherPath = join(root, LEDGER)
const headContent = existsSync(grandfatherPath) ? readFileSync(grandfatherPath, 'utf8') : null

function argument(name) {
  const at = process.argv.indexOf(name)
  return at < 0 ? null : (process.argv[at + 1] ?? null)
}

function readAt(ref) {
  try {
    return execFileSync('git', ['show', `${ref}:${LEDGER}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

// A pull-request checkout names only the merge ref, so `origin/<base>` has to be
// fetched before it can be read. The gate owns that fetch: a required job's
// steps may only grow at the end (#1276), so this cannot live in `ci.yml`.
function fetchRef(ref) {
  const branch = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref
  try {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60_000,
    })
    return true
  } catch {
    return false
  }
}

const envBase = process.env.GITHUB_BASE_REF === undefined || process.env.GITHUB_BASE_REF === ''
  ? null
  : `origin/${process.env.GITHUB_BASE_REF}`
const explicitBase = argument('--base') ?? (process.env.ARCH_BASE_REF === undefined || process.env.ARCH_BASE_REF === '' ? null : process.env.ARCH_BASE_REF)
const onPullRequest = isPullRequestEvent({ eventName: process.env.GITHUB_EVENT_NAME ?? '', baseRef: process.env.GITHUB_BASE_REF ?? '' })

// The ceiling is looked for in this order and the first readable source wins:
// an explicit `--base`, the `GITHUB_BASE_REF` remote, then `HEAD^1` of the merge
// commit GitHub checks out for a pull request (its first parent is the base tip).
// Only an explicitly named base is strict: a default that cannot be read falls
// back to the working tree and the report line says which ledger judged the run.
const candidates = []
if (explicitBase !== null) candidates.push({ ref: explicitBase, strict: true })
else {
  if (envBase !== null) candidates.push({ ref: envBase, strict: false })
  if (onPullRequest) candidates.push({ ref: 'HEAD^1', strict: false })
}
let baseRef = null
let baseContent = null
for (const candidate of candidates) {
  const content = readBaseLedger({ ref: candidate.ref, readAt, fetchRef })
  if (content !== null) {
    baseRef = candidate.ref
    baseContent = content
    break
  }
  if (candidate.strict) baseRef = candidate.ref
}

// #1333: in CI the base is expected. If it cannot be read there, judging the
// head is the bypass itself, so the run fails instead of falling back.
const inCi = (process.env.GITHUB_ACTIONS ?? '') === 'true'
if (inCi && onPullRequest && baseContent === null) {
  console.error('arch: cannot read the base ledger in CI; refusing to judge the pull request against its own ceiling map')
  process.exit(1)
}

let chosen
try {
  chosen = selectLedger({ baseRef, baseContent, headContent, strict: explicitBase !== null })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
const { ledger: grandfather, source: ledgerSource } = chosen

const headLedger = headContent === null ? {} : JSON.parse(headContent)
const result = checkArchitecture({ files, grandfather })
for (const violation of result.violations) {
  console.error(violationLine(violation, { ledgerSource, headLedger }))
}
if (result.violations.length > 0) {
  console.error(`arch: ${String(result.violations.length)} violation(s)`)
  process.exit(1)
}
console.log(
  `arch: ${String(result.checked.files)} files, ${String(result.checked.imports)} imports, ${String(result.checked.grandfathered)} grandfathered (ledger from ${ledgerSource})`,
)
