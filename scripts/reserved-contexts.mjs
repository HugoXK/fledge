#!/usr/bin/env node
// #963: runs the reserved-context scanner over the workflow tree. The gate is
// this script's exit code: a job that publishes a reserved check context from a
// file that is not allowed to produce it fails the job, and so does a workflow
// file that cannot be read (fail closed).
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

for (const finding of report.findings) {
  const allowed = (RESERVED_CONTEXTS[finding.context] ?? []).join(', ')
  const position = finding.kind === 'name' ? 'name:' : 'job id'
  console.error(
    `${finding.file}:${finding.line}: ${position} "${finding.context}" publishes the required context ${finding.context}; only ${allowed} may`,
  )
}

if (report.findings.length > 0) {
  console.error(`reserved-contexts: ${report.findings.length} job(s) publish a required check context outside its own workflow`)
  process.exit(1)
}

console.log(
  `reserved-contexts: ok (${report.files.length} workflow file(s), ${Object.keys(RESERVED_CONTEXTS).length} context(s) reserved)`,
)
