#!/usr/bin/env node
// Supply-chain gate 2b: no workflow expression is interpolated into a shell
// script.
//
// `actionlint` reads the YAML, the expressions and the shell syntax, but it does
// not do taint analysis: `${{ github.event.pull_request.title }}` inside a `run:`
// block is well-formed YAML, a well-formed expression and a well-formed shell
// line, and the title is written by whoever opened the pull request. The shell
// runs it (a `;`, a backtick, a `$(...)`), on a runner that holds the repository
// token.
//
// The rule here is the strict one: an expression inside a `run:` body is a
// finding unless the expression is named in the allowlist file with a reason.
// The safe spelling is an `env:` entry that the shell reads as "$VAR" — an env
// value is data, and the shell does not re-parse it.
//
// A reference this checker cannot see is out of scope, not green: a `uses:`
// `with:` value and a job-level `env:` are not shell scripts. The allowlist file
// is required to parse, so a missing or broken allowlist fails closed.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const ALLOWLIST_FILE = '.github/agent/workflow-injection-allowlist.json'

const RUN_KEY = /^(\s*)(?:-\s+)?run:\s*(.*)$/
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g

// Reads the `run:` bodies of one workflow file. Line numbers are absolute in the
// file, so a finding points at the line a reviewer has to open.
function runBodies(lines) {
  const bodies = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = RUN_KEY.exec(line)
    if (match === null) continue
    const indent = (match[1] ?? '').length
    const rest = (match[2] ?? '').trim()
    const inline = rest !== '' && !rest.startsWith('|') && !rest.startsWith('>')
    if (inline) {
      bodies.push({ text: rest, line: index + 1 })
      continue
    }
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const current = lines[cursor] ?? ''
      if (current.trim() === '') continue
      const currentIndent = current.length - current.trimStart().length
      if (currentIndent <= indent) break
      bodies.push({ text: current, line: cursor + 1 })
    }
  }
  return bodies
}

// Returns one finding per expression inside a `run:` body that the allowlist
// does not name. `allowlist` is the parsed array of `{ expression, reason }`.
export function scanWorkflowText(text, file, allowlist = []) {
  const allowed = new Set(allowlist.map((entry) => entry.expression))
  const findings = []
  for (const body of runBodies(text.split(/\r?\n/))) {
    for (const match of body.text.matchAll(EXPRESSION)) {
      const expression = (match[1] ?? '').trim()
      if (allowed.has(expression)) continue
      findings.push({ file, line: body.line, expression })
    }
  }
  return findings
}

// Parses the allowlist. A malformed entry throws: an allowlist that cannot be
// read must stop the run, not silently allow everything.
export function parseAllowlist(text) {
  const parsed = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error('allowlist must be a JSON array')
  return parsed.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('allowlist entry must be an object')
    const expression = entry.expression
    const reason = entry.reason
    if (typeof expression !== 'string' || expression === '') throw new Error('allowlist entry needs a non-empty expression')
    if (typeof reason !== 'string' || reason === '') throw new Error(`allowlist entry for ${expression} needs a reason`)
    return { expression, reason }
  })
}

export function readAllowlist(path = ALLOWLIST_FILE) {
  return parseAllowlist(readFileSync(path, 'utf8'))
}

export function scanWorkflows(directory, allowlist = []) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
  const findings = files.flatMap((name) =>
    scanWorkflowText(readFileSync(join(directory, name), 'utf8'), join(directory, name), allowlist),
  )
  return { findings, files }
}
