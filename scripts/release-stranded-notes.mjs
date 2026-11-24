#!/usr/bin/env node
// #1207: name the changes a release's notes were assembled too early to see.
//
//   node scripts/release-stranded-notes.mjs <tag> <notes-file>
//
// The publish job checks the tag out, and the notes were assembled when the
// release pull request was built. A fragment still present in `changelog.d/` at
// the tag is by construction a change the release carries and its notes do not
// name, so this appends one section that names each of them and writes the
// fragment names to $GITHUB_OUTPUT for the release log line on #80.
//
// An unreadable `changelog.d` (`EACCES`, `EPERM`, `ENOTDIR`, anything but
// absence) fails the step: a body that reads complete is worse than no body
// (#548). An absent `changelog.d` is not unreadable: a tree with no
// `changelog.d` answers zero names, this step exits 0, and no stranded section
// is written (#1218).

import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fragmentNames } from './lib/changelog-fragments.mjs'
import { strandedSection } from './lib/stranded-fragments.mjs'

const [, , rawTag, notesFile] = process.argv
if (rawTag === undefined || rawTag === '' || notesFile === undefined || notesFile === '') {
  console.error('usage: node scripts/release-stranded-notes.mjs <tag> <notes-file>')
  process.exit(1)
}
const tag = rawTag.startsWith('v') ? rawTag : `v${rawTag}`

// The notes the publish path already assembled are the body this section is
// appended to. An empty or missing file means the section would become a body
// that reads complete without naming the release's own changes, so it is a
// failure rather than a new file.
const notes = readFileSync(notesFile, 'utf8')
if (notes.trim() === '') {
  console.error(`release-stranded-notes: ${notesFile} is empty; refusing to write a body that omits the release's own notes`)
  process.exit(1)
}

const names = fragmentNames()
const fragments = names.map((name) => ({ name, body: readFileSync(join('changelog.d', name), 'utf8').trim() }))

if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    fragments.length === 0
      ? `${tag}: no stranded change — the notes name everything the tag carries\n`
      : `${tag}: ${fragments.length} stranded change(s), named in the notes: ${names.join(', ')}\n`,
  )
}
if (process.env.GITHUB_OUTPUT !== undefined) {
  appendFileSync(process.env.GITHUB_OUTPUT, `names=${names.join(',')}\n`)
}

if (fragments.length === 0) {
  console.log(`${tag}: no stranded change`)
  process.exit(0)
}

appendFileSync(notesFile, strandedSection(fragments))
console.log(`${tag}: ${fragments.length} stranded change(s) named in ${notesFile}: ${names.join(', ')}`)
