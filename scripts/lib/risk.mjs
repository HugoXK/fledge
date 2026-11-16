import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const RULES_FILE = join('.github', 'agent', 'risk-rules.json')

export function loadRules(path = RULES_FILE) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function globToRegExp(pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  out += '$'
  return new RegExp(out)
}

const cache = new Map()
export function matchesPath(path, pattern) {
  let re = cache.get(pattern)
  if (re === undefined) {
    re = globToRegExp(pattern)
    cache.set(pattern, re)
  }
  return re.test(path)
}
const matches = matchesPath

const TIERS = ['T3', 'T2', 'T1', 'T0']
// Lower index is stricter. `AGENTS.md` promises that a path no rule names is
// T2, never silently T0/T1, so an unnamed path takes `unknownPathTier`.
const TIER_RANK = new Map(TIERS.map((tier, index) => [tier, index]))

function tierOfFile(file, rules) {
  for (const tier of TIERS) {
    const config = rules.tiers?.[tier]
    if (config === undefined) continue
    if ((config.paths ?? []).some((pattern) => matches(file, pattern))) return tier
  }
  return rules.unknownPathTier ?? 'T2'
}

// The tier is a property of every changed file, and the strictest one wins: the
// old loop returned the first tier in which any single file matched, so one
// docs file in a mixed diff exempted the rest of the change as T0. The returned
// `files` still names the files that justify the winning tier, so the report
// keeps its per-tier listing; only the decision stops coming from the first one.
export function tierForFiles(files, rules = loadRules()) {
  if (files.length === 0) return { tier: rules.unknownPathTier ?? 'T2', basis: 'no files', files: [] }
  const perFile = files.map((file) => ({ file, tier: tierOfFile(file, rules) }))
  let winner = perFile[0]
  for (const entry of perFile.slice(1)) {
    if ((TIER_RANK.get(entry.tier) ?? TIERS.length) < (TIER_RANK.get(winner.tier) ?? TIERS.length)) winner = entry
  }
  return { tier: winner.tier, basis: winner.file, files: perFile.filter((entry) => entry.tier === winner.tier).map((entry) => entry.file) }
}

// #869: a tier can be raised by what a diff does to a file, not only by the
// path it touches. A test-only change that deletes an assertion keeps the suite
// green and coverage flat, so the path rule alone said "no PASS needed" while the
// review that would have caught it never happened. The rules carry the shapes
// that raise the tier, and both readers (the CI job over `git diff`, the gates
// over the pull-request file list and its patches) go through this one function.
const UNIFIED_LINE = /^diff --git a\/(.+) b\/(.+)$/

/** Split a unified diff into one patch per file, keyed by the new path. */
export function patchesByFile(diffText) {
  const patches = new Map()
  let current = null
  for (const line of String(diffText).split('\n')) {
    const header = UNIFIED_LINE.exec(line)
    if (header !== null) {
      current = header[2]
      patches.set(current, [])
      continue
    }
    if (current !== null) patches.get(current).push(line)
  }
  return patches
}

/** The removed and added lines of one file's patch, ignoring the header lines. */
export function linesOfPatch(patch) {
  const removed = []
  const added = []
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++')) continue
    if (line.startsWith('-')) removed.push(line.slice(1))
    else if (line.startsWith('+')) added.push(line.slice(1))
  }
  return { removed, added }
}

function stricter(a, b) {
  return (TIER_RANK.get(b) ?? TIERS.length) < (TIER_RANK.get(a) ?? TIERS.length) ? b : a
}

/**
 * The tier of a change, where a change is `{ path, patch }` and `patch` may be
 * absent when the caller cannot read it (a binary file, or a pull-request file
 * the API returned without one). A missing patch cannot raise the tier: nothing
 * may be inferred from lines nobody read.
 */
export function tierForChanges(changes, rules = loadRules()) {
  const result = tierForFiles(changes.map((change) => change.path), rules)
  let tier = result.tier
  let basis = result.basis
  for (const change of changes) {
    if (change.patch === undefined || change.patch === null) continue
    const { removed, added } = linesOfPatch(change.patch)
    for (const rule of rules.escalations ?? []) {
      const to = String(rule.to ?? 'T2')
      if (!(rule.paths ?? []).some((pattern) => matches(change.path, pattern))) continue
      const hitRemoved = (rule.removed ?? []).find((pattern) => removed.some((line) => new RegExp(pattern).test(line)))
      const hitAdded = (rule.added ?? []).find((pattern) => added.some((line) => new RegExp(pattern).test(line)))
      const hit = hitRemoved ?? hitAdded
      if (hit === undefined) continue
      const next = stricter(tier, to)
      if (next !== tier) {
        tier = next
        basis = `${change.path} (${hitRemoved === undefined ? 'added' : 'removed'} ${hit})`
      }
    }
  }
  return { ...result, tier, basis }
}

export function classify(files, diffText = '', rules = loadRules()) {
  const patches = patchesByFile(diffText)
  const result = tierForChanges(files.map((file) => ({ path: file, patch: patches.get(file)?.join('\n') })), rules)
  if (result.tier !== 'T3') {
    const t3 = rules.tiers?.T3
    const hit = (t3?.diffPatterns ?? []).find((pattern) => new RegExp(pattern).test(diffText))
    if (hit !== undefined) return { ...result, tier: 'T3', basis: `diff pattern ${hit}` }
  }
  return result
}

export function limitsFor(tier, rules = loadRules()) {
  return rules.limits?.[tier] ?? null
}

// Which ref the tier is measured against. `merge_group` used to fall into the
// push branch and diff `HEAD~1` — the queue's synthetic merge commit — so the
// report described whatever the last commit happened to touch instead of the
// pull request. `fetch` names what has to be fetched before the ref can be
// diffed; an empty string means it is already local.
export function chooseBase(eventName, event = {}) {
  if (eventName === 'pull_request') {
    const ref = String(event.pull_request?.base?.ref ?? 'main')
    return { ref: `origin/${ref}`, fetch: ref }
  }
  if (eventName === 'merge_group') {
    const branch = String(event.merge_group?.base_ref ?? 'refs/heads/main').replace(/^refs\/heads\//, '')
    const sha = String(event.merge_group?.base_sha ?? '')
    if (sha !== '') return { ref: sha, fetch: `refs/heads/${branch}` }
    return { ref: `origin/${branch}`, fetch: branch }
  }
  // Only a real push has a "previous commit on this branch" to measure. A
  // scheduled or manual run gates no merge, but it must not report a tier from
  // one commit either: measure the branch against the default branch instead.
  if (eventName === 'push') return { ref: 'HEAD~1', fetch: '' }
  const branch = String(event.repository?.default_branch ?? 'main')
  return { ref: `origin/${branch}`, fetch: branch }
}
