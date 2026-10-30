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

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'changelog.d'
const CHANGELOG = 'CHANGELOG.md'
const KINDS = ['added', 'changed', 'deprecated', 'removed', 'fixed', 'security']
const TITLES = { added: 'Added', changed: 'Changed', deprecated: 'Deprecated', removed: 'Removed', fixed: 'Fixed', security: 'Security' }
const NAME = /^([a-z0-9][a-z0-9._-]*)\.(added|changed|deprecated|removed|fixed|security)\.md$/

function fragments() {
  if (!existsSync(DIR)) return []
  return readdirSync(DIR)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .sort()
    .map((name) => {
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
  console.log(`changelog: released ${version} (${list.length} fragments)`)
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
