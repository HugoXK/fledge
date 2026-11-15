#!/usr/bin/env node
// Write the change flags the workflow uses to skip an inapplicable gate.
//
//   node scripts/ci-changes.mjs --from-file /tmp/changed-paths.txt
//   node scripts/ci-changes.mjs --all
//
// The result is written to stdout as JSON and, when `GITHUB_OUTPUT` is set, as
// one `key=value` line per flag for the `changes` job's outputs. `--all` is the
// non-pull-request path: a push, schedule or manual run verifies the whole tree,
// so no heavy job may be skipped there.

import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { allGateChanges, changedPathsForPullRequest, classifyChanges } from './lib/ciChanges.mjs'

function argument(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return ''
  return process.argv[index + 1] ?? ''
}

function fail(message) {
  console.error(`ci-changes: ${message}`)
  process.exit(2)
}

// #752: the diff that used to live in the workflow. `git diff base...head` fails
// when the pull request's base commit is not in the checkout, which is the whole
// defect: the step then ran every gate. Here the base is fetched once by sha and
// once by the base branch ref before that conservative answer is allowed — with
// its history, because a depth-limited fetch places the commit but grafts it as
// a shallow root, so the three-dot diff fails again, now with `no merge base`.
// #640: the classifier runs from the base branch tree, so the checkout that
// holds the pull request's commits is named instead of assumed to be the cwd.
const repo = argument('--repo')

function git(args) {
  const result = spawnSync('git', repo === '' ? args : ['-C', repo, ...args], { encoding: 'utf8' })
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// A shallow checkout is missing the history under the head as well, so a
// complete base still shares no ancestor with it; only unshallowing restores
// the merge base the three-dot diff needs.
function unshallow() {
  if (git(['rev-parse', '--is-shallow-repository']).stdout.trim() !== 'true') return false
  return git(['fetch', '--no-tags', '--unshallow', 'origin']).ok
}

function pathsFromGit(base, head, baseRef) {
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
      // No `--depth=1`: the base's ancestors are exactly what the three-dot diff
      // needs, and a depth-limited commit cannot supply a merge base. These
      // events check out full history, so the usual case is one round trip.
      fetchSha: (sha) => {
        if (!git(['fetch', '--no-tags', 'origin', sha]).ok) return false
        return git(['cat-file', '-e', `${sha}^{commit}`]).ok
      },
      deepen: unshallow,
      // The branch fallback fetches the ref itself, never a depth-limited copy:
      // a branch tip without its ancestors hands back the same grafted base.
      fetchRef: (ref) => {
        if (!git(['fetch', '--no-tags', 'origin', ref]).ok) return false
        unshallow()
        return true
      },
    },
  })
}

let changes
if (process.argv.includes('--all')) {
  changes = allGateChanges()
} else if (argument('--git-base') !== '') {
  const base = argument('--git-base')
  const head = argument('--git-head')
  const paths = pathsFromGit(base, head, argument('--base-ref'))
  if (paths === null) {
    console.error(`cannot diff ${base}...${head}; running every gate`)
    changes = allGateChanges()
  } else {
    changes = classifyChanges(paths)
  }
} else {
  const file = argument('--from-file')
  if (file === '') fail('usage: node scripts/ci-changes.mjs --from-file <paths.txt> | --git-base <sha> --git-head <sha> [--base-ref <ref>] | --all')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    fail(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  changes = classifyChanges(text.split('\n'))
}

const lines = Object.entries(changes).map(([key, value]) => `${key}=${String(value)}`)
const output = process.env.GITHUB_OUTPUT ?? ''
if (output !== '') appendFileSync(output, `${lines.join('\n')}\n`)
process.stdout.write(`${JSON.stringify(changes)}\n`)
