import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIssueCommand, parseMentionTrigger } from '../src/lib/issueCommands.js'

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
  // The four job verbs are part of the same vocabulary as the verbs that create
  // work: one parser, one place a command can be recognised.
  assert.equal(parseIssueCommand({ ...base, comment: { id: 9, body: '/fledge retry', author_association: 'MEMBER' } })?.command, 'retry')
  assert.equal(parseIssueCommand({ ...base, comment: { id: 10, body: '/fledge pause', author_association: 'MEMBER' } })?.command, 'pause')
  assert.equal(parseIssueCommand({ ...base, comment: { id: 11, body: '/fledge resume', author_association: 'COLLABORATOR' } })?.command, 'resume')
  assert.equal(parseIssueCommand({ ...base, comment: { id: 12, body: '/fledge cancel', author_association: 'OWNER' } })?.command, 'cancel')
  assert.equal(parseIssueCommand({ ...base, comment: { id: 13, body: '/fledge CANCEL', author_association: 'OWNER' } })?.command, 'cancel')
})

// #637: a mention is a second matcher in the same parser, not a second parser.
// It uses the same trusted set, the same created-only rule and the same comment
// id, and it recognises a plain-text name at a word boundary.
const prIssue = { ...issue, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/7' } }
const mentionOptions = { names: ['fledge'], botLogin: 'fledge-platform[bot]' }

test('a trusted mention parses beside /fledge, and only on a created comment', () => {
  const parsed = parseMentionTrigger({ action: 'created', issue: prIssue, comment: { id: 21, body: '@fledge have another look', author_association: 'MEMBER', user: { login: 'someone' } } }, mentionOptions)
  assert.deepEqual(parsed, {
    name: 'fledge',
    issueUrl: prIssue.html_url,
    number: 7,
    title: 'Fix it',
    detail: 'details',
    association: 'MEMBER',
    commentId: '21',
    onPullRequest: true,
    actor: 'someone',
  })
  assert.equal(parseMentionTrigger({ action: 'edited', issue: prIssue, comment: { id: 22, body: '@fledge again', author_association: 'MEMBER' } }, mentionOptions), null)
  assert.equal(parseMentionTrigger({ action: 'created', issue: { ...prIssue, state: 'closed' }, comment: { id: 23, body: '@fledge again', author_association: 'MEMBER' } }, mentionOptions), null)
})

test('the mention matcher keeps the trusted filter, the bot exclusion and the word boundary', () => {
  const mention = (comment: Record<string, unknown>, options = mentionOptions) =>
    parseMentionTrigger({ action: 'created', issue: prIssue, comment: { author_association: 'MEMBER', ...comment } }, options)
  // A stranger spends nothing; a collaborator does.
  assert.equal(mention({ id: 24, body: '@fledge look' , author_association: 'NONE' }), null)
  assert.equal(mention({ id: 25, body: '@fledge look', author_association: 'CONTRIBUTOR' }), null)
  assert.ok(mention({ id: 26, body: '@fledge look', author_association: 'COLLABORATOR' }))
  // The bot's own comment is not a trigger.
  assert.equal(mention({ id: 27, body: '@fledge look', user: { login: 'fledge-platform[bot]' } }), null)
  // Case-insensitive, at a word boundary, and only as a whole name.
  assert.equal(mention({ id: 28, body: '@Fledge look' })?.name, 'fledge')
  assert.equal(mention({ id: 29, body: 'mail foo@fledge.example' }), null)
  assert.equal(mention({ id: 30, body: '@fledged look' }), null)
  assert.equal(mention({ id: 31, body: 'no mention here' }), null)
  // Configured names are the matcher's vocabulary: another deployment's name
  // matches only when it is configured, and the earlier name stops matching when
  // it is not.
  assert.equal(mention({ id: 32, body: '@fledge-bot look' }, { names: ['fledge-bot'], botLogin: 'fledge-platform[bot]' })?.name, 'fledge-bot')
  assert.equal(mention({ id: 33, body: '@fledge look' }, { names: ['fledge-bot'], botLogin: 'fledge-platform[bot]' }), null)
})
