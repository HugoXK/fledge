#!/usr/bin/env node
// #640: name every gate file a pull request changes, in the job summary.
//
// The evaluators (`ci-ok`, `changes`, `risk`, `action-pins`, `workflow-lint`,
// `codeql-required`, `codeql-gate`) run from the base branch, so the pull
// request cannot edit the code that judges it. That is why this summary exists:
// the reviewer must still see that the gate itself is in the diff.
//
//   node scripts/gate-integrity.mjs --repo . --git-base <sha> --git-head <sha>
//   node scripts/gate-integrity.mjs --all      (push, schedule, manual run)
//
// An unreadable diff fails closed: a summary that says "no gate file" while the
// diff could not be read would be a blind gate, not a clean one.

import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { changedPathsForPullRequest } from './lib/ciChanges.mjs'
import { classifyGateFiles, gateSummary } from './lib/gate-integrity.mjs'

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const repo = argument('--repo', '.')

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function unshallow() {
  if (git(['rev-parse', '--is-shallow-repository']).stdout.trim() !== 'true') return false
  return git(['fetch', '--no-tags', '--unshallow', 'origin']).ok
}

function pathsFor(base, head, baseRef) {
  return changedPathsForPullRequest({
    base,
    head,
    baseRef,
    git: {
      diff: (from, to) => {
        const result = git(['diff', '--name-only', '--no-renames', `${from}...${to}`])
        if (!result.ok) return null
        return result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      },
      hasCommit: (sha) => git(['cat-file', '-e', `${sha}^{commit}`]).ok,
      fetchSha: (sha) => {
        if (!git(['fetch', '--no-tags', 'origin', sha]).ok) return false
        return git(['cat-file', '-e', `${sha}^{commit}`]).ok
      },
      deepen: unshallow,
      fetchRef: (ref) => {
        if (!git(['fetch', '--no-tags', 'origin', ref]).ok) return false
        unshallow()
        return true
      },
    },
  })
}

function writeSummary(markdown) {
  const output = process.env.GITHUB_STEP_SUMMARY ?? ''
  if (output !== '') appendFileSync(output, markdown)
  process.stdout.write(markdown)
}

if (process.argv.includes('--all')) {
  writeSummary(gateSummary([], { changed: 0 }))
  console.log('gate-integrity: ok — every path is in scope on this event')
  process.exit(0)
}

const base = argument('--git-base')
const head = argument('--git-head')
const baseRef = argument('--base-ref')
if (base === '' || head === '') {
  console.error('gate-integrity: usage: --git-base <sha> --git-head <sha> [--base-ref <ref>] | --all')
  process.exit(2)
}

const paths = pathsFor(base, head, baseRef)
if (paths === null) {
  console.error(`gate-integrity: cannot read the diff ${base}...${head}; failing closed`)
  process.exit(2)
}

const files = classifyGateFiles(paths)
writeSummary(gateSummary(files, { changed: paths.length, base }))
console.log(
  files.length === 0
    ? `gate-integrity: ok — no gate file in ${paths.length} changed path(s)`
    : `gate-integrity: ok — ${files.length} gate file(s) in ${paths.length} changed path(s): ${files.join(', ')}`,
)
