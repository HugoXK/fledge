// Import-direction and file-size gates for the source tree.
//
// The rules are intentionally small: they name the couplings that make a file
// impossible to review, not a full module system. Type-only imports are erased
// at build time and are allowed across a boundary; a runtime import is the
// coupling this gate refuses.
//
// The size rule is a ratchet. A file that predates the limit is recorded in
// `scripts/lib/arch-grandfather.json` at its current size and may not grow; once
// it is at or below the limit, its entry must be deleted.

import { posix } from 'node:path'

export const MAX_FILE_LINES = 1200

export const DEFAULT_RULES = [
  {
    id: 'views-no-store',
    from: /^src\/views\//,
    to: /^src\/db(?:\.ts|\/)/,
    runtimeOnly: true,
    reason: 'a view may import db row types but not the store; pass data in through its page model',
  },
  {
    id: 'db-no-outer',
    from: /^src\/db(?:\.ts|\/)/,
    to: /^src\/(?:app\.ts$|views\/|jobs\/)/,
    runtimeOnly: true,
    reason: 'the store must not depend on the composition root, a view or a job',
  },
  {
    id: 'jobs-no-views',
    from: /^src\/jobs\//,
    to: /^src\/views\//,
    runtimeOnly: true,
    reason: 'a job must not render; it returns data and the view describes it',
  },
  {
    id: 'views-no-jobs-service',
    from: /^src\/views\//,
    to: /^src\/jobs\//,
    runtimeOnly: true,
    allow: ['src/jobs/continuity.ts', 'src/jobs/automationHealth.ts'],
    reason: 'a view may use a pure presentation helper, not the job service or the bridge',
  },
]

const STATIC_IMPORT = /(?:^|\n)[ \t]*(import|export)[ \t]+(type[ \t]+)?([\s\S]*?)\bfrom[ \t]*['"]([^'"]+)['"]/g
const SIDE_EFFECT_IMPORT = /(?:^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g
const DYNAMIC_IMPORT = /\b(?:import|require)[ \t]*\([ \t]*['"]([^'"]+)['"]/g

function lineAt(text, index) {
  let line = 1
  for (let position = 0; position < index; position += 1) {
    if (text[position] === '\n') line += 1
  }
  return line
}

function keywordOffset(statement) {
  const match = /\b(?:import|export)\b/.exec(statement)
  return match === null ? 0 : match.index
}

function allSpecifiersAreTypes(clause) {
  const trimmed = clause.trim()
  if (!trimmed.startsWith('{')) return false
  const end = trimmed.lastIndexOf('}')
  if (end === -1) return false
  const parts = trimmed
    .slice(1, end)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  return parts.length > 0 && parts.every((part) => /^type\s+/.test(part))
}

export function parseImports(content) {
  const imports = []
  const seen = new Set()

  for (const match of content.matchAll(STATIC_IMPORT)) {
    const specifier = match[4] ?? ''
    const prefix = match[2] ?? ''
    const clause = match[3] ?? ''
    const raw = match[0] ?? ''
    const line = lineAt(content, (match.index ?? 0) + keywordOffset(raw))
    const key = `${String(line)}:${specifier}`
    if (seen.has(key)) continue
    seen.add(key)
    imports.push({ line, specifier, typeOnly: prefix !== '' || allSpecifiersAreTypes(clause) })
  }

  for (const match of content.matchAll(SIDE_EFFECT_IMPORT)) {
    const specifier = match[1] ?? ''
    const raw = match[0] ?? ''
    const line = lineAt(content, (match.index ?? 0) + keywordOffset(raw))
    const key = `${String(line)}:${specifier}`
    if (seen.has(key)) continue
    seen.add(key)
    imports.push({ line, specifier, typeOnly: false })
  }

  for (const match of content.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[1] ?? ''
    const raw = match[0] ?? ''
    const line = lineAt(content, (match.index ?? 0) + keywordOffset(raw))
    const key = `${String(line)}:${specifier}`
    if (seen.has(key)) continue
    seen.add(key)
    imports.push({ line, specifier, typeOnly: false })
  }

  return imports.sort((left, right) => left.line - right.line)
}

function resolveSpecifier(fromPath, specifier, known) {
  if (!specifier.startsWith('.')) return null
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  const candidates = [base]
  if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`)
  if (base.endsWith('.mjs')) candidates.push(`${base.slice(0, -4)}.ts`)
  if (posix.extname(base) === '') candidates.push(`${base}.ts`, `${base}/index.ts`)
  const resolved = candidates.find((candidate) => known.has(candidate))
  if (resolved !== undefined) return resolved
  // A file the caller did not include still has a conventional target. Judge it
  // rather than silently ignoring a rule the path clearly crosses; the real
  // gate reads every `src/` file, so this only affects a focused test.
  if (base.endsWith('.js')) return `${base.slice(0, -3)}.ts`
  if (base.endsWith('.mjs')) return `${base.slice(0, -4)}.ts`
  return null
}

export function checkImports({ files, rules = DEFAULT_RULES }) {
  const known = new Set(files.map((file) => file.path))
  const violations = []
  for (const file of files) {
    for (const parsed of parseImports(file.content)) {
      const target = resolveSpecifier(file.path, parsed.specifier, known)
      if (target === null) continue
      for (const rule of rules) {
        if (!rule.from.test(file.path) || !rule.to.test(target)) continue
        if (Array.isArray(rule.allow) && rule.allow.includes(target)) continue
        if (rule.runtimeOnly === true && parsed.typeOnly) continue
        violations.push({
          file: file.path,
          line: parsed.line,
          rule: rule.id,
          reason: rule.reason,
        })
      }
    }
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
}

export function lineCount(content) {
  if (content === '') return 0
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
}

export function checkFileSizes({ files, grandfather = {}, maxLines = MAX_FILE_LINES }) {
  const violations = []
  for (const file of files) {
    const lines = lineCount(file.content)
    if (Object.prototype.hasOwnProperty.call(grandfather, file.path)) {
      const recorded = Number(grandfather[file.path])
      if (lines > recorded) {
        violations.push({
          file: file.path,
          line: 1,
          rule: 'grandfathered-growth',
          reason: `${String(lines)} lines, above its recorded ${String(recorded)}; split the file instead of raising the entry`,
        })
      } else if (lines <= maxLines) {
        violations.push({
          file: file.path,
          line: 1,
          rule: 'stale-grandfather',
          reason: `${String(lines)} lines, at or below the ${String(maxLines)}-line limit; remove the entry from arch-grandfather.json`,
        })
      }
      continue
    }
    if (lines > maxLines) {
      violations.push({
        file: file.path,
        line: 1,
        rule: 'file-too-large',
        reason: `${String(lines)} lines, over the ${String(maxLines)}-line limit`,
      })
    }
  }
  return violations.sort((left, right) => left.file.localeCompare(right.file))
}

export function checkArchitecture({ files, grandfather = {}, maxLines = MAX_FILE_LINES, rules = DEFAULT_RULES }) {
  const imports = files.reduce((total, file) => total + parseImports(file.content).length, 0)
  const violations = [...checkImports({ files, rules }), ...checkFileSizes({ files, grandfather, maxLines })]
  return {
    violations,
    checked: {
      files: files.length,
      imports,
      grandfathered: files.filter((file) => Object.prototype.hasOwnProperty.call(grandfather, file.path)).length,
    },
  }
}
