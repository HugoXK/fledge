import test from 'node:test'
import assert from 'node:assert/strict'
import { attributionJourney, attributionSentence, parseAttribution, parseAttributionJson } from '../src/lib/attribution.js'

test('attribution deduplicates roles and skips writtenBy when the same role implemented', () => {
  const attribution = parseAttribution({
    writtenBy: 'Dev-1',
    claimedBy: 'Lead',
    implementedBy: 'Dev-1',
    testedBy: 'Test',
    reviewedBy: 'Reviewer',
  })
  assert.deepEqual(attributionJourney(attribution), [
    { role: 'Lead', keys: ['claimedBy'] },
    { role: 'Dev-1', keys: ['implementedBy'] },
    { role: 'Test', keys: ['testedBy'] },
    { role: 'Reviewer', keys: ['reviewedBy'] },
  ])
  assert.equal(attributionSentence(attribution), 'Lead claimed · Dev-1 implemented · Test tested · Reviewer reviewed')
})

test('attribution drops empty, placeholder and "(Team)" values', () => {
  assert.equal(parseAttribution(null), null)
  assert.equal(parseAttribution({}), null)
  assert.deepEqual(parseAttribution({ claimedBy: ' Lead ', testedBy: '', unknown: 'x' }), { claimedBy: 'Lead' })
  assert.deepEqual(parseAttribution({
    writtenBy: 'not run',
    claimedBy: 'Lead (Team)',
    implementedBy: 'not run',
    testedBy: 'N/A',
    reviewedBy: 'pending',
  }), { claimedBy: 'Lead' })
  assert.equal(parseAttributionJson('not json'), null)
  assert.deepEqual(parseAttributionJson('{"implementedBy":"Dev-2"}'), { implementedBy: 'Dev-2' })
  assert.equal(attributionSentence(null), '')
  assert.equal(attributionSentence(parseAttribution({ claimedBy: 'Lead (Team)', reviewedBy: 'not run' })), 'Lead claimed')
})
