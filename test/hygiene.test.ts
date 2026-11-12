import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const skipped = new Set(['.git', 'node_modules', 'data', 'dist'])

function backupCopies(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipped.has(entry.name)) backupCopies(join(dir, entry.name), found)
      continue
    }
    if (entry.name.endsWith('.bak')) found.push(relative(root, join(dir, entry.name)))
  }
  return found
}

test('the tree carries no stale .bak copies', () => {
  assert.deepEqual(backupCopies(root).sort(), [])
})

test('.gitignore keeps local backup copies out of the repository', () => {
  const rules = readFileSync(join(root, '.gitignore'), 'utf8').split('\n').map((line) => line.trim())
  assert.ok(rules.includes('*.bak'), '.gitignore must ignore *.bak files')
})
