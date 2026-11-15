import type { GatePlan, GatePlanLaneName } from './plan.js'
import { contractGaps, laneContract, LANE_TRIGGER_TEXT, laneTrigger } from './lanes.js'

// #543 second slice: composing the gate pull request is pure. The caller reads
// the current files and the branch SHA, this module decides the exact bytes and
// the PR body, and nothing here touches the network. That split is what makes
// "planning performs no repository write" and "an existing ci.yml keeps its
// unrelated jobs and triggers" testable at the byte level.

export const GATE_WORKFLOW_PATH = '.github/workflows/fledge-gate.yml'
export const GATE_CONTRACT_PATH = '.github/ci-gates.json'
export const GATE_SCRIPT_PATH = 'scripts/gate/gate.mjs'
export const RELEASE_WORKFLOW_PATH = '.github/workflows/release.yml'
export const GATE_JOB_ID = 'fledge-gate'
export const GATE_MARKER = 'fledge-gate:begin'
export const GATE_SCRIPT_MARKER = 'fledge-gate script'
export const DAILY_CRON = '17 3 * * *'

const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/
const RELEASE_PATH = /^\.github\/workflows\/release\.ya?ml$/
const BRANCH = /^[A-Za-z0-9._/-]+$/

export interface ExistingFile {
  path: string
  content: string
  /** Blob SHA when GitHub returned one; required to update an existing file. */
  sha?: string
}

export interface ComposedFile {
  path: string
  content: string
  mode: 'create' | 'update' | 'unchanged'
  sha?: string
}

export interface ComposedPullRequest {
  title: string
  body: string
  branch: string
  base: string
}

export interface ComposeInput {
  plan: GatePlan
  planHash: string
  baseBranch: string
  existing: ExistingFile[]
  confirmedBy?: string
}

export type ComposeResult =
  | { ok: true; files: ComposedFile[]; pr: ComposedPullRequest; notes: string[]; gaps: string[] }
  | { ok: false; code: string; message: string }

function fileOf(existing: ExistingFile[], path: string): ExistingFile | undefined {
  return existing.find((file) => file.path === path)
}

function unchangedOrUpdated(path: string, content: string, existing: ExistingFile[]): ComposedFile {
  const current = fileOf(existing, path)
  if (current === undefined) return { path, content, mode: 'create' }
  if (current.content === content) return { path, content, mode: 'unchanged', ...(current.sha === undefined ? {} : { sha: current.sha }) }
  return { path, content, mode: 'update', ...(current.sha === undefined ? {} : { sha: current.sha }) }
}

// --- trigger merge -------------------------------------------------------
//
// The merged path only ever needs `pull_request`: the pr-ready lane. Adding
// `schedule:`, a tag push or `merge_group:` to a file that already runs another
// project's jobs would make all of those jobs run on the new event, so those
// lanes always live in the dedicated workflow file instead. One file gains one
// trigger and one job; the blast radius is exactly one job.

function addPullRequestTrigger(content: string): string | null {
  const lines = content.split('\n')
  const onIndex = lines.findIndex((line) => line.startsWith('on:'))
  if (onIndex === -1) return null
  const header = lines[onIndex]!
  const inline = header.slice('on:'.length).trim()
  if (inline !== '') {
    if (inline.startsWith('[') && inline.endsWith(']')) {
      const events = inline.slice(1, -1).split(',').map((value) => value.trim()).filter((value) => value !== '')
      if (events.some((value) => value === 'pull_request' || value === 'pull_request_target')) return content
      lines[onIndex] = `on: [${[...events, 'pull_request'].join(', ')}]`
      return lines.join('\n')
    }
    // A scalar `on: push` becomes a block list that keeps the old event and adds
    // the new one. Anything with a colon is a mapping in one line we do not
    // rewrite textually; the caller falls back to the dedicated workflow.
    if (/^[A-Za-z0-9_-]+$/.test(inline)) {
      lines[onIndex] = `on:\n  ${inline}:\n  pull_request:`
      return lines.join('\n')
    }
    return null
  }
  // Block form: find the end of the `on:` mapping (the next top-level key).
  let end = lines.length
  for (let index = onIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '' || line.startsWith('#')) continue
    if (/^\S/.test(line)) { end = index; break }
  }
  const block = lines.slice(onIndex + 1, end)
  if (block.some((line) => /^\s+(pull_request|pull_request_target)\s*:/.test(line) || /^\s+-\s*pull_request\s*$/.test(line))) return content
  let insertAt = end
  while (insertAt > onIndex + 1 && lines[insertAt - 1]!.trim() === '') insertAt -= 1
  lines.splice(insertAt, 0, '  pull_request:')
  return lines.join('\n')
}

function hasJob(content: string, jobId: string): boolean {
  return content.split('\n').some((line) => new RegExp(`^  ${jobId}:\\s*(#.*)?$`).test(line))
}

function insertJob(content: string, jobId: string, jobYaml: string): string | null {
  if (hasJob(content, jobId)) return null
  const lines = content.split('\n')
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line))
  if (jobsIndex === -1) return null
  let end = lines.length
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    if (/^\S/.test(lines[index]!)) { end = index; break }
  }
  let insertAt = end
  while (insertAt > jobsIndex + 1 && lines[insertAt - 1]!.trim() === '') insertAt -= 1
  const block = jobYaml.replace(/\n$/, '').split('\n')
  lines.splice(insertAt, 0, ...block, ...(insertAt < end ? [''] : []))
  return lines.join('\n')
}

/** Merge the pr-ready job into an existing workflow, or `null` when unsafe to try. */
function mergeIntoWorkflow(content: string, jobYaml: string): string | null {
  if (!/^on:/m.test(content) || !/^jobs:\s*(#.*)?$/m.test(content)) return null
  const withTrigger = addPullRequestTrigger(content)
  if (withTrigger === null) return null
  const withJob = insertJob(withTrigger, GATE_JOB_ID, jobYaml)
  if (withJob === null) return null
  return withJob.endsWith('\n') ? withJob : `${withJob}\n`
}

// --- workflow jobs -------------------------------------------------------

function laneEvents(lane: GatePlanLaneName, plan: GatePlan, baseBranch: string): string[] {
  const trigger = laneTrigger(lane, plan.mergeQueue)
  switch (trigger) {
    case 'pull_request': return ["github.event_name == 'pull_request'"]
    case 'merge_group': return ["github.event_name == 'merge_group'"]
    case 'after_merge': return ["github.event_name == 'push'", `github.ref == 'refs/heads/${baseBranch}'`]
    case 'schedule': return ["github.event_name == 'schedule'"]
    case 'tag': return ["github.event_name == 'push'", "startsWith(github.ref, 'refs/tags/')"]
  }
}

function jobId(lane: GatePlanLaneName): string {
  return `${GATE_JOB_ID}-${lane}`
}

function laneJobYaml(lane: GatePlanLaneName, plan: GatePlan, baseBranch: string, id: string): string {
  const conditions = laneEvents(lane, plan, baseBranch)
  return [
    `  ${id}:`,
    `    # Added by Fledge from a confirmed gate plan (#543). Keep the marker lines:`,
    `    # a later run replaces only the block between them.`,
    `    # ${GATE_MARKER} ${lane}`,
    `    name: Fledge gate (${lane})`,
    `    if: ${conditions.join(' && ')}`,
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    `      - run: node ${GATE_SCRIPT_PATH} ${lane}`,
    `    # ${GATE_MARKER}-end ${lane}`,
  ].join('\n')
}

function triggersYaml(plan: GatePlan, baseBranch: string, lanes: GatePlanLaneName[], releaseWorkflowCreated: boolean): string[] {
  const has = (lane: GatePlanLaneName): boolean => lanes.includes(lane)
  const lines = ['on:']
  if (has('pr-ready')) lines.push('  pull_request:')
  if (has('pr-merge') && plan.mergeQueue) lines.push('  merge_group:')
  const pushBranches = has('pr-merge') && !plan.mergeQueue
  const pushTags = has('release') && !releaseWorkflowCreated
  if (pushBranches || pushTags) {
    lines.push('  push:')
    if (pushBranches) lines.push(`    branches: ['${baseBranch}']`)
    if (pushTags) lines.push("    tags: ['v*']")
  }
  if (has('daily')) {
    lines.push('  schedule:')
    lines.push(`    - cron: '${DAILY_CRON}'`)
  }
  return lines
}

function dedicatedWorkflowYaml(plan: GatePlan, baseBranch: string, lanes: GatePlanLaneName[], releaseWorkflowCreated: boolean): string {
  const lines = [
    '# Generated by Fledge from a confirmed gate plan (#543). Do not edit the job',
    '# blocks by hand: the commands live in .github/ci-gates.json.',
    'name: Fledge gate',
    ...triggersYaml(plan, baseBranch, lanes, releaseWorkflowCreated),
    'permissions:',
    '  contents: read',
    'jobs:',
  ]
  for (const lane of lanes) lines.push(laneJobYaml(lane, plan, baseBranch, jobId(lane)))
  return `${lines.join('\n')}\n`
}

function releaseWorkflowYaml(plan: GatePlan, baseBranch: string): string {
  const job = laneJobYaml('release', plan, baseBranch, `${GATE_JOB_ID}-release`)
  return [
    '# Generated by Fledge from a confirmed gate plan (#543): the tag-triggered',
    '# release lane. Commands live in .github/ci-gates.json.',
    'name: Fledge release gate',
    'on:',
    '  push:',
    "    tags: ['v*']",
    'permissions:',
    '  contents: read',
    'jobs:',
    job,
  ].join('\n') + '\n'
}

// --- the gate script -----------------------------------------------------

// The script is generated into the user's repository because a workflow needs a
// file to run. It only reads .github/ci-gates.json and implements the same four
// outcomes as `laneResult` above: empty is not_applicable, never a pass; a
// non-zero exit is observe_fail in an observe lane and fail otherwise.
function gateScriptSource(): string {
  return [
    '#!/usr/bin/env node',
    `// ${GATE_SCRIPT_MARKER} generated by Fledge from a confirmed gate plan (#543).`,
    '// Change commands in .github/ci-gates.json; this file only runs them.',
    "import { appendFileSync, readFileSync } from 'node:fs'",
    "import { spawnSync } from 'node:child_process'",
    '',
    'const lane = process.argv[2]',
    'if (lane === undefined || lane === "") {',
    "  console.error('usage: node scripts/gate/gate.mjs <lane>')",
    '  process.exit(2)',
    '}',
    '',
    "const contract = JSON.parse(readFileSync(new URL('../../.github/ci-gates.json', import.meta.url), 'utf8'))",
    'const entry = contract.lanes[lane]',
    'if (entry === undefined) {',
    "  console.error('unknown lane: ' + lane)",
    '  process.exit(2)',
    '}',
    '',
    'const summary = process.env.GITHUB_STEP_SUMMARY',
    'function finish(outcome, code, detail) {',
    "  const line = 'GATE_RESULT lane=' + lane + ' outcome=' + outcome + ' exit=' + code + ' ' + detail",
    '  console.log(line)',
    "  if (summary !== undefined && summary !== '') appendFileSync(summary, '- ' + lane + ': **' + outcome + '** — ' + detail + '\\n')",
    "  process.exit(outcome === 'fail' ? 1 : 0)",
    '}',
    '',
    'const commands = Array.isArray(entry.commands) ? entry.commands : []',
    'if (commands.length === 0) {',
    "  finish('not_applicable', 0, 'the lane has no commands')",
    '}',
    '',
    'let ran = 0',
    'for (const command of commands) {',
    "  console.log('GATE lane=' + lane + ' run: ' + command)",
    '  const result = spawnSync(command, { shell: true, stdio: \'inherit\', env: process.env })',
    '  const code = result.status === null ? 1 : result.status',
    '  ran += 1',
    '  if (code !== 0) {',
    "    finish(entry.observe === true ? 'observe_fail' : 'fail', code, 'command exited ' + code + ': ' + command)",
    '  }',
    '}',
    "",
    "finish('pass', 0, ran + ' command(s) passed')",
    '',
  ].join('\n')
}

// --- composition ---------------------------------------------------------

function mergeCandidate(existing: ExistingFile[]): ExistingFile | undefined {
  const workflows = existing
    .filter((file) => WORKFLOW_PATH.test(file.path) && !RELEASE_PATH.test(file.path) && file.path !== GATE_WORKFLOW_PATH)
    .sort((left, right) => {
      const rank = (path: string): number => (path === '.github/workflows/ci.yml' ? 0 : 1)
      return rank(left.path) - rank(right.path) || left.path.localeCompare(right.path)
    })
  return workflows[0]
}

function laneTable(plan: GatePlan): string {
  const rows = (Object.keys(plan.lanes) as GatePlanLaneName[]).map((lane) => {
    const entry = plan.lanes[lane]
    const commands = entry.commands.length === 0 ? '_(empty: not_applicable)_' : entry.commands.map((command) => `\`${command}\``).join('<br>')
    return `| \`${lane}\` | ${entry.observe ? 'observe' : 'blocking'} | ${LANE_TRIGGER_TEXT[laneTrigger(lane, plan.mergeQueue)]} | ${commands} |`
  })
  return ['| Lane | Mode | Runs on | Commands |', '| --- | --- | --- | --- |', ...rows].join('\n')
}

function prBody(input: { plan: GatePlan; planHash: string; baseBranch: string; gaps: string[]; notes: string[]; confirmedBy?: string }): string {
  const { plan, planHash, baseBranch, gaps, notes } = input
  const confirmed = input.confirmedBy === undefined ? '' : `Confirmed by @${input.confirmedBy} in Fledge.\n\n`
  return [
    'Written-by: Fledge Platform',
    '',
    `Installs the CI gate contract the maintainer confirmed for this repository.`,
    '',
    `- Base: \`${baseBranch}\` at \`${plan.baseSha}\``,
    `- Gate-plan-hash: \`${planHash}\``,
    `- Merge queue: ${plan.mergeQueue ? 'yes (`merge_group`)' : 'no (pr-merge runs after merge)'}`,
    '',
    confirmed + laneTable(plan),
    '',
    '### Files in this pull request',
    '- `.github/ci-gates.json`: the lane contract the gate script reads.',
    `- \`${GATE_SCRIPT_PATH}\`: runs one lane and reports pass, fail, observe_fail or not_applicable.`,
    `- \`${GATE_WORKFLOW_PATH}\`: the lanes that need their own triggers.`,
    `- \`${RELEASE_WORKFLOW_PATH}\`: the tag-triggered release lane, when it was missing.`,
    '- An existing workflow gains only the pr-ready gate job and a `pull_request` trigger; unrelated jobs and triggers are left in place.',
    '',
    gaps.length === 0 ? '### Gaps\nNone recorded.' : `### Gaps\n${gaps.map((gap) => `- ${gap}`).join('\n')}`,
    notes.length === 0 ? '' : `\n### Notes\n${notes.map((note) => `- ${note}`).join('\n')}`,
    '',
    'This pull request is not merged automatically. Review it, then merge it in the repository as usual.',
    '',
  ].join('\n')
}

export function composeGatePullRequest(input: ComposeInput): ComposeResult {
  const { plan, planHash, baseBranch, existing } = input
  if (!BRANCH.test(baseBranch)) {
    return { ok: false, code: 'base_branch_invalid', message: `The base branch ${JSON.stringify(baseBranch)} is not a name this composer can write into a workflow.` }
  }

  const notes: string[] = []
  const files: ComposedFile[] = []

  const contract = laneContract({ plan, planHash, baseBranch })
  const contractContent = `${JSON.stringify(contract, null, 2)}\n`
  files.push(unchangedOrUpdated(GATE_CONTRACT_PATH, contractContent, existing))

  const script = fileOf(existing, GATE_SCRIPT_PATH)
  if (script === undefined) {
    files.push({ path: GATE_SCRIPT_PATH, content: gateScriptSource(), mode: 'create' })
  } else if (!script.content.includes(GATE_SCRIPT_MARKER)) {
    notes.push(`\`${GATE_SCRIPT_PATH}\` already exists and was not generated by Fledge, so it is left untouched; the gate job runs it as it is.`)
  }

  const release = fileOf(existing, RELEASE_WORKFLOW_PATH)
  if (release === undefined) {
    files.push({ path: RELEASE_WORKFLOW_PATH, content: releaseWorkflowYaml(plan, baseBranch), mode: 'create' })
  } else {
    notes.push(`\`${RELEASE_WORKFLOW_PATH}\` already exists, so the release lane is wired into \`${GATE_WORKFLOW_PATH}\` instead of editing it.`)
  }

  const dedicatedLanes: GatePlanLaneName[] = []
  const candidate = mergeCandidate(existing)
  let merged = false
  if (candidate !== undefined) {
    const mergedContent = mergeIntoWorkflow(candidate.content, laneJobYaml('pr-ready', plan, baseBranch, GATE_JOB_ID))
    if (mergedContent === null) {
      notes.push(`\`${candidate.path}\` has a trigger or jobs shape this composer will not rewrite, so the pr-ready lane went into \`${GATE_WORKFLOW_PATH}\` instead.`)
    } else {
      files.push(unchangedOrUpdated(candidate.path, mergedContent, existing))
      merged = true
      notes.push(`\`${candidate.path}\` gains only the \`${GATE_JOB_ID}\` job and a \`pull_request\` trigger; its other jobs and triggers are byte-for-byte preserved.`)
    }
  }
  if (!merged) dedicatedLanes.push('pr-ready')
  dedicatedLanes.push('pr-merge', 'daily')
  if (release !== undefined) dedicatedLanes.push('release')

  files.push(unchangedOrUpdated(GATE_WORKFLOW_PATH, dedicatedWorkflowYaml(plan, baseBranch, dedicatedLanes, release === undefined), existing))

  notes.push('The gate job uses `actions/checkout@v4`, a major-version tag rather than a commit SHA; pin it if this repository requires pinned actions.')
  notes.push('The job runs on the runner\'s preinstalled Node.js; it does not install a toolchain or the repository dependencies.')

  const gaps = [...plan.gaps, ...contractGaps(plan)]
  const pr: ComposedPullRequest = {
    title: `ci: install the Fledge gate (${plan.lanes['pr-ready'].commands.length > 0 ? 'pr-ready gated' : 'no pr-ready command'})`,
    body: prBody({ plan, planHash, baseBranch, gaps, notes, ...(input.confirmedBy === undefined ? {} : { confirmedBy: input.confirmedBy }) }),
    branch: `fledge/gate-${planHash.slice(0, 8)}`,
    base: baseBranch,
  }
  return { ok: true, files, pr, notes, gaps }
}
