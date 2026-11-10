import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { checkAttribution } from '../scripts/lib/pr-body.mjs'

type Policy = { authors?: string[]; writers?: string[]; requiredPass?: string }

const shipped = JSON.parse(
  readFileSync(new URL('../.github/agent/review-policy.json', import.meta.url), 'utf8'),
) as Policy

// The list as it stood before Dev-3 and Dev-4, kept here as a fixture. `pr-lint`
// reads the policy from the base branch, so the negative half has to show the
// check reads the list it is handed rather than trusting the branch that carries
// the change.
const beforeDev3: Policy = {
  authors: ['HugoXK', 'HugoXK-bot', 'Fledge Platform Dev-1', 'Fledge Platform Dev-2'],
  writers: ['HugoXK', 'HugoXK-bot'],
  requiredPass: 'HugoXK-bot',
}

const body = (name: string): string => `Written-by: ${name}\n\nRan:\n- \`npm run check\` — pass\n\nNot run: Docker image\n`

test('the review policy pins the required PASS identity and keeps the owner as a writer', () => {
  const policy = JSON.parse(readFileSync(new URL('../.github/agent/review-policy.json', import.meta.url), 'utf8')) as {
    requiredPass?: string
    requiredPassEmail?: string
    writers?: string[]
    reviewers?: string[]
  }
  assert.equal(policy.requiredPass, 'HugoXK-bot')
  assert.equal(policy.requiredPassEmail, 'hugo2001xk@gmail.com')
  assert.deepEqual(policy.writers, ['HugoXK', 'HugoXK-bot'])
  assert.deepEqual(policy.reviewers, ['HugoXK-bot'])
})

test('a Dev-3 body and a Dev-4 body pass the shipped policy', () => {
  assert.equal(checkAttribution(body('Fledge Platform Dev-3'), shipped), null)
  assert.equal(checkAttribution(body('Fledge Platform Dev-4'), shipped), null)
})

test('the shipped authors list names every bot that may write a body', () => {
  assert.deepEqual(shipped.authors, [
    'HugoXK',
    'HugoXK-bot',
    'Fledge Platform Dev-1',
    'Fledge Platform Dev-2',
    'Fledge Platform Dev-3',
    'Fledge Platform Dev-4',
  ])
})

test('the shipped policy still rejects a name outside authors, so the list stays a whitelist', () => {
  const error = checkAttribution(body('Fledge Platform Dev-9'), shipped)
  assert.equal(typeof error, 'string')
  assert.match(String(error), /Written-by "Fledge Platform Dev-9" is not in the authors list/)
})

test('the check follows the policy it is handed: the pre-Dev-3 fixture still rejects a Dev-3 body', () => {
  assert.ok(checkAttribution(body('Fledge Platform Dev-3'), beforeDev3))
  assert.equal(checkAttribution(body('Fledge Platform Dev-2'), beforeDev3), null)
})

test('widening authors does not widen who may write a verdict', () => {
  assert.deepEqual(shipped.writers, ['HugoXK', 'HugoXK-bot'])
  assert.equal(shipped.requiredPass, 'HugoXK-bot')
})
