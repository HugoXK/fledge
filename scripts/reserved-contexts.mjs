#!/usr/bin/env node
// #963: runs the reserved-context scanner over the workflow tree. The gate is
// this script's exit code: a job that publishes a reserved check context from a
// file that is not allowed to produce it fails the job, and so does a workflow
// file that cannot be read (fail closed).
//
// The same exit code covers a line the scanner cannot resolve into a check-run
// name — a backslash escape, a block scalar, a tag, a tab — because those can
// resolve to a reserved context in YAML even when this line parser cannot see
// it. A gate that cannot tell is not a gate that passes.
//
// #640: the checker comes from the base branch and the workflows are the data
// under test, so the directory is an argument rather than this script's own
// tree — a copy of the scanner on the branch could otherwise judge itself.
import { RESERVED_CONTEXTS, scanWorkflows } from './lib/reserved-contexts.mjs'

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const directory = argument('--workflows', '.github/workflows')

let report
try {
  report = scanWorkflows(directory)
} catch (error) {
  console.error(`reserved-contexts: cannot read a workflow file: ${error.message}`)
  process.exit(1)
}

let publishers = 0
let unresolved = 0
for (const finding of report.findings) {
  if (finding.kind === 'unsupported') {
    unresolved += 1
    console.error(`${finding.file}:${finding.line}: ${finding.reason}; this check cannot prove which context it publishes`)
    continue
  }
  publishers += 1
  const allowed = (RESERVED_CONTEXTS[finding.context] ?? []).join(', ')
  const position = finding.kind === 'name' ? 'name:' : 'job id'
  console.error(
    `${finding.file}:${finding.line}: ${position} "${finding.context}" publishes the required context ${finding.context}; only ${allowed} may`,
  )
}

if (report.findings.length > 0) {
  const parts = []
  if (publishers > 0) parts.push(`${publishers} job(s) publish a required check context outside its own workflow`)
  if (unresolved > 0) parts.push(`${unresolved} line(s) cannot be resolved into a check-run name`)
  console.error(`reserved-contexts: ${parts.join('; ')}`)
  process.exit(1)
}

console.log(
  `reserved-contexts: ok (${report.files.length} workflow file(s), ${Object.keys(RESERVED_CONTEXTS).length} context(s) reserved)`,
)
