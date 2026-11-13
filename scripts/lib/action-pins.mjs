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

// Events a stranger cannot start here: each needs write access, an admin action
// or a schedule. The list is explicit rather than "anything the association map
// does not name", because an event nobody has classified must red the gate
// instead of passing as harmless — a new trigger type stays a finding until
// someone states here that an outside account cannot reach it.
const SAFE_EVENTS = new Set([
  'push',
  'schedule',
  'workflow_dispatch',
  'workflow_call',
  'workflow_run',
  'merge_group',
  'release',
  'create',
  'delete',
  'repository_dispatch',
  'deployment',
  'deployment_status',
  'page_build',
  'status',
  'registry_package',
  'branch_protection_rule',
  'public',
])

function indentOf(line) {
  return /^(\s*)/.exec(line)?.[1]?.length ?? 0
}

// The first line inside a block that carries content: blank and comment lines do
// not set the indentation, and they are not the block's end either.
function firstContentLine(lines, start) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() !== '' && !line.trim().startsWith('#')) return index
  }
  return -1
}

// A block mapping key, bare or quoted, with an optional trailing comment. YAML
// does not fix the indent, so callers take it from the file (below) rather than
// assuming two spaces: a file indented three or four spaces is the same file.
const MAPPING_KEY = /^([A-Za-z0-9_-]+|"[^"]+"|'[^']+')\s*:/

// Keys of a flow mapping (`{ pull_request_review: {}, push: {} }`), read at depth
// 1 so a nested `{…}` or `[…]` value is not split into keys. Returns null when an
// entry is not a `name:` pair, which the caller reports rather than guesses.
function flowMappingKeys(value) {
  const inner = value.slice(1, -1)
  const entries = []
  let current = ''
  let depth = 0
  for (const character of inner) {
    if (character === '{' || character === '[') depth += 1
    if (character === '}' || character === ']') depth -= 1
    if (character === ',' && depth === 0) {
      entries.push(current)
      current = ''
      continue
    }
    current += character
  }
  entries.push(current)
  const keys = []
  for (const entry of entries) {
    if (entry.trim() === '') continue
    const match = MAPPING_KEY.exec(entry.trim())
    if (match === null) return null
    keys.push(unquote(match[1] ?? ''))
  }
  return keys
}

// Returns the event names plus one problem per `on:` value the parser cannot
// read as an event list. A block mapping is read at the indentation its own
// first key uses, not at two spaces; a flow mapping is read key by key; a value
// that is neither is reported, because an empty event list would judge nothing
// and look like a pass.
function workflowEvents(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^on\s*:/.test(line))
  if (start === -1) return { events: [], problems: [{ line: 1, problem: 'missing-trigger-block' }] }
  const rest = (lines[start] ?? '').replace(/^on\s*:/, '').replace(/\s+#.*$/, '').trim()
  if (rest.startsWith('[')) {
    const events = rest.replace(/^\[|\]$/g, '').split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).filter((entry) => entry !== '')
    return { events, problems: [] }
  }
  if (rest.startsWith('{')) {
    const events = rest.endsWith('}') ? (flowMappingKeys(rest) ?? []) : []
    if (events.length === 0) return { events: [], problems: [{ line: start + 1, problem: `unparsed-on "${rest}"` }] }
    return { events, problems: [] }
  }
  if (rest !== '') return { events: [rest.replace(/^['"]|['"]$/g, '')], problems: [] }
  const first = firstContentLine(lines, start)
  if (first === -1) return { events: [], problems: [{ line: start + 1, problem: 'unparsed-on-entries' }] }
  const baseIndent = indentOf(lines[first] ?? '')
  if (baseIndent === 0) return { events: [], problems: [{ line: start + 1, problem: 'unparsed-on-entries' }] }
  const events = []
  const problems = []
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent < baseIndent) break
    // Deeper lines configure an event that is already listed (`types:`, `inputs:`).
    if (indent > baseIndent) continue
    const match = MAPPING_KEY.exec(line.trim())
    if (match === null) {
      problems.push({ line: index + 1, problem: 'unparsed-event-header' })
      continue
    }
    events.push(unquote(match[1] ?? ''))
  }
  if (events.length === 0) problems.push({ line: start + 1, problem: 'unparsed-on-entries' })
  return { events, problems }
}

// Splits the file into `jobs:` entries, keeping each job's own lines so a
// permission or an `if:` is read against the job it belongs to, never the file.
// The jobs' indentation is taken from the first key under `jobs:` — YAML does not
// fix it at two spaces, and a whole file must not be exempt just because its job
// block is indented differently. A header with a trailing comment is still a
// header, and a line at the jobs' own indentation that does not parse is
// reported: a quoted key or a shape this regex does not cover must red the gate
// rather than exempt the job it names.
const JOB_HEADER = /^([A-Za-z0-9_-]+)\s*:\s*(?:#.*)?$/

function jobBlocks(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^jobs\s*:/.test(line))
  if (start === -1) return { jobs: [], problems: [{ line: 1, text: 'jobs', problem: 'missing-jobs-block' }] }
  const rest = (lines[start] ?? '').replace(/^jobs\s*:/, '').replace(/\s+#.*$/, '').trim()
  if (rest !== '') return { jobs: [], problems: [{ line: start + 1, text: rest, problem: 'unparsed-jobs-value' }] }
  const first = firstContentLine(lines, start)
  // An empty `jobs:` map and one whose first content line is a top-level key are
  // both a shape this parser cannot read; reporting zero jobs would look clean.
  if (first === -1 || indentOf(lines[first] ?? '') === 0) {
    return { jobs: [], problems: [{ line: start + 1, text: 'jobs', problem: 'unparsed-jobs-block' }] }
  }
  const baseIndent = indentOf(lines[first] ?? '')
  const jobs = []
  const problems = []
  let current = null
  for (let index = first; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent < baseIndent) break
    if (indent > baseIndent) {
      if (current !== null) current.lines.push(line)
      continue
    }
    const header = JOB_HEADER.exec(line.trim())
    if (header !== null) {
      current = { name: header[1], line: index + 1, lines: [] }
      jobs.push(current)
      continue
    }
    // A key we cannot read may still own the lines below it, so they must not be
    // handed to the previous job and judged under its permissions.
    problems.push({ line: index + 1, text: line.trim(), problem: 'unparsed-job-header' })
    current = null
  }
  return { jobs, problems }
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

// One `permissions:` value, in any of the forms YAML allows. The rule the gate
// enforces is "fails closed": a form the parser does not understand counts as
// holding `actions: write` and is reported, because skipping it would exempt the
// job (or the whole file) from the check it exists for. `write-all` grants every
// scope; an inline `{ actions: write }` and the usual block mapping are parsed;
// `read-all`, `none` and `{}` grant nothing.
const PERMISSIONS_LINE = /^\s*permissions\s*:\s*(.*)$/
const PERMISSIONS_ENTRY = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/

function permissionsFacts(lines, index) {
  const line = lines[index] ?? ''
  const match = PERMISSIONS_LINE.exec(line)
  const rest = (match?.[1] ?? '').replace(/\s+#.*$/, '').trim()
  const baseIndent = /^(\s*)/.exec(line)?.[1]?.length ?? 0
  const facts = { grantsActions: false, problem: null }
  const unparsed = (value) => {
    facts.grantsActions = true
    facts.problem = `unparsed permissions value "${value}"`
    return facts
  }
  if (rest !== '') {
    const value = unquote(rest)
    if (value === 'write-all') {
      facts.grantsActions = true
      return facts
    }
    if (value === 'read-all' || value === 'none' || value === '{}') return facts
    if (value.startsWith('{') && value.endsWith('}')) {
      const entries = value.slice(1, -1).split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
      for (const entry of entries) {
        const pair = PERMISSIONS_ENTRY.exec(entry)
        if (pair === null) return unparsed(entry)
        if (pair[1] === 'actions' && unquote(pair[2].trim()) === 'write') facts.grantsActions = true
      }
      return facts
    }
    return unparsed(value)
  }
  for (let next = index + 1; next < lines.length; next += 1) {
    const entry = lines[next] ?? ''
    const indent = /^(\s*)/.exec(entry)?.[1]?.length ?? 0
    if (entry.trim() !== '' && indent <= baseIndent) break
    const text = entry.replace(/\s+#.*$/, '').trim()
    if (text === '') continue
    const pair = PERMISSIONS_ENTRY.exec(text)
    if (pair === null) return unparsed(text)
    if (pair[1] === 'actions' && unquote(pair[2].trim()) === 'write') facts.grantsActions = true
  }
  return facts
}

// A workflow-level `permissions:` block applies to every job that does not
// declare its own, so it widens the whole file in one line and the scan must
// read it before deciding a job is unprivileged.
function workflowPermissionsFacts(text) {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (!/^permissions\s*:/.test(line)) continue
    return { ...permissionsFacts(lines, index), line: index + 1 }
  }
  return { grantsActions: false, problem: null, line: 0 }
}

function jobFacts(job) {
  let condition = null
  let actionsWrite = false
  let permissionsLine = 0
  let declaresPermissions = false
  let problem = null
  for (let index = 0; index < job.lines.length; index += 1) {
    const line = job.lines[index] ?? ''
    if (condition === null && /^\s*if\s*:/.test(line)) condition = foldedValue(job.lines, index)
    if (/^\s*permissions\s*:/.test(line)) {
      declaresPermissions = true
      const parsed = permissionsFacts(job.lines, index)
      if (parsed.grantsActions) actionsWrite = true
      if (parsed.problem !== null && problem === null) {
        problem = parsed.problem
        permissionsLine = job.line + index + 1
      }
    }
  }
  return { condition: condition ?? '', actionsWrite, declaresPermissions, permissionsLine, problem }
}

function associationGate(condition, expression) {
  if (!condition.includes(expression)) return false
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const call = new RegExp(`contains\\(\\s*fromJSON\\(\\s*'([^']*)'\\s*\\)\\s*,\\s*${escaped}\\s*\\)`)
  const match = call.exec(condition)
  if (match === null) return false
  // The list must be exactly the three roles: containing them somewhere admits
  // every extra role the list also names (`FIRST_TIME_CONTRIBUTOR`), and a
  // substring test lets `COLLABORATOR_X` pass as `COLLABORATOR`.
  const roles = new Set(
    String(match[1] ?? '')
      .split(',')
      // Each entry arrives as `["OWNER"` / `"MEMBER"` / `"COLLABORATOR"]`; strip
      // the JSON brackets and quotes, then compare the whole name.
      .map((role) => role.replace(/^[\s["']+|[\s\]"']+$/g, '').toUpperCase())
      .filter((role) => role !== ''),
  )
  return roles.size === ASSOCIATION_ROLES.length && ASSOCIATION_ROLES.every((role) => roles.has(role))
}

// Returns one finding per privileged job that a stranger could start on an event
// whose association it never tests, plus one per job, `on:` value or
// `permissions:` value the parser could not read. A job whose `if:` names its
// events is judged on those; one that names none can run on every trigger the
// workflow has. A job inherits a workflow-level block it does not override. An
// event the checker cannot classify fails closed: silence there would make the
// gate's contract ("a shape I do not know is a finding") false.
export function checkActorGates(text, file) {
  const { events: triggers, problems: triggerProblems } = workflowEvents(text)
  const workflowScope = workflowPermissionsFacts(text)
  const { jobs, problems } = jobBlocks(text)
  const findings = problems.map((problem) => ({ file, line: problem.line, job: '', event: '', problem: problem.problem }))
  for (const problem of triggerProblems) {
    findings.push({ file, line: problem.line, job: '(workflow)', event: '', problem: problem.problem })
  }
  if (workflowScope.problem !== null) {
    findings.push({ file, line: workflowScope.line, job: '(workflow)', event: '', problem: workflowScope.problem })
  }
  for (const job of jobs) {
    const facts = jobFacts(job)
    if (facts.problem !== null) {
      findings.push({ file, line: facts.permissionsLine, job: String(job.name), event: '', problem: facts.problem })
    }
    const privileged = facts.actionsWrite || (!facts.declaresPermissions && workflowScope.grantsActions)
    if (!privileged) continue
    // A privileged job whose triggers could not be read cannot be cleared: an
    // empty reachable set would judge nothing and look like a pass.
    if (triggers.length === 0) {
      findings.push({ file, line: job.line, job: String(job.name), event: '', problem: 'no-readable-trigger' })
      continue
    }
    const named = triggers.filter((event) => facts.condition.includes(`'${event}'`) || facts.condition.includes(`"${event}"`))
    const reachable = named.length > 0 ? named : triggers
    for (const event of reachable) {
      const expression = STRANGER_EVENT_ASSOCIATION[event]
      if (expression === undefined) {
        if (SAFE_EVENTS.has(event)) continue
        findings.push({ file, line: job.line, job: String(job.name), event, problem: 'unknown-event' })
        continue
      }
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
    const workflowScope = workflowPermissionsFacts(text)
    for (const job of jobBlocks(text).jobs) {
      const facts = jobFacts(job)
      if (facts.actionsWrite || (!facts.declaresPermissions && workflowScope.grantsActions)) checked += 1
    }
  }
  return { findings, checked, files }
}
