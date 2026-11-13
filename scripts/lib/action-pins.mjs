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

// ---------------------------------------------------------------------------
// Supply-chain gate 1b: a job that holds `actions: write` must refuse to start
// for a stranger on every event a stranger can trigger.
//
// `actions: write` is what re-running a workflow costs, and it is the widest
// permission any workflow here needs. A stranger-reachable event
// (`pull_request_review`, `issue_comment`, `pull_request_target`) runs for any
// signed-in account, so a job on one of those that does not test
// `author_association` lets an arbitrary account spawn runs on someone else's
// pull request. The expression differs per event — the association lives on the
// review object for a review, on the comment for a comment, on the pull request
// for `pull_request_target` — so the checker maps the event to the expression
// rather than accepting one hardcoded string.
export const STRANGER_EVENT_ASSOCIATION = {
  pull_request_review: 'github.event.review.author_association',
  pull_request_target: 'github.event.pull_request.author_association',
  pull_request: 'github.event.pull_request.author_association',
  issue_comment: 'github.event.comment.author_association',
  discussion_comment: 'github.event.comment.author_association',
}

const ASSOCIATION_ROLES = ['OWNER', 'MEMBER', 'COLLABORATOR']

function workflowEvents(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^on\s*:/.test(line))
  if (start === -1) return []
  const rest = (lines[start] ?? '').replace(/^on\s*:/, '').replace(/(^|\s)#.*$/, '').trim()
  if (rest.startsWith('[')) {
    return rest.replace(/^\[|\]$/g, '').split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).filter((entry) => entry !== '')
  }
  if (rest !== '') return [rest.replace(/^['"]|['"]$/g, '')]
  const events = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) break
    const match = /^\s{2}([A-Za-z0-9_-]+)\s*:/.exec(line)
    if (match !== null) events.push(match[1])
  }
  return events
}

// Splits the file into `jobs:` entries, keeping each job's own lines so a
// permission or an `if:` is read against the job it belongs to, never the file.
function jobBlocks(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^jobs\s*:/.test(line))
  if (start === -1) return []
  const jobs = []
  let current = null
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (/^\S/.test(line) && line.trim() !== '' && !line.trim().startsWith('#')) break
    const header = /^ {2}([A-Za-z0-9_-]+)\s*:\s*$/.exec(line)
    if (header !== null) {
      current = { name: header[1], line: index + 1, lines: [] }
      jobs.push(current)
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  return jobs
}

// Reads a block value that starts at `if:` and may continue on folded lines.
function foldedValue(lines, index) {
  const first = (lines[index] ?? '').replace(/^\s*if\s*:\s*/, '').replace(/(^|\s)#.*$/, '')
  if (!/^[|>]/.test(first.trim())) return first
  const baseIndent = /^(\s*)/.exec(lines[index] ?? '')?.[1]?.length ?? 0
  const parts = []
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next] ?? ''
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0
    if (line.trim() !== '' && indent <= baseIndent) break
    parts.push(line)
  }
  return parts.join(' ')
}

function jobFacts(job) {
  let condition = null
  let actionsWrite = false
  let permissionsLine = 0
  for (let index = 0; index < job.lines.length; index += 1) {
    const line = job.lines[index] ?? ''
    if (condition === null && /^\s*if\s*:/.test(line)) condition = foldedValue(job.lines, index)
    if (/^\s*permissions\s*:\s*$/.test(line)) {
      const baseIndent = /^(\s*)/.exec(line)?.[1]?.length ?? 0
      for (let next = index + 1; next < job.lines.length; next += 1) {
        const entry = job.lines[next] ?? ''
        const indent = /^(\s*)/.exec(entry)?.[1]?.length ?? 0
        if (entry.trim() !== '' && indent <= baseIndent) break
        if (/^\s*actions\s*:\s*write\b/.test(entry)) {
          actionsWrite = true
          permissionsLine = job.line + next + 1
        }
      }
    }
  }
  return { condition: condition ?? '', actionsWrite, permissionsLine }
}

function associationGate(condition, expression) {
  if (!condition.includes(expression)) return false
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const call = new RegExp(`contains\\(\\s*fromJSON\\(\\s*'([^']*)'\\s*\\)\\s*,\\s*${escaped}\\s*\\)`)
  const match = call.exec(condition)
  if (match === null) return false
  const roles = String(match[1] ?? '').toUpperCase()
  return ASSOCIATION_ROLES.every((role) => roles.includes(role))
}

// Returns one finding per privileged job that a stranger could start on an event
// whose association it never tests. A job whose `if:` names its events is judged
// on those; one that names none can run on every trigger the workflow has.
export function checkActorGates(text, file) {
  const triggers = workflowEvents(text)
  const findings = []
  for (const job of jobBlocks(text)) {
    const facts = jobFacts(job)
    if (!facts.actionsWrite) continue
    const named = triggers.filter((event) => facts.condition.includes(`'${event}'`) || facts.condition.includes(`"${event}"`))
    const reachable = named.length > 0 ? named : triggers
    for (const event of reachable) {
      const expression = STRANGER_EVENT_ASSOCIATION[event]
      if (expression === undefined) continue
      if (associationGate(facts.condition, expression)) continue
      findings.push({
        file,
        line: job.line,
        job: String(job.name),
        event,
        problem: 'missing-association-gate',
      })
    }
  }
  return findings
}

// Same scan shape as `scanWorkflows`: every workflow file directly under `dir`,
// with `checked` counting the privileged jobs so an empty run cannot look like a
// clean one.
export function scanActorGates(dir) {
  const findings = []
  const files = []
  let checked = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue
    const file = join(dir, entry.name)
    files.push(file)
    const text = readFileSync(file, 'utf8')
    findings.push(...checkActorGates(text, file))
    for (const job of jobBlocks(text)) {
      if (jobFacts(job).actionsWrite) checked += 1
    }
  }
  return { findings, checked, files }
}
