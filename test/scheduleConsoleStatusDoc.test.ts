import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Store } from '../src/db.js'
import { scheduleConsole } from '../src/schedules/console.js'
import { makeUser } from './helpers.js'

// #1076: `ScheduleConsoleState.status` documents what the field means, so it has
// to answer the same thing the console answers. #1051/#1067 made `nextAt` null
// for a paused row while the comment above `status` still promised the planner's
// instant; a reader of this file would believe the opposite of the code that
// fills it. The console's own answer is the ground truth here, and the comment is
// then held to it, so a future change to either one breaks this test instead of
// silently re-opening the disagreement.

const SOURCE = readFileSync(new URL('../src/schedules/console.ts', import.meta.url), 'utf8')
const NOW = Date.parse('2026-11-16T00:00:00Z')

function docCommentAbove(declaration: string): string {
  const at = SOURCE.indexOf(declaration)
  assert.ok(at > 0, `the field declaration \`${declaration.trim()}\` is in the source`)
  const start = SOURCE.lastIndexOf('/**', at)
  const end = SOURCE.lastIndexOf('*/', at)
  assert.ok(start >= 0 && end > start, `the field \`${declaration.trim()}\` carries a doc comment`)
  return SOURCE.slice(start, end + 2)
}

test('a paused schedule answers no next instant, and the status doc says so', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'status-doc-owner', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_status_doc', userId: user.id, owner: 'o', name: 'status-doc',
      defaultBranch: 'main', tokenEnc: 'x', permission: 'admin',
      repoRole: 'maintainer', goal: 'fix bugs', autoIterate: true, intervalMinutes: 1440,
    })
    const row = store.saveSchedule({ id: 'sch_status_doc', repoId: repo.id, kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })
    const noJobs = (): string | null => null

    const active = scheduleConsole({ repoId: repo.id, row, occurrences: [], now: NOW, jobStatus: noJobs })
    assert.equal(active.status, 'active')
    assert.notEqual(active.nextAt, null, 'an active schedule still answers a next instant')

    store.setScheduleStatus(repo.id, 'paused', NOW)
    const paused = scheduleConsole({ repoId: repo.id, row: store.scheduleForRepo(repo.id), occurrences: [], now: NOW, jobStatus: noJobs })
    assert.equal(paused.status, 'paused')
    assert.equal(paused.nextAt, null, 'the console answers no next instant for a paused schedule')

    const doc = docCommentAbove("status: 'none' | 'active' | 'paused'")
    assert.doesNotMatch(
      doc,
      /still answers\s+`?nextAt`?/,
      'the status doc must not promise a next instant that a paused schedule does not answer',
    )
    assert.match(doc, /\bnull\b/, 'the status doc names the null the console actually answers for a paused schedule')
    assert.match(doc, /paused/i, 'the status doc keeps naming the paused case it describes')
  } finally {
    store.close()
  }
})
