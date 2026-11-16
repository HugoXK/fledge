import { sha256Hex } from '../lib/secrets.js'

// #433 slice 1: a repository's development strategy as one content-addressed
// artifact. A section is keyed independently (`rules:review`, `playbook:reviewer`,
// `template:bug`, …) and its value is a reference to where the content lives — a
// repository path at a fixed blob, a console revision, a playbook fingerprint —
// never a copy of a moving path. The bundle's identity is the hash of that map,
// so the same strategy always has the same name and any change produces a new one.
//
// The frozen families are the parts a strategy must never evolve: the evaluator,
// the evidence computation, CI, the merge gate, authentication, the gateway and
// the capability checks. They are rejected where the bundle is assembled, before
// anything is evaluated or written.

const FROZEN_FAMILIES = ['evaluator', 'evidence', 'ci', 'gate', 'auth', 'gateway', 'capability'] as const

export type StrategySections = Record<string, string>

export type AssembleResult =
  | { ok: true; sections: StrategySections; hash: string }
  | { ok: false; code: 'frozen_section'; keys: string[] }

// A key is `<family>:<rest>`. The family decides the frozen rule, so
// `rules:review` is a strategy section while `ci:workflow` is not, and a frozen
// family cannot be smuggled in under a second colon (`ci:build:fast`).
export function frozenFamily(key: string): string | null {
  // A console key is `family:name` and a repository path is `family/name.md`; both
  // name the same family, and reading the head this way keeps a path from slipping
  // past the check as an ordinary rule.
  const family = (key.split(':')[0] ?? '').split('/')[0]?.trim().toLowerCase() ?? ''
  return (FROZEN_FAMILIES as readonly string[]).includes(family) ? family : null
}

// Canonical order is what makes the hash content-addressed: two callers that
// built the same map in a different order must produce the same bundle name.
export function canonicalSections(sections: StrategySections): StrategySections {
  const canonical: StrategySections = {}
  for (const key of Object.keys(sections).sort()) canonical[key] = sections[key] ?? ''
  return canonical
}

export function strategyHash(sections: StrategySections): string {
  return sha256Hex(JSON.stringify(canonicalSections(sections)))
}

export function assembleStrategy(input: { sections: StrategySections }): AssembleResult {
  const sections = canonicalSections(input.sections)
  const keys = Object.keys(sections).filter((key) => frozenFamily(key) !== null)
  if (keys.length > 0) return { ok: false, code: 'frozen_section', keys: keys.sort() }
  return { ok: true, sections, hash: strategyHash(sections) }
}

// The sentence a maintainer reads, kept next to the check so the page and the
// write path cannot describe the same refusal differently.
export function strategyRefusal(result: Extract<AssembleResult, { ok: false }>): string {
  if (result.code === 'frozen_section') {
    return `the strategy names a frozen section (${result.keys.join(', ')}); the evaluator, evidence, CI, merge gate, auth, gateway and capability checks are never evolved by a strategy`
  }
  return 'the strategy could not be assembled'
}

export type FuseResult =
  | { ok: true; sections: StrategySections }
  | { ok: false; conflicts: string[] }

// Two candidates that touch different keys fuse instead of colliding; two values
// for the same key are a conflict that names the key rather than picking a side.
export function fuseStrategies(left: StrategySections, right: StrategySections): FuseResult {
  const merged: StrategySections = { ...left }
  const conflicts: string[] = []
  for (const [key, value] of Object.entries(right)) {
    const current = merged[key]
    if (current !== undefined && current !== value) {
      conflicts.push(key)
      continue
    }
    merged[key] = value
  }
  if (conflicts.length > 0) return { ok: false, conflicts: conflicts.sort() }
  return { ok: true, sections: canonicalSections(merged) }
}

// A rule override under a frozen family is the surface a maintainer actually has,
// so its path is turned into the same key shape the frozen check reads: a file at
// `ci/workflow.md` is the `ci` family, not an ordinary rule.
export function ruleSectionKey(path: string): string {
  const trimmed = path.replace(/^\/+/, '')
  const family = frozenFamily(trimmed)
  if (family !== null) return `${family}:${trimmed.split('/').slice(1).join('/')}`
  return `rules:${trimmed.replace(/^rules\//, '')}`
}
