import test from 'node:test'
import assert from 'node:assert/strict'
import { observedAttribution, observedRoles } from '../src/lib/teamStats.js'

test('observed attribution only includes roles with actual calls', () => {
  const leadOnly = observedAttribution([{ role: 'lead', calls: 4 }, { role: 'dev1', calls: 0 }, { role: 'test', calls: 0 }])
  assert.deepEqual(leadOnly, { claimedBy: 'Lead' })
  const full = observedAttribution([{ role: 'lead', calls: 1 }, { role: 'product', calls: 2 }, { role: 'dev1', calls: 3 }, { role: 'test', calls: 4 }, { role: 'reviewer', calls: 5 }])
  assert.deepEqual(full, { claimedBy: 'Lead', writtenBy: 'Product', implementedBy: 'Dev-1', testedBy: 'Test', reviewedBy: 'Reviewer' })
  assert.deepEqual(observedRoles([{ role: 'lead', calls: 1 }, { role: 'dev1', calls: 0 }]), ['lead'])
  assert.equal(observedAttribution([{ role: 'lead', calls: 0 }]), null)
})
