#!/usr/bin/env node
// Supply-chain gate 1: every action a workflow runs must be pinned to a 40-hex
// commit, with the tag it came from in a trailing comment.
//
// A floating tag (`@v4`) is a mutable pointer: the action's owner can move it to
// new code whenever they like, and it runs on our runner with our token and our
// secrets without a commit here, a review, or a diff anyone can see. The trailing
// comment is required because it is what makes a re-pin a one-line, reviewable
// edit (`@<sha> # v4.4.0`) instead of an opaque sha swap nobody can check.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const USES_LINE = /^(\s*(?:-\s*)?uses:\s*)(\S+)(.*)$/
const PINNED = /^[^\s@]+@[0-9a-f]{40}$/
const TAG_COMMENT = /(^|\s)#\s*\S+/

// A local action (`./path`) is a file in this repository and is reviewed like
// any other file; a `docker://` reference is pinned by digest at the call site
// and is not an action at all. Both are out of scope for this gate, and the
// scanner says so rather than counting them as pinned.
function outOfScope(value) {
  return value.startsWith('./') || value.startsWith('docker://')
}

function unquote(value) {
  const quoted = /^(['"])(.*)\1$/.exec(value)
  return quoted === null ? value : (quoted[2] ?? value)
}

function referenceOf(line) {
  const match = USES_LINE.exec(line)
  if (match === null) return null
  return { value: unquote(match[2] ?? ''), rest: match[3] ?? '' }
}

// Returns one finding per `uses:` that is not a full-sha pin with a tag comment.
// `file` is carried through so a caller scanning a tree can name the file.
export function checkWorkflow(text, file) {
  const findings = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const reference = referenceOf(lines[index] ?? '')
    if (reference === null || outOfScope(reference.value)) continue
    if (!PINNED.test(reference.value)) {
      findings.push({ file, line: index + 1, value: reference.value, problem: 'not-pinned' })
      continue
    }
    if (!TAG_COMMENT.test(` ${reference.rest}`)) {
      findings.push({ file, line: index + 1, value: reference.value, problem: 'missing-tag-comment' })
    }
  }
  return findings
}

// Scans every *.yml / *.yaml directly under `dir`. `checked` counts the action
// references in scope, so a run that found nothing to check cannot look the same
// as a run where everything passed.
export function scanWorkflows(dir) {
  const findings = []
  const files = []
  let checked = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue
    const file = join(dir, entry.name)
    files.push(file)
    const text = readFileSync(file, 'utf8')
    findings.push(...checkWorkflow(text, file))
    for (const line of text.split(/\r?\n/)) {
      const reference = referenceOf(line)
      if (reference !== null && !outOfScope(reference.value)) checked += 1
    }
  }
  return { findings, checked, files }
}
