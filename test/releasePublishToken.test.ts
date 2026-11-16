import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const release = readFileSync(fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url)), 'utf8')

// #861: the release publish job checks the tag out with actions/checkout, runs
// `npm ci` against it and holds `contents: write`, `packages: write`,
// `id-token: write` and `attestations: write`. `actions/checkout` stores the
// workflow token in `.git/config` unless told not to, so a dependency lifecycle
// script running during `npm ci` can read it and act with publish permissions.
//
// The workflow is read as text, like test/ciConcurrency.test.ts reads ci.yml:
// this is the file a maintainer edits, and a value the helper cannot see must
// fail instead of passing quietly.
interface JobBlock {
  name: string
  lines: string[]
}

function jobBlocks(text: string): JobBlock[] {
  const lines = text.split('\n')
  const jobsAt = lines.findIndex((line) => line === 'jobs:')
  assert.notEqual(jobsAt, -1, 'release.yml must carry a jobs: block')
  const jobs: JobBlock[] = []
  let current: JobBlock | undefined
  for (const line of lines.slice(jobsAt + 1)) {
    if (line.trim() === '') continue
    // A top-level key ends the jobs block; a two-space key starts a job.
    if (!/^\s/.test(line)) break
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (job !== null) {
      current = { name: job[1]!, lines: [] }
      jobs.push(current)
      continue
    }
    current?.lines.push(line)
  }
  assert.ok(jobs.length > 0, 'release.yml must carry at least one job')
  return jobs
}

function indentedBlock(lines: string[], header: RegExp): string[] {
  const start = lines.findIndex((line) => header.test(line))
  if (start === -1) return []
  const indent = /^\s*/.exec(lines[start]!)?.[0].length ?? 0
  const block: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && (/^\s*/.exec(line)?.[0].length ?? 0) <= indent) break
    block.push(line)
  }
  return block
}

function jobPermissions(job: JobBlock): string[] {
  const block = indentedBlock(job.lines, /^\s*permissions:\s*$/)
  return block
    .map((line) => /^\s*([a-z-]+):\s*(\S+)\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[1]!}: ${match[2]!}`)
}

function steps(job: JobBlock): string[][] {
  const start = job.lines.findIndex((line) => /^\s*steps:\s*$/.test(line))
  if (start === -1) return []
  const indent = /^\s*/.exec(job.lines[start]!)?.[0].length ?? 0
  const items: string[][] = []
  let current: string[] | undefined
  for (const line of job.lines.slice(start + 1)) {
    const lineIndent = /^\s*/.exec(line)?.[0].length ?? 0
    if (line.trim() !== '' && lineIndent <= indent) break
    if (/^\s*-\s/.test(line)) {
      current = [line]
      items.push(current)
      continue
    }
    current?.push(line)
  }
  return items
}

test('the release publish job does not leave the workflow token in .git/config', () => {
  const publish = jobBlocks(release).filter((job) => jobPermissions(job).includes('contents: write'))
  assert.ok(publish.length > 0, 'release.yml must still carry the publish job with contents: write')

  for (const job of publish) {
    const runsInstall = job.lines.some((line) => /^\s*-\s*run:\s*npm (ci|install)\b/.test(line))
    assert.ok(runsInstall, `${job.name}: this test is about the job that installs dependencies`)

    const checkouts = steps(job).filter((step) => step.some((line) => /uses:\s*actions\/checkout@/.test(line)))
    assert.ok(checkouts.length > 0, `${job.name}: the job must check the tag out`)

    for (const step of checkouts) {
      const text = step.join('\n')
      assert.match(
        text,
        /persist-credentials:\s*false/,
        `${job.name}: actions/checkout must set persist-credentials: false, or a dependency lifecycle script can read the publish token`,
      )
    }
  }
})
