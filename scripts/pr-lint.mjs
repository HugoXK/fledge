#!/usr/bin/env node
// Validate a pull request's body, changelog/docs obligations and risk label.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/pr-lint.mjs --pr 12
//
// Runs on pull_request, pull_request_review and merge_group.

import { readFileSync } from 'node:fs'
import { tierForFiles, loadRules } from './lib/risk.mjs'

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''
const REPO = process.env.GITHUB_REPOSITORY ?? ''
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com'
const EVENT = process.env.GITHUB_EVENT_PATH ?? ''
const POLICY = JSON.parse(readFileSync('.github/agent/review-policy.json', 'utf8'))

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function event() {
  if (EVENT === '') return {}
  try {
    return JSON.parse(readFileSync(EVENT, 'utf8'))
  } catch {
    return {}
  }
}

const ev = event()
const prNumber = Number(
  arg('--pr', ev.pull_request?.number ?? /pr-(\d+)-/.exec(ev.merge_group?.head_ref ?? '')?.[1] ?? /refs\/pull\/(\d+)\//.exec(process.env.GITHUB_REF ?? '')?.[1] ?? '0'),
)

if (TOKEN === '') fail('GITHUB_TOKEN is not set')
if (REPO === '') fail('GITHUB_REPOSITORY is not set')
if (!Number.isInteger(prNumber) || prNumber <= 0) fail('cannot determine the pull request number')

function fail(message) {
  console.error(`pr-lint: FAIL — ${message}`)
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    import('node:fs').then(({ appendFileSync }) => appendFileSync(process.env.GITHUB_STEP_SUMMARY, 'pr-lint: FAIL — see the job log.\n')).catch(() => {})
  }
  process.exit(1)
}

async function api(path) {
  const response = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'fledge-pr-lint',
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub ${response.status} ${path}: ${text.slice(0, 200)}`)
  }
  return response.json()
}

async function paginate(path, maxPages = 6) {
  const out = []
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes('?') ? '&' : '?'
    const items = await api(`${path}${separator}per_page=100&page=${page}`)
    out.push(...items)
    if (items.length < 100) break
  }
  return out
}

const INVESTIGATE_PATH = /(^|\n)\s*(No-issue|Investigates)\s*:/i
const DOCS_GROUPS = [
  { match: /^src\/(auth|users|email)\//, docs: ['docs/security.md'] },
  { match: /^src\/gateway\//, docs: ['docs/quota.md'] },
  { match: /^src\/jobs\//, docs: ['docs/quota.md', 'docs/api.md', 'docs/architecture.md'] },
  { match: /^src\/repos\//, docs: ['docs/api.md'] },
  { match: /^src\/(app\.ts|db\.ts|views\/)/, docs: ['docs/architecture.md'] },
  { match: /^bridge\//, docs: ['bridge/README.md'] },
  { match: /^(deploy\/|Dockerfile$|docker-compose\.yml$)/, docs: ['docs/deploy.md'] },
]

function covers(path, doc) {
  if (path === doc) return true
  return path.startsWith(doc.endsWith('/') ? doc : `${doc}/`)
}

function firstLine(body) {
  return String(body ?? '').split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
}

const pr = await api(`/repos/${REPO}/pulls/${prNumber}`).catch((error) => fail(error.message))
const files = await paginate(`/repos/${REPO}/pulls/${prNumber}/files`).catch((error) => fail(error.message))
const body = String(pr.body ?? '')
const paths = files.map((file) => file.filename)
const errors = []

if (!/^Written-by:\s*\S+/.test(firstLine(body).trim())) {
  errors.push('the PR body must start with "Written-by: <name>"')
}
if (!INVESTIGATE_PATH.test(body) && !/(^|\n)\s*Fixes #\d+\b/.test(body)) {
  errors.push('the PR body needs "Fixes #N", "No-issue:" or "Investigates:"')
}
if (!/(^|\n)\s*Ran[^\n:]*[:：]/.test(body)) errors.push('the PR body needs a "Ran:" section')
if (!/(^|\n)\s*Not run[^\n:]*[:：]/i.test(body)) errors.push('the PR body needs a "Not run:" section')

const fragmentAdded = files.some((file) => file.status === 'added' && /^changelog\.d\/[^/]+\.(added|changed|deprecated|removed|fixed|security)\.md$/.test(file.filename))
if (paths.some((path) => path.startsWith('src/')) && !fragmentAdded && !/(^|\n)\s*Changelog-not-needed\s*:/i.test(body)) {
  errors.push('a src/ change needs a changelog.d fragment or "Changelog-not-needed:"')
}

for (const group of DOCS_GROUPS) {
  if (!paths.some((path) => group.match.test(path))) continue
  if (group.docs.some((doc) => paths.some((path) => covers(path, doc)))) continue
  if (/(^|\n)\s*Docs-not-needed\s*:/i.test(body)) continue
  errors.push(`the changed module owns ${group.docs.join(' or ')}; update it or add "Docs-not-needed:"`)
}

const rules = loadRules()
const computed = tierForFiles(paths, rules).tier
const labels = (pr.labels ?? []).map((label) => label.name)
for (const label of labels.filter((name) => /^risk:T[0-3]$/.test(name))) {
  if (label !== `risk:${computed}`) errors.push(`label ${label} does not match the computed tier risk:${computed}`)
}

const writer = /^\s*Written-by:\s*(.+)$/im.exec(body)?.[1]?.trim() ?? ''
if (writer !== '' && !POLICY.writers.map((name) => String(name).toLowerCase()).includes(writer.toLowerCase())) {
  errors.push(`Written-by "${writer}" is not in .github/agent/review-policy.json`)
}

if (errors.length > 0) {
  console.error(`pr-lint: FAIL (#${prNumber})`)
  for (const error of errors) console.error(`- ${error}`)
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `pr-lint: FAIL (#${prNumber}) — ${errors.length} error(s); see the job log.\n`)
  }
  process.exit(1)
}

console.log(`pr-lint: ok (#${prNumber}, ${computed}, ${paths.length} files)`)
