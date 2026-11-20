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
// only `run:`/`uses:`, because any key can decide a conclusion.
//
// Two keys are allowlisted, and only because they cannot flip one:
//
//   - `name:` is the display name GitHub reports. `ci-ok.mjs`/`evaluate` decides
//     on `needs` keys, and `jobKey()` maps a display name back to a required key
//     by matching the base's list — a changed `name:` on a required job only
//     makes the publisher unable to find it, which is red, never green.
//   - `timeout-minutes:` bounds a run; a shorter one fails the job, a longer one
//     lets it finish.
//
// Anything else is a refusal, deliberately including a key this comment does not
// name: widening the allowlist has to break `test/gateCompare.test.ts` rather
// than silently widen the gate.
//
// The `ci-ok` job's `needs:` may *grow* — a head that adds a job of its own and
// waits on it is not weakening the aggregate — but every base dependency and
// every required job must still be in it, and the evaluator step must still be
// exactly `node base/scripts/ci-ok.mjs` with the gate checked out under
// `path: base`. That is the #855 invariant, now pinned against a head that
// rewrites the workflow that calls it.
//
// Fail closed: a duplicated job id, a duplicated job key, an unreadable line or
// an empty mapping is a refusal with a reason, never a skipped comparison.
//
// Nothing from a workflow text is echoed verbatim: a message names the file, a
// required job id from the base's required list, and a key name that matches
// `[A-Za-z0-9_-]{1,40}`. That keeps a refusal readable without turning a file's
// bytes into request text.

import { REQUIRED_JOBS } from '../ci-ok.mjs'

/** The one workflow this comparator reads, from both trees. */
export const GATE_COMPARE_FILE = '.github/workflows/ci.yml'

/** Keys a required job may change without being able to flip a conclusion. */
export const GATE_COMPARE_ALLOWED_KEYS = Object.freeze(['name', 'timeout-minutes'])

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

const JOB_ID = /^ {2}([A-Za-z0-9_-]+):[ \t]*(?:#.*)?$/
const JOB_KEY = /^ {4}([A-Za-z0-9_-]+):(.*)$/
const KEY_NAME = /^[A-Za-z0-9_-]{1,40}$/

function stripTrailing(line) {
  return line.replace(/[ \t]+$/, '')
}

/**
 * The jobs of a workflow text, as `Map<jobId, { id, keys: Map<key, string[]> }>`.
 * A key's `lines` are the key line and everything nested under it, trailing
 * whitespace removed and blank/comment lines dropped, so two definitions compare
 * by their content rather than by their layout of blank space.
 */
export function parseWorkflowJobs(text) {
  if (typeof text !== 'string') throw new GateWorkflowError('the workflow text is not a string')
  const source = text.replace(/\r\n?/g, '\n').split('\n')
  let start = -1
  for (let index = 0; index < source.length; index += 1) {
    if (/^jobs:[ \t]*(?:#.*)?$/.test(source[index])) {
      if (start !== -1) throw new GateWorkflowError('the workflow declares a top-level `jobs:` mapping twice')
      start = index
    }
  }
  if (start === -1) throw new GateWorkflowError('the workflow has no top-level `jobs:` mapping')

  const jobs = new Map()
  let current = null
  let key = null
  for (let index = start + 1; index < source.length; index += 1) {
    const line = stripTrailing(source[index])
    if (line.trim() === '') continue
    if (/^[ \t]*#/.test(line)) continue
    // The next top-level key ends the mapping; `jobs:` is the last block this
    // comparator reads, and a second one was refused above.
    if (/^\S/.test(line)) break
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

function unquote(value) {
  return value.replace(/^['"]/, '').replace(/['"]$/, '')
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
// (`- name: …`) is skipped rather than reported as `name:`, because that would
// read as the job's own name, which is allowlisted and innocent here.
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

function door(labelled) {
  return labelled
    ? `; \`${WORKFLOW_CHANGE_LABEL}\` is set, so this is a reviewed workflow change: it needs the T3 path, a PASS at this tip with a \`Security:\` line, and this verdict stays red because the publisher cannot verify a PASS`
    : `; a required job must match the base tree — merge the base branch into the head, or, for a reviewed workflow change, the owner applies \`${WORKFLOW_CHANGE_LABEL}\` to a change that carries a PASS naming it`
}

/**
 * Compare the head's workflow with the base tree's. `ok` is true only when every
 * required job is defined identically (allowlisted keys aside), the aggregate
 * still depends on all of them, and its step still runs the base evaluator.
 */
export function compareGate({ base, head, required = REQUIRED_JOBS, labelled = false } = {}) {
  const problems = []
  const refuse = (message) => {
    if (!problems.includes(message)) problems.push(message)
  }
  const refuseAll = (message) => ({ ok: false, problems: [message], lines: [] })

  let baseJobs
  let headJobs
  try {
    baseJobs = parseWorkflowJobs(base)
  } catch (error) {
    return refuseAll(`the base tree's ${GATE_COMPARE_FILE} cannot be compared (${error.message}); the gate is not guessed at`)
  }
  try {
    headJobs = parseWorkflowJobs(head)
  } catch (error) {
    return refuseAll(`the pull request's ${GATE_COMPARE_FILE} cannot be compared (${error.message}); the gate is not guessed at`)
  }

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
      refuse(`required job \`${id}\` is absent from the pull request's ${GATE_COMPARE_FILE}${door(labelled)}`)
      continue
    }
    for (const [name, baseKey] of baseJob.keys) {
      if (allowlisted.has(name)) continue
      const headKey = headJob.keys.get(name)
      if (headKey === undefined) {
        refuse(`required job \`${id}\` loses \`${name}:\` in the pull request's ${GATE_COMPARE_FILE}${door(labelled)}`)
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
          ? `required job \`${id}\` differs from the base tree in ${GATE_COMPARE_FILE}${door(labelled)}`
          : `required job \`${id}\` changes \`${key}:\` from the base tree in ${GATE_COMPARE_FILE}${door(labelled)}`,
      )
    }
    for (const name of headJob.keys.keys()) {
      if (allowlisted.has(name) || baseJob.keys.has(name)) continue
      refuse(`required job \`${id}\` gains \`${name}:\` in the pull request's ${GATE_COMPARE_FILE}${door(labelled)}`)
    }
  }

  const aggregate = headJobs.get(AGGREGATE_JOB)
  if (aggregate !== undefined) {
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
      `gate-compare: the pull request's ${GATE_COMPARE_FILE} defines all ${String(requiredIds.length)} required job(s) as the base tree does (allowlisted: ${GATE_COMPARE_ALLOWED_KEYS.join(', ')}) and \`${AGGREGATE_JOB}\` runs \`${REQUIRED_EVALUATOR}\``,
    ],
  }
}
