import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #84: the write-hygiene rules are gate text, not a memory. The files a person
// or bot reads before a write must state the same four rules, and the head query
// has to be written out so it can be run instead of recalled.

const files = ['AGENTS.md', 'docs/autonomous-dev.md']
const rules = [
  'One write session per repository.',
  'One branch, one open PR.',
  'One worktree, one writer.',
  'Dedicated ports for verification servers.',
]
const HEAD_QUERY = 'GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=open'

for (const file of files) {
  test(`${file} states the write-hygiene rules and their commands`, () => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\s+/g, ' ')
    for (const rule of rules) {
      assert.ok(text.includes(rule), `${file} does not state: ${rule}`)
    }
    assert.ok(text.includes(HEAD_QUERY), `${file} must write out the head query: ${HEAD_QUERY}`)
    assert.ok(text.includes('a port another session may use'), `${file} must keep the dedicated-port rule`)
    assert.ok(text.includes('the tree it claims to serve'), `${file} must keep the tree-match check`)
  })
}
