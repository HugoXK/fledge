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
for (const finding of gates.findings) {
  console.error(`${finding.file}:${finding.line}: job ${finding.job} holds actions: write on ${finding.event} without testing author_association; add contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), ${'{expected}'}) to its if:`)
}

if (gates.findings.length > 0) {
  console.error(`action-pins: ${gates.findings.length} privileged job(s) are reachable by a stranger`)
  process.exit(1)
}

console.log(`action-pins: ok (${report.checked} pinned references across ${report.files.length} workflow files; ${gates.checked} actions: write job(s) gated on the actor)`)
