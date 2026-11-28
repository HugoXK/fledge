// #1108: the publisher matches a required job by *name*, so a head can keep the
// name and change what the job does. `scripts/lib/ci-ok-run.mjs` asks the API for
// the job list; a job called `mock-check` that runs `true` reports `success`, and
// `jobKey()` sees nothing unusual. A job-level `continue-on-error: true` is the
// same class one key over: the step fails, the job's conclusion says `success`.
//
// The fix compares the pull request's `.github/workflows/ci.yml` with the default
// branch's copy, inside the publisher that runs on `workflow_run` (so the code
// doing the comparison always comes from the default branch), and refuses every
// required job whose definition differs. Every key of the job is compared, not
// only `run:`/`uses:`, because any key can decide a conclusion. The one shape
// that is allowed to grow is `steps:`: a new step cannot remove or change a
// base step, so the comparator requires every base step to survive, in order,
// and lets a head insert another one (#1270). A removed, changed or reordered
// base step still refuses.
//
// Only `timeout-minutes:` is allowlisted, and only because it cannot flip a
// conclusion: a shorter timeout fails a job, a longer one lets it finish.
// `name:` is *not* allowlisted. It is the value `jobKey()` matches against the
// required list, so renaming a required job while another job takes its old name
// is exactly the substitution this comparator exists to refuse. The job's
// display name is reserved for the required job, and a second head job claiming
// one required display name is a collision, refused by name.
//
// The comparison covers the whole file, not just the `jobs:` mapping. A
// top-level `defaults: run: shell: "true {0}"` or `env: NODE_OPTIONS:
// --require ./x.js` can change what every `run:` step does without touching a
// required job, so every top-level block other than `jobs:` must also match the
// base tree byte for byte. Adding a top-level block is a refusal too. Anything
// outside `jobs:`-and-allowlisted `timeout-minutes:` is deliberately refused,
// so widening that surface has to break `test/gateCompare.test.ts` rather than
// silently widen the gate.
//
// The `ci-ok` job's `needs:` may *grow* — a head that adds a job of its own and
// waits on it is not weakening the aggregate — but every base dependency and
// every required job must still be in it, and the evaluator step must still be
// exactly `node base/scripts/ci-ok.mjs` with the gate checked out under
// `path: base`. That is the #855 invariant, now pinned against a head that
// rewrites the workflow that calls it.
//
// Fail closed: a duplicated top-level key, a duplicated job id, a duplicated job
// key, an unreadable line or an empty `jobs:` mapping is a refusal with a
// reason, never a skipped comparison.
//
// Nothing from a workflow text is echoed verbatim: a message names the file, a
// required job id or key name that matches `[A-Za-z0-9_-]{1,40}`, and nothing a
// `run:` body, a `name:` value or an `env:` value holds. That keeps a refusal
// readable without turning a file's bytes into request text.

import { REQUIRED_JOBS } from '../ci-ok.mjs'

/** The one workflow this comparator reads, from both trees. */
export const GATE_COMPARE_FILE = '.github/workflows/ci.yml'

/** Keys a required job may change without being able to flip a conclusion. */
export const GATE_COMPARE_ALLOWED_KEYS = Object.freeze(['timeout-minutes'])

/** The step the aggregate must run, as the base tree spells it. */
export const REQUIRED_EVALUATOR = 'node base/scripts/ci-ok.mjs'

/** The required aggregate job, whose `needs` and step are pinned separately. */
export const AGGREGATE_JOB = 'ci-ok'

/** The label that records a reviewed workflow change (owner-applied). */
export const WORKFLOW_CHANGE_LABEL = 'ci-workflow-change'

/** A workflow text this comparator refuses to guess about. */
export class GateWorkflowError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GateWorkflowError'
  }
}

const TOP_KEY = /^([A-Za-z0-9_-]{1,40}):(.*)$/
const JOB_ID = /^ {2}([A-Za-z0-9_-]+):[ \t]*(?:#.*)?$/
const JOB_KEY = /^ {4}([A-Za-z0-9_-]+):(.*)$/
const KEY_NAME = /^[A-Za-z0-9_-]{1,40}$/
// The base's own spelling of a matrix-derived display name, e.g.
// `test (${{ matrix.node }})`: the part before the expression is what every leg
// of that job reports, so it is reserved the way a literal name is.
const MATRIX_NAME = /^(.+)\(\$\{\{.*\}\}\)$/

// One refusal suffix, so a reader is told the same way out of every refusal. A
// labelled change is one of those ways: the label records a reviewed change but
// cannot turn the verdict green, because the publisher cannot verify a PASS.
const DOOR = `; a required job must match the base tree — merge the base branch into the head, or, for a reviewed workflow change, the owner applies \`${WORKFLOW_CHANGE_LABEL}\` to a change that takes the T3 path: a PASS at this tip with a \`Security:\` line. The verdict stays red either way, because the publisher cannot verify a PASS`

function stripTrailing(line) {
  return line.replace(/[ \t]+$/, '')
}

function unquote(value) {
  return value.replace(/^['"]/, '').replace(/['"]$/, '')
}

/**
 * The workflow text as its top-level blocks plus its jobs.
 *
 * `top` maps every column-0 key (`name:`, `on:`, `permissions:`, `concurrency:`,
 * `jobs:`, …) to the key line and everything nested under it, so the caller can
 * compare everything outside `jobs:` as well. `jobs` is the parsed `jobs:`
 * mapping. A column-0 line that is not `key:`, a duplicated key or a line nested
 * under no key is a refusal: this parser reads the file's shape rather than
 * guessing at YAML it does not understand.
 */
export function parseWorkflow(text) {
  if (typeof text !== 'string') throw new GateWorkflowError('the workflow text is not a string')
  const source = text.replace(/\r\n?/g, '\n').split('\n')
  const top = new Map()
  let current = null
  for (let index = 0; index < source.length; index += 1) {
    const line = stripTrailing(source[index])
    if (line.trim() === '') continue
    if (/^[ \t]*#/.test(line)) continue
    const topKey = TOP_KEY.exec(line)
    if (topKey !== null) {
      const name = topKey[1]
      if (top.has(name)) throw new GateWorkflowError(`the workflow declares \`${name}:\` at the top level twice`)
      current = { name, lines: [line] }
      top.set(name, current)
      continue
    }
    if (current === null) throw new GateWorkflowError('the workflow has content before its first top-level key')
    if (!/^[ \t]+\S/.test(line)) throw new GateWorkflowError('the workflow has a top-level line the comparator cannot read')
    current.lines.push(line)
  }
  const jobsBlock = top.get('jobs')
  if (jobsBlock === undefined) throw new GateWorkflowError('the workflow has no top-level `jobs:` mapping')
  return { top, jobs: parseJobsBlock(jobsBlock.lines) }
}

/**
 * The jobs of a workflow text, as `Map<jobId, { id, keys: Map<key, string[]> }>`.
 * A key's `lines` are the key line and everything nested under it, trailing
 * whitespace removed and blank/comment lines dropped, so two definitions compare
 * by their content rather than by their layout of blank space.
 */
export function parseWorkflowJobs(text) {
  return parseWorkflow(text).jobs
}

function parseJobsBlock(lines) {
  if (!/^jobs:[ \t]*(?:#.*)?$/.test(stripTrailing(lines[0]))) {
    throw new GateWorkflowError('the top-level `jobs:` is not a block mapping')
  }
  const jobs = new Map()
  let current = null
  let key = null
  for (const raw of lines.slice(1)) {
    const line = stripTrailing(raw)
    if (line.trim() === '') continue
    if (/^[ \t]*#/.test(line)) continue
    const jobId = JOB_ID.exec(line)
    if (jobId !== null) {
      const id = jobId[1]
      if (jobs.has(id)) throw new GateWorkflowError(`the workflow declares job \`${id}\` twice`)
      current = { id, keys: new Map() }
      jobs.set(id, current)
      key = null
      continue
    }
    if (current === null) throw new GateWorkflowError('the `jobs:` mapping has content before its first job id')
    const jobKey = JOB_KEY.exec(line)
    if (jobKey !== null) {
      const name = jobKey[1]
      if (current.keys.has(name)) throw new GateWorkflowError(`job \`${current.id}\` declares \`${name}:\` twice`)
      key = { name, lines: [line] }
      current.keys.set(name, key)
      continue
    }
    if (!/^ {5,}\S/.test(line)) throw new GateWorkflowError(`job \`${current.id}\` has a line the comparator cannot read`)
    if (key === null) throw new GateWorkflowError(`job \`${current.id}\` has content before its first key`)
    key.lines.push(line)
  }
  if (jobs.size === 0) throw new GateWorkflowError('the `jobs:` mapping is empty')
  for (const job of jobs.values()) {
    if (job.keys.size === 0) throw new GateWorkflowError(`job \`${job.id}\` has no keys`)
  }
  return jobs
}

/**
 * The job ids a `needs:` value names, from the inline flow list
 * (`[lint, test]`), the inline scalar (`changes`) or the block list. A line that
 * is neither a list item nor blank is a refusal, because guessing which job it
 * meant is how a dropped dependency would be missed.
 */
function needsIds(job) {
  const key = job.keys.get('needs')
  if (key === undefined) return []
  const ids = []
  const inline = key.lines[0].replace(/^[ \t]*needs:/, '').trim()
  if (inline.startsWith('[')) {
    if (!inline.endsWith(']')) throw new GateWorkflowError(`job \`${job.id}\` has a \`needs:\` list the comparator cannot read`)
    for (const part of inline.slice(1, -1).split(',')) {
      const value = unquote(part.trim())
      if (value !== '') ids.push(value)
    }
  } else if (inline !== '') {
    ids.push(unquote(inline))
  }
  for (const line of key.lines.slice(1)) {
    const item = /^[ \t]*-[ \t]*(.+?)[ \t]*$/.exec(line)
    if (item === null) throw new GateWorkflowError(`job \`${job.id}\` has a \`needs:\` entry the comparator cannot read`)
    ids.push(unquote(item[1]))
  }
  for (const id of ids) {
    if (!KEY_NAME.test(id)) throw new GateWorkflowError(`job \`${job.id}\` has a \`needs:\` entry that is not a job id`)
  }
  return [...new Set(ids)]
}

/**
 * Every command a `run:` step executes, one string per step: the inline value,
 * or the block scalar's lines joined by a newline. `uses:` steps contribute
 * nothing.
 */
function runCommands(job) {
  const key = job.keys.get('steps')
  if (key === undefined) return []
  const commands = []
  const lines = key.lines
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*)(?:-[ \t]+)?run:[ \t]*(.*)$/.exec(lines[index])
    if (match === null) continue
    const indent = match[1].length
    const value = match[2].trim()
    if (value === '' || /^[|>][+-]?$/.test(value)) {
      const block = []
      let next = index + 1
      for (; next < lines.length; next += 1) {
        const indented = /^[ \t]*/.exec(lines[next])[0].length
        if (lines[next].trim() !== '' && indented <= indent) break
        block.push(lines[next].trim())
      }
      commands.push(block.filter((line) => line !== '').join('\n'))
      index = next - 1
    } else {
      commands.push(value)
    }
  }
  return commands
}

// The key a reader has to look at first: the first line on which the two
// definitions differ, named only when it parses as a plain key. A step item
// (`- name: …`) is skipped rather than reported as the job's own `name:`,
// because it does not parse as a plain key and reporting it as one would name a
// different line of the job.
function differingKey(baseLines, headLines) {
  const length = Math.max(baseLines.length, headLines.length)
  for (let index = 0; index < length; index += 1) {
    if (baseLines[index] === headLines[index]) continue
    for (const line of [headLines[index], baseLines[index]]) {
      if (typeof line !== 'string') continue
      const match = /^[ \t]*([A-Za-z0-9_-]+):/.exec(line)
      if (match !== null && KEY_NAME.test(match[1])) return match[1]
    }
    return null
  }
  return null
}

/** The display name a finished run reports for a job: `name:` or the job id. */
function displayName(job) {
  const key = job.keys.get('name')
  if (key === undefined) return job.id
  return unquote(key.lines[0].replace(/^[ \t]*name:[ \t]*/, '').replace(/[ \t]+#.*$/, '').trim())
}

/** A display name this comparator can reason about, as opposed to an expression. */
function isLiteralName(value) {
  return value !== '' && !value.startsWith('|') && !value.startsWith('>') && !value.includes('${{')
}

/**
 * The individual list items under a job's `steps:`, each as its original lines.
 * The first `- ` line after `steps:` sets the list's indentation; a nested list
 * item inside a step is deeper, so it stays in that step's block.
 */
function stepBlocks(job) {
  const key = job.keys.get('steps')
  if (key === undefined) return []
  const lines = key.lines.slice(1)
  const blocks = []
  let current = null
  let itemIndent = null
  for (const line of lines) {
    const item = /^([ \t]*)-[ \t]+(.*)$/.exec(line)
    if (item !== null) {
      const indent = item[1].length
      if (itemIndent === null) itemIndent = indent
      if (indent === itemIndent) {
        if (current !== null) blocks.push(current)
        current = [line]
        continue
      }
    }
    if (current !== null) current.push(line)
  }
  if (current !== null) blocks.push(current)
  return blocks
}

/**
 * A step compared by content, with only the step's own leading indent removed.
 * Deeper whitespace stays significant: a `run: |` body line moved out of the
 * block scalar compares differently, which trimming every line would hide.
 */
function normalizeStep(block) {
  const first = block[0] ?? ''
  const indent = first.length - first.trimStart().length
  const strip = new RegExp(`^ {0,${String(indent)}}`)
  return block.map((line) => line.replace(strip, '').trimEnd()).join('\n')
}

/**
 * The base steps must be a prefix of the head's steps: every base step survives
 * unchanged, in the same order and at the same position, so a step may only be
 * added after the last base step. A subsequence match would allow a step
 * inserted ahead of a base step — #1270's review showed a head can then put
 * `npm pkg set scripts.test='exit 0'` before `npm test` and keep the base text
 * matching — so position, not mere presence, is the invariant.
 */
function stepsPreserved(baseJob, headJob) {
  const head = stepBlocks(headJob).map(normalizeStep)
  const base = stepBlocks(baseJob).map(normalizeStep)
  if (head.length < base.length) return false
  for (let index = 0; index < base.length; index += 1) {
    if (head[index] !== base[index]) return false
  }
  return true
}

/**
 * Compare the head's workflow with the base tree's. `ok` is true only when every
 * top-level block other than `jobs:` matches, every required job is defined
 * identically (allowlisted keys aside), every required display name belongs to
 * exactly one job, the aggregate still depends on all of them, and its step
 * still runs the base evaluator.
 */
export function compareGate({ base, head, required = REQUIRED_JOBS } = {}) {
  const problems = []
  const refuse = (message) => {
    if (!problems.includes(message)) problems.push(message)
  }
  const refuseAll = (message) => ({ ok: false, problems: [message], lines: [] })

  let baseTree
  let headTree
  try {
    baseTree = parseWorkflow(base)
  } catch (error) {
    return refuseAll(`the base tree's ${GATE_COMPARE_FILE} cannot be compared (${error.message}); the gate is not guessed at`)
  }
  try {
    headTree = parseWorkflow(head)
  } catch (error) {
    return refuseAll(`the pull request's ${GATE_COMPARE_FILE} cannot be compared (${error.message}); the gate is not guessed at`)
  }

  // Everything outside `jobs:` is compared byte for byte. A top-level
  // `defaults:` or `env:` decides how every `run:` step executes, so a head that
  // changes one has changed the body of every required job without touching it.
  for (const [name, baseBlock] of baseTree.top) {
    if (name === 'jobs') continue
    const headBlock = headTree.top.get(name)
    if (headBlock === undefined) {
      refuse(`the pull request's ${GATE_COMPARE_FILE} loses the top-level \`${name}:\` block${DOOR}`)
      continue
    }
    if (baseBlock.lines.join('\n') !== headBlock.lines.join('\n')) {
      refuse(`the pull request's ${GATE_COMPARE_FILE} changes the top-level \`${name}:\` block${DOOR}`)
    }
  }
  for (const name of headTree.top.keys()) {
    if (name === 'jobs' || baseTree.top.has(name)) continue
    refuse(`the pull request's ${GATE_COMPARE_FILE} gains a top-level \`${name}:\` block${DOOR}`)
  }

  const baseJobs = baseTree.jobs
  const headJobs = headTree.jobs
  const requiredIds = Array.isArray(required) ? required.filter((id) => typeof id === 'string') : []
  const allowlisted = new Set(GATE_COMPARE_ALLOWED_KEYS)

  for (const id of requiredIds) {
    const baseJob = baseJobs.get(id)
    if (baseJob === undefined) {
      refuse(`the base tree's ${GATE_COMPARE_FILE} has no required job \`${id}\`, so this pull request cannot be judged against it`)
      continue
    }
    const headJob = headJobs.get(id)
    if (headJob === undefined) {
      refuse(`required job \`${id}\` is absent from the pull request's ${GATE_COMPARE_FILE}${DOOR}`)
      continue
    }
    for (const [name, baseKey] of baseJob.keys) {
      if (allowlisted.has(name)) continue
      const headKey = headJob.keys.get(name)
      if (headKey === undefined) {
        refuse(`required job \`${id}\` loses \`${name}:\` in the pull request's ${GATE_COMPARE_FILE}${DOOR}`)
        continue
      }
      // `steps:` may grow only at the end: the base list has to stay a prefix,
      // so a step added after the last base step is a strengthening while one
      // inserted before or between base steps is refused. The comparator cannot
      // allow an arbitrary pre-step; a step that must run first has to come from
      // the base tree, not from the head being judged.
      if (name === 'steps') {
        if (!stepsPreserved(baseJob, headJob)) {
          refuse(`required job \`${id}\` changes \`steps:\` from the base tree in ${GATE_COMPARE_FILE}${DOOR} (the base steps must stay a prefix: a step may only be added after the last base step, never before or between them)`)
        }
        continue
      }
      // The aggregate may wait on more than the base did, but never on less:
      // `needsIds` has already refused a list it cannot read.
      if (id === AGGREGATE_JOB && name === 'needs') {
        const headNeeds = needsIds(headJob)
        for (const dependency of needsIds(baseJob)) {
          if (!headNeeds.includes(dependency)) {
            refuse(`the pull request's \`${AGGREGATE_JOB}\` does not depend on required job \`${dependency}\``)
          }
        }
        continue
      }
      if (baseKey.lines.join('\n') === headKey.lines.join('\n')) continue
      const key = differingKey(baseKey.lines, headKey.lines)
      refuse(
        key === null
          ? `required job \`${id}\` differs from the base tree in ${GATE_COMPARE_FILE}${DOOR}`
          : `required job \`${id}\` changes \`${key}:\` from the base tree in ${GATE_COMPARE_FILE}${DOOR}`,
      )
    }
    for (const name of headJob.keys.keys()) {
      if (allowlisted.has(name) || baseJob.keys.has(name)) continue
      refuse(`required job \`${id}\` gains \`${name}:\` in the pull request's ${GATE_COMPARE_FILE}${DOOR}`)
    }
  }

  // A required job is matched by the display name the API reports, so that name
  // has to belong to exactly one job. Two head jobs claiming one required name
  // are merged into one `needs` entry, and the extra job may report `success`
  // while the real one is skipped — that is the substitution this refuses.
  for (const id of requiredIds) {
    const baseJob = baseJobs.get(id)
    if (baseJob === undefined) continue
    const baseName = displayName(baseJob)
    const matrix = MATRIX_NAME.exec(baseName)
    for (const job of headJobs.values()) {
      if (job.id === id) continue
      const candidate = displayName(job)
      if (candidate === '') continue
      const claims = isLiteralName(candidate)
        ? isLiteralName(baseName)
          ? candidate === baseName
          : matrix !== null
            ? candidate.startsWith(`${matrix[1]}(`) && candidate.endsWith(')') && candidate.length > matrix[1].length + 2
            : false
        : candidate === baseName
      if (claims) {
        refuse(`the pull request's ${GATE_COMPARE_FILE} lets job \`${job.id}\` claim the display name of required job \`${id}\`${DOOR}`)
      }
    }
  }

  // Two jobs with one display name are merged into one result whatever the name
  // is, so the duplication itself is refused rather than only its required-name
  // case.
  const identities = new Map()
  for (const job of headJobs.values()) {
    const identity = displayName(job)
    const seen = identities.get(identity)
    if (seen === undefined) {
      identities.set(identity, job.id)
      continue
    }
    refuse(`the pull request's ${GATE_COMPARE_FILE} gives jobs \`${seen}\` and \`${job.id}\` the same display name${DOOR}`)
  }

  // The aggregate is not a check the publisher waits on, so it is not in
  // `required`, but it is the gate: pin every key the base tree sets, allowing
  // only `needs` to grow and `timeout-minutes` as the one allowlisted key. A
  // step inserted between the `path: base` checkout and the evaluator could
  // rewrite the evaluator it is about to run, which the command-string check
  // below cannot see.
  const aggregate = headJobs.get(AGGREGATE_JOB)
  const baseAggregate = baseJobs.get(AGGREGATE_JOB)
  if (baseAggregate === undefined) {
    refuse(`the base tree's ${GATE_COMPARE_FILE} has no \`${AGGREGATE_JOB}\` job, so this pull request cannot be judged against it`)
  } else if (aggregate === undefined) {
    refuse(`required job \`${AGGREGATE_JOB}\` is absent from the pull request's ${GATE_COMPARE_FILE}${DOOR}`)
  } else {
    for (const [name, baseKey] of baseAggregate.keys) {
      if (allowlisted.has(name)) continue
      const headKey = aggregate.keys.get(name)
      if (headKey === undefined) {
        refuse(`the pull request's \`${AGGREGATE_JOB}\` loses \`${name}:\` in ${GATE_COMPARE_FILE}${DOOR}`)
        continue
      }
      // `needs` may grow; the dependency set is checked below.
      if (name === 'needs') continue
      if (name === 'steps') {
        if (!stepsPreserved(baseAggregate, aggregate)) {
          refuse(`the pull request's \`${AGGREGATE_JOB}\` changes \`steps:\` from the base tree in ${GATE_COMPARE_FILE}${DOOR} (the base steps must stay a prefix: a step may only be added after the last base step, never before or between them)`)
        }
        continue
      }
      if (baseKey.lines.join('\n') === headKey.lines.join('\n')) continue
      const key = differingKey(baseKey.lines, headKey.lines)
      refuse(
        key === null
          ? `the pull request's \`${AGGREGATE_JOB}\` differs from the base tree in ${GATE_COMPARE_FILE}${DOOR}`
          : `the pull request's \`${AGGREGATE_JOB}\` changes \`${key}:\` from the base tree in ${GATE_COMPARE_FILE}${DOOR}`,
      )
    }
    for (const name of aggregate.keys.keys()) {
      if (allowlisted.has(name) || baseAggregate.keys.has(name)) continue
      refuse(`the pull request's \`${AGGREGATE_JOB}\` gains \`${name}:\` in ${GATE_COMPARE_FILE}${DOOR}`)
    }
    const headNeeds = needsIds(aggregate)
    for (const id of requiredIds) {
      if (!headNeeds.includes(id)) refuse(`the pull request's \`${AGGREGATE_JOB}\` does not depend on required job \`${id}\``)
    }
    if (!runCommands(aggregate).includes(REQUIRED_EVALUATOR)) {
      refuse(`the pull request's \`${AGGREGATE_JOB}\` does not run the base evaluator \`${REQUIRED_EVALUATOR}\``)
    }
    const checkout = /^[ \t]*path:[ \t]*base[ \t]*$/
    if (!aggregate.keys.get('steps')?.lines.some((line) => checkout.test(line))) {
      refuse(`the pull request's \`${AGGREGATE_JOB}\` does not check the gate out under \`path: base\``)
    }
  }

  if (problems.length > 0) return { ok: false, problems, lines: [] }
  return {
    ok: true,
    problems: [],
    lines: [
      `gate-compare: the pull request's ${GATE_COMPARE_FILE} matches the base tree outside \`jobs:\`, defines all ${String(requiredIds.length)} required job(s) as the base tree does (allowlisted: ${GATE_COMPARE_ALLOWED_KEYS.join(', ')}), gives each required display name to one job, and \`${AGGREGATE_JOB}\` runs \`${REQUIRED_EVALUATOR}\``,
    ],
  }
}
