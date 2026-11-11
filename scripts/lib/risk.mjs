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

export function classify(files, diffText = '', rules = loadRules()) {
  const result = tierForFiles(files, rules)
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
