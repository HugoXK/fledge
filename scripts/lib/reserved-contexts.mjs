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
// `ci-ok` has one workflow-file producer: `ci-ok-publish.yml` publishes the
// verdict from the default branch (#855). #1273 renamed the in-run aggregate in
// `ci.yml` to `ci-ok-head`, so the old entry no longer has to allow two files —
// and the scanner cannot see the third producer at all: `ci-ok-refresh.yml`
// posts a red `ci-ok` through the API from `scripts/ci-ok-refresh.mjs`, and this
// scanner reads job ids and job-level `name:` values, not API posts. That blind
// spot is written down beside the rule in `docs/code-standards.md`; the red it
// posts still blocks a merge.
//
// Line-based parsing, like `scripts/lib/workflow-injection.mjs`: the repository
// carries no YAML dependency. Two rules keep the line parser from skipping the
// shape it does not recognise (the bypass the first review of #963 found):
//
//  - the job indent is derived from the first key under `jobs:`, and one run's
//    property indent from its first property line, so a four-space `jobs:`
//    block is read as exactly that instead of producing no finding;
//  - a job-level `name:` that is not a plain literal — a backslash escape, a
//    block scalar, a tag, an anchor, a flow collection, an unquoted tab — is an
//    `unsupported` finding, because a value this parser cannot resolve could
//    still resolve to a reserved context in YAML. The same holds for a
//    `name:` with no value on its line (its value may be on the next line), a
//    job id that is not a plain or simple-quoted key, and a `jobs:` block
//    whose first line is not a job id.
//
// Dialect: the YAML GitHub Actions reads. Job ids are block-mapping keys; the
// check-run name is a scalar on the job's `name:` key.
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export const RESERVED_CONTEXTS = {
  'ci-ok': ['ci-ok-publish.yml'],
  'review-gate': ['review-gate.yml'],
  'pr-lint': ['pr-lint.yml'],
}

const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/
const PLAIN_KEY = /^([A-Za-z0-9_.-]+)(.*)$/
const DOUBLE_QUOTED_KEY = /^"((?:[^"\\]|\\.)*)"(.*)$/
const SINGLE_QUOTED_KEY = /^'((?:[^']|'')*)'(.*)$/

function unsupported(file, line, reason) {
  return { file, line, context: '', kind: 'unsupported', reason }
}

// The key and the text after its colon, for a line at a known indent. `ok:
// false` with a reason means the line is at a position where a key is required
// but YAML could read something this parser cannot: a quoted key with an
// escape, a tag, a list item, a merge key. A job id on the same line as its
// colon keeps its id as the key.
function readKey(body) {
  const quoted = DOUBLE_QUOTED_KEY.exec(body)
  if (quoted !== null) {
    if ((quoted[1] ?? '').includes('\\')) return { ok: false, reason: 'a quoted key with a backslash escape' }
    const rest = quoted[2] ?? ''
    if (!/^\s*:/.test(rest)) return { ok: false, reason: 'a quoted key without a colon' }
    return { ok: true, key: quoted[1] ?? '', rest: rest.replace(/^\s*:/, '') }
  }
  const single = SINGLE_QUOTED_KEY.exec(body)
  if (single !== null) {
    const rest = single[2] ?? ''
    if (!/^\s*:/.test(rest)) return { ok: false, reason: 'a quoted key without a colon' }
    return { ok: true, key: (single[1] ?? '').replace(/''/g, "'"), rest: rest.replace(/^\s*:/, '') }
  }
  if (/^[!&*%?]/.test(body) || body.startsWith('- ') || body.startsWith(': ') || body.startsWith('{') || body.startsWith('[')) {
    return { ok: false, reason: 'a YAML construct that is not a plain key' }
  }
  const plain = PLAIN_KEY.exec(body)
  if (plain === null) return { ok: false, reason: 'a line that is not a key' }
  const rest = plain[2] ?? ''
  if (!/^\s*:/.test(rest)) return { ok: false, reason: 'a line that is not a key' }
  return { ok: true, key: plain[1] ?? '', rest: rest.replace(/^\s*:/, '') }
}

// A scalar as YAML reads it into a check-run name, or a refusal. Plain and
// simple-quoted scalars are literal here; double-quoted scalars are not, because
// YAML resolves `"\u002d"` and every other escape, so the only safe reading of a
// backslash is "cannot tell". A block scalar, tag, anchor, alias or flow
// collection is refused for the same reason.
function readScalar(text) {
  const value = String(text ?? '').trim()
  // A job-level `name:` with nothing on its line is not a null name: YAML reads
  // an indented continuation as the scalar, so `name:` then `      ci-ok` is the
  // required context. Only a scalar written on this line can be proved.
  if (value === '' || value.startsWith('#')) {
    return { ok: false, reason: 'a name: with no value on its line (its value may be on the next line)' }
  }
  if (value.startsWith('"')) {
    let body = ''
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index]
      if (character === '\\') return { ok: false, reason: 'a double-quoted scalar with a backslash escape' }
      if (character === '"') {
        const rest = value.slice(index + 1).trim()
        if (rest !== '' && !rest.startsWith('#')) return { ok: false, reason: 'text after a quoted scalar' }
        return { ok: true, value: body }
      }
      body += character
    }
    return { ok: false, reason: 'an unterminated double-quoted scalar' }
  }
  if (value.startsWith("'")) {
    let body = ''
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index]
      if (character === "'") {
        if (value[index + 1] === "'") {
          body += "'"
          index += 1
          continue
        }
        const rest = value.slice(index + 1).trim()
        if (rest !== '' && !rest.startsWith('#')) return { ok: false, reason: 'text after a quoted scalar' }
        return { ok: true, value: body }
      }
      body += character
    }
    return { ok: false, reason: 'an unterminated single-quoted scalar' }
  }
  if (/^[|>]/.test(value)) return { ok: false, reason: 'a block scalar' }
  if (/^[!&*%?@`{]/.test(value) || value.startsWith('[')) return { ok: false, reason: 'a tag, anchor, alias or flow collection' }
  if (value.startsWith('- ')) return { ok: false, reason: 'a sequence item where a scalar is required' }
  const comment = /(^|\s)#/.exec(value)
  return { ok: true, value: (comment === null ? value : value.slice(0, comment.index)).trim() }
}

function findingsFor(file, line, context, table) {
  const allowed = table[context]
  if (allowed === undefined) return []
  if (allowed.includes(basename(file))) return []
  return [{ file, line, context }]
}

// A JSON-ish rendering of the scalar for the refusal line, so a reviewer can
// see what was refused without opening the file.
function shown(text) {
  const trimmed = String(text ?? '').trim()
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed
}

// Every finding in one workflow file: the job id and the job-level `name:`,
// each checked against the file allowed to publish that context, plus an
// `unsupported` finding for every line that could hide either.
export function scanWorkflowText(text, file, table = RESERVED_CONTEXTS) {
  const findings = []
  const lines = String(text).split(/\r?\n/)
  let inJobs = false
  let jobsSeen = false
  let jobsIndent = null // indent of a job id; derived from the first key under jobs:
  let propIndent = null // indent of the current job's property keys
  let currentJob = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const lineNumber = index + 1
    const indented = /^(\s*)/.exec(line)?.[1] ?? ''
    const body = line.slice(indented.length)
    const blank = body.trim() === ''
    const comment = body.trimStart().startsWith('#')

    if (!inJobs) {
      if (blank || comment) continue
      if (indented !== '') continue // not a top-level key; the workflow body starts at column 0
      if (body === '---' || body === '...') continue // a document marker publishes no check run
      const top = readKey(body)
      if (!top.ok) {
        // A top-level key this parser cannot resolve could still be `jobs`
        // written as `"jo\u0062s":`, so it is not skipped.
        findings.push(unsupported(file, lineNumber, `a top-level line that is not a plain key (${shown(body)})`))
        continue
      }
      if (top.key !== 'jobs') continue
      const inline = (top.rest ?? '').trim()
      if (inline !== '' && !inline.startsWith('#')) {
        findings.push(unsupported(file, lineNumber, `jobs: with an inline value (${shown(top.rest)})`))
        continue
      }
      if (jobsSeen) {
        findings.push(unsupported(file, lineNumber, 'a second jobs: block'))
        continue
      }
      jobsSeen = true
      inJobs = true
      jobsIndent = null
      propIndent = null
      currentJob = null
      continue
    }

    // Inside the jobs block.
    if (blank || comment) continue
    if (indented.includes('\t')) {
      findings.push(unsupported(file, lineNumber, 'tab indentation in the jobs block'))
      continue
    }
    const indent = indented.length

    if (indent === 0) {
      // The next top-level key ends the jobs block. A later `jobs:` is a
      // duplicate mapping key, which GitHub rejects and which this check
      // refuses rather than reading only the first block.
      inJobs = false
      jobsIndent = null
      propIndent = null
      currentJob = null
      const top = readKey(body)
      if (!top.ok) {
        if (body !== '---' && body !== '...') {
          findings.push(unsupported(file, lineNumber, `a top-level line that is not a plain key (${shown(body)})`))
        }
        continue
      }
      if (top.key !== 'jobs') continue
      const inline = (top.rest ?? '').trim()
      if (inline !== '' && !inline.startsWith('#')) {
        findings.push(unsupported(file, lineNumber, `jobs: with an inline value (${shown(top.rest)})`))
        continue
      }
      if (jobsSeen) {
        findings.push(unsupported(file, lineNumber, 'a second jobs: block'))
        continue
      }
      jobsSeen = true
      inJobs = true
      continue
    }

    if (jobsIndent === null) {
      // First content line under `jobs:`: it must be a job id, and its indent
      // is the indent every job id uses — even when the line is refused, so the
      // rest of the block is still read at the right depth.
      jobsIndent = indent
      const first = readKey(body)
      if (!first.ok) {
        findings.push(unsupported(file, lineNumber, `the first line under jobs: is not a job id: ${first.reason} (${shown(body)})`))
        continue
      }
      propIndent = null
      currentJob = first.key
      const value = (first.rest ?? '').trim()
      if (value !== '' && !value.startsWith('#')) {
        findings.push(unsupported(file, lineNumber, `job "${shown(first.key)}" with an inline value (${shown(first.rest)})`))
        continue
      }
      const key = first.key
      if (!JOB_ID.test(key)) {
        findings.push(unsupported(file, lineNumber, `job id "${shown(key)}" that is not a plain job id`))
        continue
      }
      findings.push(...findingsFor(file, lineNumber, key, table).map((finding) => ({ ...finding, kind: 'job-id' })))
      continue
    }

    if (indent < jobsIndent) {
      findings.push(unsupported(file, lineNumber, `an indent inside jobs: that matches no block (${shown(body)})`))
      continue
    }

    if (indent === jobsIndent) {
      const job = readKey(body)
      if (!job.ok) {
        findings.push(unsupported(file, lineNumber, `a line at the job indent that is not a job id: ${job.reason} (${shown(body)})`))
        continue
      }
      currentJob = job.key
      propIndent = null
      const value = (job.rest ?? '').trim()
      if (value !== '' && !value.startsWith('#')) {
        findings.push(unsupported(file, lineNumber, `job "${shown(job.key)}" with an inline value (${shown(job.rest)})`))
        continue
      }
      if (!JOB_ID.test(job.key)) {
        findings.push(unsupported(file, lineNumber, `job id "${shown(job.key)}" that is not a plain job id`))
        continue
      }
      findings.push(...findingsFor(file, lineNumber, job.key, table).map((finding) => ({ ...finding, kind: 'job-id' })))
      continue
    }

    // Inside a job. The first property line fixes this job's property indent;
    // anything deeper is a step or another nested block, whose `name:` is not
    // the check-run name.
    if (propIndent === null) {
      propIndent = indent
      const property = readKey(body)
      if (!property.ok) {
        findings.push(unsupported(file, lineNumber, `the first property of job "${shown(currentJob)}" is not a key: ${property.reason} (${shown(body)})`))
        continue
      }
      if (property.key === 'name') {
        const scalar = readScalar(property.rest)
        if (!scalar.ok) findings.push(unsupported(file, lineNumber, `the name: of job "${shown(currentJob)}" is ${scalar.reason}`))
        else findings.push(...findingsFor(file, lineNumber, scalar.value, table).map((finding) => ({ ...finding, kind: 'name' })))
      }
      continue
    }

    if (indent < propIndent) {
      findings.push(unsupported(file, lineNumber, `an indent inside job "${shown(currentJob)}" that is shallower than its properties (${shown(body)})`))
      continue
    }
    if (indent !== propIndent) continue // a nested block, e.g. a step; its name is not a check run

    const property = readKey(body)
    if (!property.ok) {
      findings.push(unsupported(file, lineNumber, `a property line of job "${shown(currentJob)}" is not a key: ${property.reason} (${shown(body)})`))
      continue
    }
    if (property.key !== 'name') continue
    const scalar = readScalar(property.rest)
    if (!scalar.ok) findings.push(unsupported(file, lineNumber, `the name: of job "${shown(currentJob)}" is ${scalar.reason}`))
    else findings.push(...findingsFor(file, lineNumber, scalar.value, table).map((finding) => ({ ...finding, kind: 'name' })))
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
