#!/usr/bin/env node
// Runs the template-injection checker over the real workflow tree. The gate is
// this script's exit code: one expression inside a `run:` body that the
// allowlist does not name fails the job, and so does an allowlist that cannot
// be read (fail closed).
import { readAllowlist, scanWorkflows } from './lib/workflow-injection.mjs'

const directory = '.github/workflows'

let allowlist
try {
  allowlist = readAllowlist()
} catch (error) {
  console.error(`workflow-injection: cannot read the allowlist: ${error.message}`)
  process.exit(1)
}

const report = scanWorkflows(directory, allowlist)

for (const finding of report.findings) {
  console.error(
    `${finding.file}:${finding.line}: expression inside a run: block: \${{ ${finding.expression} }}`,
  )
  console.error('  move it to an env: entry and read "$VAR", or name it in the allowlist with a reason')
}

if (report.findings.length > 0) {
  console.error(`workflow-injection: ${report.findings.length} interpolation(s) reach a shell script`)
  process.exit(1)
}

console.log(
  `workflow-injection: ok (${report.files.length} workflow file(s), ${allowlist.length} allowlisted expression(s))`,
)
