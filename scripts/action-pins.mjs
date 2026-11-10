#!/usr/bin/env node
// Supply-chain gate 1, wired into CI: scan the real workflow tree and fail the
// job on any action reference that is not a 40-hex pin with its tag comment.
import { scanWorkflows } from './lib/action-pins.mjs'

const directory = '.github/workflows'
const report = scanWorkflows(directory)

for (const finding of report.findings) {
  const hint =
    finding.problem === 'not-pinned'
      ? 'pin it to a 40-character commit sha and keep the tag as a trailing comment'
      : 'add the tag it was pinned from as a trailing comment'
  console.error(`${finding.file}:${finding.line}: ${finding.value}: ${hint}`)
}

if (report.findings.length > 0) {
  console.error(`action-pins: ${report.findings.length} action reference(s) are not pinned`)
  process.exit(1)
}

console.log(`action-pins: ok (${report.checked} pinned references across ${report.files.length} workflow files)`)
