#!/usr/bin/env node
// Changelog fragments for Fledge.
//
//   node scripts/changelog.mjs check
//   node scripts/changelog.mjs preview
//   node scripts/changelog.mjs release 0.1.1 --date 2026-10-31
//   node scripts/changelog.mjs notes 0.1.1
//
// A fragment is one file per user-visible change:
//   changelog.d/<issue-or-slug>.<kind>.md
// The file contains one paragraph, no heading and no leading "- ".

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fragmentNames } from './lib/changelog-fragments.mjs'
import { STATUS_FILES, STATUS_MARKERS, rewriteStatusLine } from './lib/mechanical-release.mjs'

const DIR = 'changelog.d'
const CHANGELOG = 'CHANGELOG.md'
const KINDS = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security']
const TITLES = { added: 'Added', changed: 'Changed', deprecated: 'Deprecated', removed: 'Removed', fixed: 'Fixed', security: 'Security' }
const NAME = /^([a-z0-9][a-z0-9._-]*)\.(added|changed|deprecated|removed|fixed|security)\.md$/

function fragments() {
  // Which files count as fragments is one rule, shared with the release count
  // (#548) so a release can never fold a set the nightly job measured differently.
  // This tool still treats a missing directory as nothing to fold; the release
  // count does not, because a count it could not measure must not read as zero.
  if (!existsSync(DIR)) return []
  return fragmentNames(DIR).map((name) => {
    const match = NAME.exec(name)
    return { name, kind: match?.[2], slug: match?.[1], body: readFileSync(join(DIR, name), 'utf8').trim() }
  })
}

function check() {
  const list = fragments()
  let failed = false
  for (const fragment of list) {
    if (fragment.kind === undefined) {
      console.error(`bad name: ${fragment.name} (expected <slug>.<kind>.md)`)
      failed = true
      continue
    }
    if (fragment.body === '') {
      console.error(`empty: ${fragment.name}`)
      failed = true
    }
    if (fragment.body.startsWith('- ') || fragment.body.startsWith('#')) {
      console.error(`no heading or leading "- ": ${fragment.name}`)
      failed = true
    }
  }
  if (failed) process.exit(1)
  console.log(`changelog: ${list.length} fragment(s) ok`)
}

function preview() {
  const list = fragments()
  if (list.length === 0) {
    console.log('changelog: no fragments')
    return
  }
  for (const kind of KINDS) {
    const entries = list.filter((fragment) => fragment.kind === kind)
    if (entries.length === 0) continue
    console.log(`### ${TITLES[kind]}`)
    for (const entry of entries) console.log(`- ${entry.body}`)
    console.log('')
  }
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

function bumpVersions(version, date) {
  const pkgRaw = readFileSync('package.json', 'utf8')
  const previous = String(JSON.parse(pkgRaw).version ?? '')
  if (previous === version) return
  // #348: both README status lines belong to the release tree, because the suite
  // the release pull request lands with requires them to name the version in
  // package.json. Check them before the first write, so a README this routine
  // cannot rewrite fails the run with the file named instead of leaving a
  // half-bumped tree that no green check can describe.
  const readmes = STATUS_FILES.map((file) => ({ file, marker: STATUS_MARKERS[file], text: readFileSync(file, 'utf8') }))
  for (const entry of readmes) {
    if (rewriteStatusLine(entry.text, entry.marker, version, date) === null) {
      console.error(`changelog: ${entry.file} has no status line starting with ${JSON.stringify(entry.marker)}; nothing was written`)
      process.exit(1)
    }
  }
  const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  writeFileSync('package.json', pkgRaw.replace(new RegExp(`"version":\\s*"${escaped}"`), `"version": "${version}"`))
  const lockRaw = readFileSync('package-lock.json', 'utf8')
  let seen = 0
  const next = lockRaw.replace(new RegExp(`"version":\\s*"${escaped}"`, 'g'), (match) => {
    seen += 1
    return seen <= 2 ? `"version": "${version}"` : match
  })
  writeFileSync('package-lock.json', next)
  const compose = readFileSync('docker-compose.yml', 'utf8').replace(/(image:\s*fledge:)[^\s]+/, `$1${version}`)
  writeFileSync('docker-compose.yml', compose)
  // The status lines take the version this function just wrote into package.json,
  // not the argument: one source, so a replacement that did not land cannot leave
  // the READMEs a release ahead of the file the suite compares them against.
  const written = String(JSON.parse(readFileSync('package.json', 'utf8')).version ?? '')
  for (const entry of readmes) {
    const line = rewriteStatusLine(entry.text, entry.marker, written, date)
    if (line !== null) writeFileSync(entry.file, line)
  }
}

function release() {
  const raw = process.argv[3]
  if (raw === undefined || raw === '') {
    console.error('usage: node scripts/changelog.mjs release <version> [--date YYYY-MM-DD]')
    process.exit(1)
  }
  const version = raw.replace(/^v/, '')
  const date = arg('--date', new Date().toISOString().slice(0, 10))
  const dryRun = process.argv.includes('--dry-run')
  const list = fragments()
  if (list.length === 0) {
    console.error('changelog: no fragments to release')
    process.exit(1)
  }
  const sections = []
  for (const kind of KINDS) {
    const entries = list.filter((fragment) => fragment.kind === kind)
    if (entries.length === 0) continue
    sections.push(`### ${TITLES[kind]}\n\n${entries.map((entry) => `- ${entry.body}`).join('\n')}`)
  }
  const section = `## [${version}] — ${date}\n\n${sections.join('\n\n')}\n`
  const changelog = readFileSync(CHANGELOG, 'utf8')
  const marker = '## [Unreleased]'
  if (!changelog.includes(marker)) {
    console.error(`changelog: ${CHANGELOG} has no "${marker}" section`)
    process.exit(1)
  }
  const next = changelog.replace(marker, `${marker}\n\n${section}`)
  if (dryRun) {
    console.log(next)
    return
  }
  writeFileSync(CHANGELOG, next)
  for (const fragment of list) unlinkSync(join(DIR, fragment.name))
  bumpVersions(version, date)
  console.log(`changelog: released ${version} (${list.length} fragments); versions bumped to ${version}`)
}

function notes() {
  const raw = process.argv[3]
  if (raw === undefined) {
    console.error('usage: node scripts/changelog.mjs notes <version>')
    process.exit(1)
  }
  const version = raw.replace(/^v/, '')
  const changelog = readFileSync(CHANGELOG, 'utf8')
  const start = changelog.indexOf(`## [${version}]`)
  if (start === -1) {
    console.error(`changelog: no section for ${version}`)
    process.exit(1)
  }
  const rest = changelog.slice(start)
  const next = rest.indexOf('\n## [', 3)
  console.log((next === -1 ? rest : rest.slice(0, next)).trim())
}

const command = process.argv[2]
if (command === 'check') check()
else if (command === 'preview') preview()
else if (command === 'release') release()
else if (command === 'notes') notes()
else {
  console.error('usage: node scripts/changelog.mjs check|preview|release|notes')
  process.exit(1)
}
