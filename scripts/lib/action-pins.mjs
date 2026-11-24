#!/usr/bin/env node
// Supply-chain gate 1: every action a workflow runs must be pinned to a 40-hex
// commit, with the tag it came from in a trailing comment.
//
// A floating tag (`@v4`) is a mutable pointer: the action's owner can move it to
// new code whenever they like, and it runs on our runner with our token and our
// secrets without a commit here, a review, or a diff anyone can see. The trailing
// comment is required because it is what makes a re-pin a one-line, reviewable
// edit (`@<sha> # v4.4.0`) instead of an opaque sha swap nobody can check.
//
// Gate 1a, #650: a pin stops a tag from moving; it says nothing about who wrote
// the action. A pull request can add any third-party action pinned to any commit
// it likes, and that commit runs with this repository's token. So the second
// half of the rule is a list: only the actions this project has reviewed are
// allowed, and the list is data in the tree (`ALLOWLIST_FILE`) so widening it is
// a reviewed one-line diff instead of something a pull request grants itself.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USES_LINE = /^(\s*(?:-\s*)?uses:\s*)(\S+)(.*)$/
const PINNED = /^[^\s@]+@[0-9a-f]{40}$/
const TAG_COMMENT = /(^|\s)#\s*\S+/

// The list lives with the other machine-read policy files. `owner/repo` only:
// a wildcard would re-open exactly the hole the list closes, so `actions/*` is
// rejected as malformed rather than read as "any action under that owner".
export const ALLOWLIST_FILE = '.github/agent/action-allowlist.json'
const ACTION_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// #1206, ADR 0027: an action may be pre-approved in one reviewed change and used
// in the next. The exemption is data — `name`, `issue`, `expires_at` — so granting
// it is a one-line reviewed diff, and a release version bounds it: the release
// pull request that reaches `expires_at` is where a person has to decide, so a
// lapse lands in front of a human instead of on a date nobody scheduled.
const RELEASE_VERSION = /^(\d+)\.(\d+)\.0$/
// A checkout is any released tree, including the patch releases the daily cadence
// produces (ADR 0008 bumps the patch on every day but the week's first). Its bound
// is the minor it belongs to: `0.5.1` is bounded as `0.5.0`.
const TREE_VERSION = /^(\d+)\.(\d+)(?:\.\d+)?$/
const APPROVED_UNUSED_FIELDS = 'expires_at,issue,name'

// Resolved from this file, never from the working directory: the checker runs
// from the base checkout, so the list it reads is the one already reviewed on
// the base branch. A pull request therefore cannot widen the list for itself in
// the same commit that uses a new action — the entry has to land first.
export function defaultAllowlistPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', ALLOWLIST_FILE)
}

// Throws on a malformed file instead of returning an empty list: a gate that
// silently allows everything when its data is unreadable is worse than no gate.
export function readAllowlist(path = defaultAllowlistPath()) {
  return readAllowlistFile(path).allowed_actions
}

// The same file, both halves. `allowed_actions` is what admits an action;
// `approved_unused` names actions this project has pre-approved for a follow-up
// change that no workflow uses yet. The exemption is validated like the list it
// sits beside — an unvalidated exemption would be the one soft spot in the gate.
export function readAllowlistFile(path = defaultAllowlistPath()) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path}: the allowlist must be a JSON file (${error.message})`)
  }
  const list = parsed?.allowed_actions
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${path}: allowed_actions must be a non-empty array of owner/repo names`)
  }
  for (const entry of list) {
    if (typeof entry !== 'string' || !ACTION_REPOSITORY.test(entry)) {
      throw new Error(`${path}: ${JSON.stringify(entry)} is not an exact owner/repo name (wildcards are not allowed)`)
    }
  }
  const duplicates = list.filter((entry, index) => list.indexOf(entry) !== index)
  if (duplicates.length > 0) {
    throw new Error(`${path}: ${duplicates.join(', ')} appears more than once`)
  }
  return { allowed_actions: list, approved_unused: readApprovedUnused(parsed?.approved_unused, list, path) }
}

// A missing key is an empty one: every tree that predates this rule keeps working,
// and the first exemption is the change that writes the key.
function readApprovedUnused(value, allowedActions, path) {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new Error(`${path}: approved_unused must be an array of {name, issue, expires_at} entries`)
  }
  const allowed = new Set(allowedActions.map((entry) => entry.toLowerCase()))
  const approved = []
  const seen = new Set()
  value.forEach((entry, index) => {
    const problem = approvedUnusedProblem(entry, allowed, path, index)
    if (problem !== null) throw new Error(problem)
    const key = entry.name.toLowerCase()
    if (seen.has(key)) throw new Error(`${path}: ${entry.name} appears more than once in approved_unused`)
    seen.add(key)
    approved.push({ name: entry.name, issue: entry.issue, expires_at: entry.expires_at })
  })
  return approved
}

// An entry is exactly three fields, because a field the reader ignores is a field
// a reviewer may believe was checked. `name` has to be on the list it sits beside:
// an exemption for an action the gate still refuses pre-approves nothing.
function approvedUnusedProblem(entry, allowed, path, index) {
  const where = `${path}: approved_unused[${index}]`
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${where} must be an object with exactly name, issue and expires_at`
  }
  const fields = APPROVED_UNUSED_FIELDS.split(',')
  const extra = Object.keys(entry).filter((key) => !fields.includes(key))
  if (extra.length > 0) {
    return `${where}: ${extra.join(', ')} is not a field of an entry (exactly name, issue and expires_at)`
  }
  const missing = fields.filter((key) => !(key in entry))
  if (missing.length > 0) return `${where} is missing ${missing.join(', ')}`
  if (typeof entry.name !== 'string' || !ACTION_REPOSITORY.test(entry.name)) {
    return `${where}: ${JSON.stringify(entry.name)} is not an exact owner/repo name (wildcards are not allowed)`
  }
  if (!allowed.has(entry.name.toLowerCase())) {
    return `${where}: ${entry.name} is not in allowed_actions, so the exemption would pre-approve an action the gate still refuses`
  }
  if (!Number.isInteger(entry.issue) || entry.issue <= 0) {
    return `${where}.issue must be the number of the issue that pre-approved it`
  }
  if (typeof entry.expires_at !== 'string' || !RELEASE_VERSION.test(entry.expires_at)) {
    return `${where}.expires_at must be a minor release version (x.y.0); there is no "no expiry" value`
  }
  return null
}

function releaseVersion(value) {
  const match = RELEASE_VERSION.exec(String(value))
  if (match === null) return null
  return Number(match[1]) * 1000 + Number(match[2])
}

// The minor a checkout belongs to, whatever its patch. A tree that is not a
// version at all cannot bound anything, and the caller says so instead of guessing.
function treeMinor(value) {
  const match = TREE_VERSION.exec(String(value))
  if (match === null) return null
  return Number(match[1]) * 1000 + Number(match[2])
}

// The bound, as failures rather than prose. Equality fails deliberately: the
// release pull request that bumps the tree to `expires_at` is exactly the moment a
// person has to delete or renew the entry, so that pull request cannot go green
// while the exemption is still there. An expiry more than two minors ahead would
// outlive the review that justified it, and one minor would lapse before a single
// release could carry the follow-up.
export function approvedUnusedExpiryProblems(entries, version, path = ALLOWLIST_FILE) {
  // With no entries there is nothing to bound, so a tree that is not a release has
  // no problem to report. Failing here would red every patch release (ADR 0008 bumps
  // the patch on all but the week's first day) over an empty list the project ships,
  // which is how a check gets deleted instead of read.
  if (entries.length === 0) return []
  const current = treeMinor(version)
  if (current === null) {
    return [`${path}: ${JSON.stringify(version)} is not a release version (x.y.z), so no exemption can be bounded against it`]
  }
  const problems = []
  for (const entry of entries) {
    const expires = releaseVersion(entry.expires_at)
    if (expires === null) {
      problems.push(`${path}: ${entry.name} (#${entry.issue}) has expires_at ${JSON.stringify(entry.expires_at)}, which is not a minor release version (x.y.0)`)
      continue
    }
    const moves = `Delete the entry, or renew it with a new expires_at and a comment on #${entry.issue} saying why the pre-approval still stands`
    if (current >= expires) {
      problems.push(`${path}: ${entry.name} was pre-approved on #${entry.issue} and expires at ${entry.expires_at}; this tree is ${version}. ${moves}.`)
      continue
    }
    if (expires - current > 2) {
      problems.push(`${path}: ${entry.name} is pre-approved until ${entry.expires_at} (#${entry.issue}), more than two minors beyond this tree's ${version}; the bound may not outlive the review that justified it. ${moves}.`)
    }
  }
  return problems
}

// `github/codeql-action/init@<sha>` belongs to `github/codeql-action`: the
// allowlist names repositories, and a sub-path is part of the repository it
// lives in rather than a separate entry someone could forget to classify.
export function repositoryOf(value) {
  const at = value.indexOf('@')
  const path = at === -1 ? value : value.slice(0, at)
  const segments = path.split('/')
  if (segments.length < 2) return path
  return `${segments[0]}/${segments[1]}`
}

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
// `allowlist` is the reviewed `owner/repo` list; omitting it skips gate 1a, which
// the CLI never does — it always passes what it read, so a caller that forgets
// the list cannot make the gate look green.
export function checkWorkflow(text, file, allowlist) {
  const allow = allowlist === undefined ? null : new Set(allowlist.map((entry) => entry.toLowerCase()))
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
    // Checked even when the reference is otherwise malformed, so a workflow that
    // adds an unreviewed action is told about the action as well as the pin.
    if (allow !== null && !allow.has(repositoryOf(reference.value).toLowerCase())) {
      findings.push({ file, line: index + 1, value: reference.value, problem: 'not-allowed' })
    }
  }
  return findings
}

// Scans every *.yml / *.yaml directly under `dir`. `checked` counts the action
// references in scope, so a run that found nothing to check cannot look the same
// as a run where everything passed.
export function scanWorkflows(dir, allowlist) {
  const findings = []
  const files = []
  let checked = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue
    const file = join(dir, entry.name)
    files.push(file)
    const text = readFileSync(file, 'utf8')
    findings.push(...checkWorkflow(text, file, allowlist))
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

// #1169: `workflow_run` is in that list for the run it *waits for* — settling a
// run here needs write access — but the event itself is reachable from a fork's
// pull request: a fork's lint run completes and wakes this workflow with
// `head_repository` = the fork. A job holding `actions: write` on it could then
// POST a re-run against this repository on someone else's branch, so the event is
// safe for a privileged job only when the job names this repository as the head.
// It is the one SAFE_EVENTS entry with a per-job guard, and the guard is a
// comparison rather than an association list because no account is involved: the
// fork's own commit is what must be refused.
const WORKFLOW_RUN_HEAD_REPOSITORY = 'github.event.workflow_run.head_repository.full_name == github.repository'

function headRepositoryGate(condition) {
  // The `if:` may be written as a folded block, so the comparison is looked for
  // after collapsing whitespace; the exact field and the exact comparison are
  // still required, because `...repository.full_name` is a different fact.
  return condition.replace(/\s+/g, ' ').includes(WORKFLOW_RUN_HEAD_REPOSITORY)
}

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

// A job names its events through `github.event_name`; every other quoted word in
// an `if:` is some payload field's value. `github.event.workflow_run.event ==
// 'pull_request'` is the one that matters here: it names a property of the
// finished run, not the event that started this job, so a substring test read it
// as the job serving `pull_request` and demanded an association gate for a
// trigger the job cannot see (#1169). Both `==` and `!=` count, because a `!=`
// still says which event the job is about.
function eventNameTest(condition, event) {
  const quoted = `['"]${event.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`
  return new RegExp(`github\\.event_name\\s*[!=]=\\s*${quoted}`).test(condition)
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
    const named = triggers.filter((event) => eventNameTest(facts.condition, event))
    const reachable = named.length > 0 ? named : triggers
    for (const event of reachable) {
      const expression = STRANGER_EVENT_ASSOCIATION[event]
      if (expression === undefined) {
        if (SAFE_EVENTS.has(event)) {
          // A finished run is the one safe event a job has to narrow itself: the
          // run behind it may belong to a fork, so a privileged job must name this
          // repository as the head. Absent, the fork's completion would drive the
          // write; the finding is reported per job, like an association gate.
          if (event === 'workflow_run' && !headRepositoryGate(facts.condition)) {
            findings.push({ file, line: job.line, job: String(job.name), event, problem: 'missing-head-repository-gate' })
          }
          continue
        }
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
