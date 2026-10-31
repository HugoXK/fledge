import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTeam } from '../src/flybot/instances.js'

test('parseTeam accepts a complete repository team and rejects malformed JSON', () => {
  const team = parseTeam(JSON.stringify({ chief: 'c', lead: 'l', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo' }))
  assert.deepEqual(team, { chief: 'c', lead: 'l', product: 'p', test: 't', security: 's', reviewer: 'r', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo' })
  assert.equal(parseTeam('not json'), null)
  assert.equal(parseTeam(null), null)
  assert.equal(parseTeam('{"chief":"c"}'), null)
})
