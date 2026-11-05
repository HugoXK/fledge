import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIssueCommand } from '../src/lib/issueCommands.js'

const issue = { number: 7, html_url: 'https://github.com/o/r/issues/7', title: 'Fix it', body: 'details' }
const base = { action: 'created', issue }

test('issue commands parse only from allowed collaborators and known commands', () => {
  assert.deepEqual(parseIssueCommand({ ...base, comment: { id: 1, body: '/fledge status', author_association: 'MEMBER' } }), {
    command: 'status', issueUrl: issue.html_url, number: 7, title: 'Fix it', detail: 'details', association: 'MEMBER', commentId: '1',
  })
  assert.equal(parseIssueCommand({ ...base, comment: { id: 2, body: '/fledge plan', author_association: 'MEMBER' } })?.command, 'plan')
  assert.equal(parseIssueCommand({ ...base, comment: { id: 3, body: '/fledge fix', author_association: 'COLLABORATOR' } })?.command, 'fix')
  assert.equal(parseIssueCommand({ ...base, comment: { id: 4, body: '/fledge approve', author_association: 'OWNER' } })?.command, 'approve')
  assert.equal(parseIssueCommand({ ...base, comment: { id: 5, body: '/fledge', author_association: 'OWNER' } })?.command, 'status')
  assert.equal(parseIssueCommand({ ...base, comment: { id: 6, body: '/fledge status', author_association: 'CONTRIBUTOR' } }), null)
  assert.equal(parseIssueCommand({ ...base, comment: { id: 7, body: '/fledge nope', author_association: 'OWNER' } }), null)
  assert.equal(parseIssueCommand({ ...base, action: 'edited', comment: { id: 8, body: '/fledge status', author_association: 'OWNER' } }), null)
})
