#!/usr/bin/env node
// #963: a check run's name is the job id, or the job's `name:` when it has one.
// Branch protection matches that string plus the GitHub Actions app id, so a
// pull request can add any workflow file whose job is called `ci-ok` and
// publish the *required* context from its own tree. Nothing in the tree
// rejected that name, and the aggregate (`scripts/ci-ok.mjs`) reads only the
// `needs` object of the run it executes inside, so the second check run was
// invisible to every gate.
//
// This scanner is the missing check: for each workflow file it reads every job
// id and every job-level `name:`, and a reserved context may only come from the
// file that is allowed to produce it. The split matters — the scanner is policy
// and runs from the base tree, while the workflows are the diff under test and
// come from the head, which is why the CLI takes a directory argument.
//
// `ci-ok` has two canonical producers on purpose: `ci-ok-publish.yml` publishes
// the verdict from the default branch (#855) and the in-run aggregate inside
// `ci.yml` keeps publishing the same context until the documented follow-up
// renames it to `ci-ok-head`. A table that allowed only one of them would judge
// the honest tree red.
//
// Line-based parsing, like `scripts/lib/workflow-injection.mjs`: the repository
// carries no YAML dependency, and the shape this needs is a `jobs:` block, its
// two-space job ids and their four-space `name:` lines.
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export const RESERVED_CONTEXTS = {
  'ci-ok': ['ci.yml', 'ci-ok-publish.yml'],
  'review-gate': ['review-gate.yml'],
  'pr-lint': ['pr-lint.yml'],
}

const JOBS_KEY = /^jobs:\s*(?:#.*)?$/
const TOP_LEVEL_KEY = /^[^\s#]/
const JOB_ID = /^ {2}([A-Za-z0-9_.-]+|"[^"]*"|'[^']*'):\s*(?:#.*)?$/
const JOB_NAME = /^ {4}name:\s*(.*)$/

// A scalar as YAML would read it for this purpose: the text before a trailing
// comment, with a matching pair of quotes removed.
function scalar(text) {
  let value = String(text ?? '').trim()
  const comment = /(^|\s)#/.exec(value)
  if (comment !== null) value = value.slice(0, comment.index).trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1)
  }
  return value
}

function findingsFor(file, line, context, table) {
  const allowed = table[context]
  if (allowed === undefined) return []
  if (allowed.includes(basename(file))) return []
  return [{ file, line, context }]
}

// Every finding in one workflow file: the job id and the job-level `name:`,
// each checked against the file allowed to publish that context. A `name:`
// above `jobs:` (the workflow's own name) and step-level names are not check
// run names, so only the two positions YAML gives a job are read.
export function scanWorkflowText(text, file, table = RESERVED_CONTEXTS) {
  const findings = []
  const lines = String(text).split(/\r?\n/)
  let inJobs = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!inJobs) {
      if (JOBS_KEY.test(line)) inJobs = true
      continue
    }
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    // The next top-level key ends the jobs block: a later `name:` there is
    // metadata, not a check run.
    if (TOP_LEVEL_KEY.test(line)) break
    const jobId = JOB_ID.exec(line)
    if (jobId !== null) {
      const context = scalar(jobId[1] ?? '')
      findings.push(...findingsFor(file, index + 1, context, table).map((finding) => ({ ...finding, kind: 'job-id' })))
      continue
    }
    const name = JOB_NAME.exec(line)
    if (name !== null) {
      const context = scalar(name[1] ?? '')
      findings.push(...findingsFor(file, index + 1, context, table).map((finding) => ({ ...finding, kind: 'name' })))
    }
  }
  return findings
}

// Reads every workflow file in the directory. An unreadable file throws: a file
// the check could not read is not a file it may pass.
export function scanWorkflows(directory, table = RESERVED_CONTEXTS) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
  const findings = files.flatMap((name) => scanWorkflowText(readFileSync(join(directory, name), 'utf8'), join(directory, name), table))
  return { findings, files }
}
