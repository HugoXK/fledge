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

export function tierForFiles(files, rules = loadRules()) {
  const tiers = ['T3', 'T2', 'T1', 'T0']
  for (const tier of tiers) {
    const config = rules.tiers?.[tier]
    if (config === undefined) continue
    for (const file of files) {
      if ((config.paths ?? []).some((pattern) => matches(file, pattern))) {
        return { tier, basis: file, files: files.filter((f) => (config.paths ?? []).some((p) => matches(f, p))) }
      }
    }
  }
  return { tier: rules.unknownPathTier ?? 'T2', basis: files[0] ?? 'no files', files }
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
