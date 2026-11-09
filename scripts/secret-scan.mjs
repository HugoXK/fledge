#!/usr/bin/env node
// Scans the files git tracks for things that look like real secrets.
//
//   npm run secret:scan
//   node scripts/secret-scan.mjs --root /tmp/fixture
//
// Two rules this file exists to keep:
//   * a hit prints `file:line`, the rule name, the first 4 characters and the
//     length — never the value, never the whole match;
//   * the whitelist names an exact file and line, never a directory, so a new
//     token in the same file still fails.
//
// A hit exits 1. A scan that cannot run (no git, unreadable whitelist) also
// exits 1. A tracked file the scan cannot read exits 2: the scope itself is
// incomplete, so the run must not report the same "clean" a full scan reports.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// The patterns from the issue, in one place so the test and the CLI cannot
// drift. `assignment` and `bearer` are the two broad ones: they catch the shape
// a leaked value usually takes in a config file or a copied request.
export const RULES = [
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'flybot-token', pattern: /\bflg_[A-Za-z0-9_-]{8,}/g },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack-token', pattern: /\bxox[baprs]-/g },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    name: 'assignment',
    pattern: /\b(?:GITHUB_TOKEN|GH_TOKEN|TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)\s*[:=]\s*["']?([A-Za-z0-9+/_=-]{16,})/g,
    valueGroup: 1,
  },
  { name: 'authorization-bearer', pattern: /\bauthorization:\s*bearer\s+(\S{16,})/gi, valueGroup: 1 },
]

export const ALLOWLIST_FILE = 'scripts/secret-scan-allowlist.json'

// `git ls-files` is the scope: an untracked draft or a file in .gitignore is not
// in the repository and cannot leak from it.
export function trackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter((entry) => entry !== '')
}

// A value that is an interpolation or a placeholder is not a secret: the code
// that builds a header from `${job.secret}` and the docs that write
// `<callbackSecret>` are doing the right thing. Without this the scanner reds on
// nine header constructions in this repository and is therefore ignored.
export function isPlaceholder(value) {
  return value.startsWith('${') || value.startsWith('$') || value.startsWith('<') || value.startsWith('{{')
}

export function isBinary(text) {
  return text.includes('\0')
}

export function scanText(text, file, allowlist) {
  const findings = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    for (const rule of RULES) {
      // `g` regexes keep state between calls; lastIndex has to be reset or a
      // second line silently skips its first match.
      rule.pattern.lastIndex = 0
      let match = rule.pattern.exec(line)
      while (match !== null) {
        const number = index + 1
        const value = rule.valueGroup === undefined ? match[0] : (match[rule.valueGroup] ?? '')
        if (rule.valueGroup !== undefined && isPlaceholder(value)) {
          match = rule.pattern.exec(line)
          continue
        }
        if (!allowlisted(file, number, allowlist)) {
          findings.push({
            file,
            line: number,
            rule: rule.name,
            prefix: match[0].slice(0, 4),
            length: match[0].length,
          })
        }
        match = rule.pattern.exec(line)
      }
    }
  }
  return findings
}

export function allowlisted(file, line, allowlist) {
  return allowlist.some((entry) => entry.file === file && entry.line === line)
}

export function loadAllowlist(root) {
  const raw = readFileSync(resolve(root, ALLOWLIST_FILE), 'utf8')
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error(`${ALLOWLIST_FILE} must be an array`)
  for (const entry of parsed) {
    if (typeof entry?.file !== 'string' || typeof entry?.line !== 'number' || typeof entry?.reason !== 'string') {
      throw new Error(`${ALLOWLIST_FILE}: every entry needs file, line and reason`)
    }
    if (entry.file.endsWith('/')) throw new Error(`${ALLOWLIST_FILE}: ${entry.file} is a directory; the whitelist is per line`)
  }
  return parsed
}

export function scan(root, allowlist) {
  const findings = []
  const skipped = []
  for (const file of trackedFiles(root)) {
    if (file === ALLOWLIST_FILE) continue
    let text
    try {
      text = readFileSync(resolve(root, file), 'utf8')
    } catch (error) {
      // A tracked file the scan cannot read is not "nothing to see": the scope
      // it was supposed to cover is unknown, so the caller must not report clean.
      skipped.push({ file, reason: error?.code ?? 'unreadable' })
      continue
    }
    if (isBinary(text)) continue
    findings.push(...scanText(text, file, allowlist))
  }
  return { findings, skipped }
}

function main() {
  const rootIndex = process.argv.indexOf('--root')
  const root = rootIndex === -1 ? process.cwd() : process.argv[rootIndex + 1]
  if (root === undefined) {
    console.error('secret:scan: --root needs a value')
    process.exit(1)
  }
  let allowlist
  let result
  try {
    allowlist = loadAllowlist(root)
    result = scan(root, allowlist)
  } catch (error) {
    console.error(`secret:scan: ${error.message}`)
    process.exit(1)
  }
  for (const item of result.findings) {
    // first 4 characters and the length are enough for a human to recognise a
    // hit; the value itself never reaches the log.
    console.error(`${item.file}:${String(item.line)}: ${item.rule} prefix=${item.prefix} length=${String(item.length)}`)
  }
  for (const item of result.skipped) {
    console.error(`secret:scan: could not read ${item.file} (${item.reason})`)
  }
  if (result.findings.length > 0) {
    console.error(`secret:scan: ${String(result.findings.length)} suspected value(s) in tracked files`)
    process.exit(1)
  }
  if (result.skipped.length > 0) {
    // Refused, not clean: exit 2 says "the scope was not fully scanned", which is
    // a different answer from "scanned, found nothing" and from "found a value".
    console.error(
      `secret:scan: refused — ${String(result.skipped.length)} tracked file(s) could not be scanned, so "no suspected value" cannot be claimed`,
    )
    process.exit(2)
  }
  console.log('secret:scan: no suspected value in the tracked files')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
