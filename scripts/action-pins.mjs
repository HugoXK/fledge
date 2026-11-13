#!/usr/bin/env node
// Supply-chain gate 1, wired into CI: scan the real workflow tree and fail the
// job on any action reference that is not a 40-hex pin with its tag comment.
import { scanActorGates, scanWorkflows } from './lib/action-pins.mjs'

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

// Supply-chain gate 1b, in the same required job: a job holding `actions: write`
// must test the actor's association on every event a stranger can trigger.
const gates = scanActorGates(directory)
// Each finding says what to do about it: a parse problem needs the shape fixed,
// not an association test bolted onto a job the parser never read.
function gateHint(finding) {
  switch (finding.problem) {
    case 'missing-association-gate':
      return `job ${finding.job} holds actions: write on ${finding.event} without testing author_association; add contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), <association expression for ${finding.event}>) to its if:`
    case 'unknown-event':
      return `job ${finding.job} holds actions: write on ${finding.event}, an event this gate cannot classify; test author_association for it, or add it to SAFE_EVENTS in scripts/lib/action-pins.mjs if an outside account cannot trigger it`
    case 'no-readable-trigger':
      return `job ${finding.job} holds actions: write but the workflow's on: triggers could not be read, so the job cannot be judged; name every event in a block mapping or a flow mapping`
    default:
      return `the workflow shape could not be read (${finding.problem}); this gate fails closed, so fix the shape or teach scripts/lib/action-pins.mjs the form`
  }
}
for (const finding of gates.findings) {
  console.error(`${finding.file}:${finding.line}: ${gateHint(finding)}`)
}

if (gates.findings.length > 0) {
  console.error(`action-pins: ${gates.findings.length} privileged job(s) are reachable by a stranger`)
  process.exit(1)
}

console.log(`action-pins: ok (${report.checked} pinned references across ${report.files.length} workflow files; ${gates.checked} actions: write job(s) gated on the actor)`)
