import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// #1185: the release runbook has to describe the opener's reuse refusal the way
// the opener makes it. `scripts/release-open.mjs:284-286` refuses on
// `maintainer_can_modify === true` and on nothing else, and #575 pinned the two
// accepted shapes — an omitted key and `false` — as reuses. docs/deploy.md:502-505
// states that correctly; the summary four lines above it said the opposite, so a
// reader who stopped at the summary took away the wrong rule.
//
// The sentence wraps a newline at :498/:499, so a raw line grep reads nothing even
// when the text is there. Every assertion below reads the flattened file, the way
// test/gateDocs.test.ts:22 does.

const text = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8').replace(/\s+/g, ' ')

test('the reuse summary does not name an absent readback as a refusal', () => {
  assert.ok(
    !text.includes('a flag that does not read back'),
    'docs/deploy.md must not describe a flag that does not read back as a refusal — an omitted key is a reuse (#575)',
  )
})

test('the reuse summary names the flag reading that refuses', () => {
  assert.ok(
    text.includes(
      'a head in another repository, a flag that reads back `true`, or a readback that cannot be made is a refusal rather than a reuse',
    ),
    'docs/deploy.md must name all three refusals: a head in another repository, a flag that reads back `true`, and a readback that cannot be made',
  )
})

test('the precise refusal sentence survives a rewrite of the summary', () => {
  assert.ok(
    text.includes('a readback that reports `maintainer_can_modify: true` '),
    'docs/deploy.md must keep the exact sentence that says `maintainer_can_modify: true` is the refusal',
  )
})

test('the normal same-repository value is never described as a refusal', () => {
  assert.ok(
    !text.includes('maintainer_can_modify: false'),
    'docs/deploy.md must not describe `maintainer_can_modify: false` at all — it is the normal same-repository value (#575)',
  )
})
