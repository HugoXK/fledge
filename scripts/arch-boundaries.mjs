#!/usr/bin/env node
// Enforce the import-direction and file-size rules in `src/`.
//
//   npm run arch:check
//
// Reads the tree, not a git diff: the gate is about the shape the next reader
// sees, not only the lines this pull request touched.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { checkArchitecture } from './lib/arch-boundaries.mjs'

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) walk(absolute, out)
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(absolute)
  }
  return out
}

const root = process.cwd()
const sourceRoot = join(root, 'src')
if (!existsSync(sourceRoot)) {
  console.error(`arch: no src/ directory under ${root}`)
  process.exit(1)
}

const files = walk(sourceRoot)
  .map((absolute) => ({
    path: relative(root, absolute).replaceAll('\\', '/'),
    content: readFileSync(absolute, 'utf8'),
  }))
  .sort((left, right) => left.path.localeCompare(right.path))

const grandfatherPath = join(root, 'scripts/lib/arch-grandfather.json')
const grandfather = existsSync(grandfatherPath)
  ? JSON.parse(readFileSync(grandfatherPath, 'utf8'))
  : {}

const result = checkArchitecture({ files, grandfather })
for (const violation of result.violations) {
  console.error(`${violation.file}:${String(violation.line)} ${violation.rule}: ${violation.reason}`)
}
if (result.violations.length > 0) {
  console.error(`arch: ${String(result.violations.length)} violation(s)`)
  process.exit(1)
}
console.log(
  `arch: ${String(result.checked.files)} files, ${String(result.checked.imports)} imports, ${String(result.checked.grandfathered)} grandfathered`,
)
