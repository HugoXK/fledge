import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { startFakeServer, readBody } from './helpers.js'
import {
  GRACE_MINUTES,
  SLOT_MARKER_PREFIX,
  decideSlotWatchdog,
  markerFor,
  slotFor,
} from '../scripts/lib/release-slot-watchdog.mjs'
import type { SlotIssue, SlotRelease, SlotRun } from '../scripts/lib/release-slot-watchdog.mjs'

const execFileAsync = promisify(execFile)
const driverScript = fileURLToPath(new URL('../scripts/release-slot-watchdog.mjs', import.meta.url))

// The slot's day window at the UTC boundary the workflow uses: 02:00Z on the
// day, 10:00 Asia/Shanghai.
const NOW = '2026-11-19T04:10:00.000Z'
const SLOT = '2026-11-19T02:00:00.000Z'
const GRACE_ENDS = '2026-11-19T03:00:00.000Z'

function release(publishedAt: string, tag = 'v0.4.2'): SlotRelease {
  return { tag_name: tag, published_at: publishedAt, html_url: `https://github.com/o/r/releases/tag/${tag}` }
}

function run(id: number, event: string, createdAt: string): SlotRun {
  return { id, event, created_at: createdAt, status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40) }
}

function issue(body: string, number = 900): SlotIssue {
  return { number, state: 'open', body }
}

// ---------------------------------------------------------------- the clock

test('the slot is the 02:00Z boundary of the current UTC day', () => {
  assert.deepEqual(slotFor(NOW), { slot: SLOT, day: '2026-11-19', graceEnds: GRACE_ENDS })
})

test('a time before the boundary still belongs to the previous slot', () => {
  assert.deepEqual(slotFor('2026-11-19T01:30:00.000Z'), {
    slot: '2026-11-18T02:00:00.000Z',
    day: '2026-11-18',
    graceEnds: '2026-11-18T03:00:00.000Z',
  })
})

test('an unreadable clock refuses instead of guessing', () => {
  assert.equal(slotFor('not-a-date'), null)
  const decision = decideSlotWatchdog({ now: 'not-a-date' })
  assert.equal(decision.action, 'invalid-clock')
})

// ------------------------------------------------------------ the decision

test('a day that shipped a release opens no card', () => {
  const decision = decideSlotWatchdog({
    now: NOW,
    releases: [release('2026-11-19T02:41:00Z')],
    runs: [run(437, 'schedule', '2026-11-19T02:00:11Z')],
    issues: [],
  })
  assert.equal(decision.action, 'shipped')
  assert.equal(decision.release?.tag, 'v0.4.2')
  assert.equal(decision.issue, undefined)
})

test('a release published before the slot does not cover the day', () => {
  // 01:17Z is the manual dispatch that produced v0.4.0 on 2026-11-19 in the
  // card's evidence; it belongs to the previous slot's day.
  const decision = decideSlotWatchdog({
    now: NOW,
    releases: [release('2026-11-19T01:17:44Z', 'v0.4.0')],
    runs: [run(43785416662, 'workflow_dispatch', '2026-11-19T01:17:44Z')],
    issues: [],
  })
  assert.equal(decision.action, 'missed')
})

test('a missed day opens exactly one card naming the day, the slot, the grace window, the runs and this card', () => {
  const decision = decideSlotWatchdog({
    now: NOW,
    releases: [],
    runs: [
      run(43785416662, 'workflow_dispatch', '2026-11-19T01:17:44Z'),
      run(43847068818, 'schedule', '2026-11-19T10:14:39Z'),
    ],
    issues: [],
  })
  assert.equal(decision.action, 'missed')
  const body = decision.issue?.body ?? ''
  assert.match(decision.issue?.title ?? '', /2026-11-19/)
  assert.match(body, /2026-11-19T02:00:00\.000Z/)
  assert.match(body, /grace window: 60 minutes/i)
  assert.match(body, /2026-11-19T03:00:00\.000Z/)
  assert.match(body, /43847068818/)
  assert.match(body, /`schedule`/)
  assert.match(body, /Refs #941/)
  assert.match(body, new RegExp(`<!-- ${SLOT_MARKER_PREFIX}:slot=2026-11-19T02:00:00\\.000Z -->`))
})

test('the card records the API Date it used instead of a host clock reading', () => {
  const decision = decideSlotWatchdog({ now: NOW, releases: [], runs: [], issues: [] })
  assert.equal(decision.action, 'missed')
  assert.match(decision.issue?.body ?? '', /API Date used: 2026-11-19T04:10:00\.000Z/)
  assert.notEqual(decision.checkedAt, undefined)
  assert.equal(decision.checkedAt, NOW)
})

test('a rerun of the same day opens no second card', () => {
  const first = decideSlotWatchdog({ now: NOW, releases: [], runs: [], issues: [] })
  const marker = markerFor(SLOT)
  const again = decideSlotWatchdog({
    now: '2026-11-19T05:10:00.000Z',
    releases: [],
    runs: [],
    issues: [issue(`${first.issue?.body ?? ''}`)],
  })
  assert.equal(again.action, 'already-open')
  assert.equal(again.existingIssueNumber, 900)
  assert.equal(again.issue, undefined)
  assert.match(marker, /2026-11-19T02:00:00\.000Z/)
})

test('a closed card for the same slot still counts as the one record', () => {
  const marker = markerFor(SLOT)
  const decision = decideSlotWatchdog({
    now: NOW,
    releases: [],
    runs: [],
    issues: [{ number: 901, state: 'closed', body: `old card\n\n${marker}\n` }],
  })
  assert.equal(decision.action, 'already-open')
  assert.equal(decision.existingIssueNumber, 901)
})

test('before the grace window ends the watchdog is silent, even with no release', () => {
  const decision = decideSlotWatchdog({ now: '2026-11-19T02:15:00.000Z', releases: [], runs: [], issues: [] })
  assert.equal(decision.action, 'too-early')
  assert.equal(decision.issue, undefined)
})

test('the grace window is the module constant and is named in the card', () => {
  assert.equal(GRACE_MINUTES, 60)
  const decision = decideSlotWatchdog({ now: NOW, releases: [], runs: [], issues: [] })
  assert.equal(decision.graceEnds, GRACE_ENDS)
})

// ------------------------------------------------- the driver, end to end

interface Recorded {
  posts: { title: string; body: string }[]
}

async function serve(recorded: Recorded, options: { releases?: SlotRelease[]; issues?: SlotIssue[]; runs?: SlotRun[]; date?: string }) {
  const served = {
    releases: options.releases ?? [],
    issues: options.issues ?? [],
    runs: options.runs ?? [],
    date: options.date ?? 'Wed, 19 Nov 2026 04:10:00 GMT',
  }
  return startFakeServer(async (request: IncomingMessage, response: ServerResponse) => {
    const url = String(request.url ?? '')
    const headers = { date: served.date }
    if (request.method === 'POST' && url === '/repos/owner/repo/issues') {
      const payload = JSON.parse((await readBody(request)).toString('utf8')) as { title: string; body: string }
      recorded.posts.push(payload)
      response.writeHead(201, { 'content-type': 'application/json', ...headers })
      response.end(JSON.stringify({ number: 1200, ...payload }))
      return
    }
    let body: unknown = null
    if (url === '/repos/owner/repo/releases?per_page=100') body = served.releases
    else if (url === '/repos/owner/repo/actions/workflows/daily-release.yml/runs?per_page=100') body = { workflow_runs: served.runs }
    else if (url.startsWith('/repos/owner/repo/issues?')) body = served.issues
    else {
      response.writeHead(404, { 'content-type': 'application/json', ...headers })
      response.end('{}')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(body))), ...headers })
    response.end(JSON.stringify(body))
  })
}

async function drive(url: string, extra: string[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [driverScript, ...extra], {
      env: {
        ...process.env,
        // A short fixture value on purpose: `npm run secret:scan` flags any
        // TOKEN assignment whose value is 16 characters or longer, and this
        // line is a test double, not a credential.
        GITHUB_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: url,
      },
      timeout: 20_000,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return { code: Number(failed.code ?? 1), stdout: String(failed.stdout ?? ''), stderr: String(failed.stderr ?? '') }
  }
}

test('the driver opens exactly one card when the day shipped nothing, and none on a rerun', async () => {
  const recorded: Recorded = { posts: [] }
  const first = await serve(recorded, { runs: [run(43847068818, 'schedule', '2026-11-19T10:14:39Z')] })
  try {
    const once = await drive(first.url)
    assert.equal(once.code, 0, once.stderr)
    assert.equal(recorded.posts.length, 1)
    assert.match(recorded.posts[0]?.body ?? '', /Refs #941/)

    // The same API now lists the card the first pass opened.
    const second = await serve(recorded, {
      issues: [{ number: 1200, state: 'open', body: recorded.posts[0]?.body ?? '' }],
    })
    try {
      const twice = await drive(second.url)
      assert.equal(twice.code, 0, twice.stderr)
      assert.equal(recorded.posts.length, 1)
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
  }
})

test('the driver posts nothing on a day that shipped, and nothing on a dry run', async () => {
  const recorded: Recorded = { posts: [] }
  const shipped = await serve(recorded, { releases: [release('2026-11-19T02:41:00Z')] })
  try {
    const result = await drive(shipped.url)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(recorded.posts.length, 0)
  } finally {
    await shipped.close()
  }

  const empty = await serve(recorded, {})
  try {
    const result = await drive(empty.url, ['--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(recorded.posts.length, 0)
    assert.match(result.stdout, /missed/)
  } finally {
    await empty.close()
  }
})

test('the driver refuses to run without an API Date and never falls back to the host clock', async () => {
  const recorded: Recorded = { posts: [] }
  const server = await startFakeServer((request: IncomingMessage, response: ServerResponse) => {
    const url = String(request.url ?? '')
    if (url === '/repos/owner/repo/releases?per_page=100') {
      // No `date` header: an unreadable answer.
      response.writeHead(200, { 'content-type': 'application/json', date: '' })
      response.end('[]')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json', date: '' })
    response.end(url.includes('runs') ? '{"workflow_runs":[]}' : '[]')
  })
  try {
    const result = await drive(server.url)
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /API Date/i)
    assert.equal(recorded.posts.length, 0)
  } finally {
    await server.close()
  }
})

test('the workflow runs the driver from the existing watchdog path with the issue write it needs', () => {
  const workflow = readFileSync('.github/workflows/ci-watchdog.yml', 'utf8')
  assert.match(workflow, /scripts\/release-slot-watchdog\.mjs/)
  assert.match(workflow, /issues: write/)
  // The card is the only write: no workflow dispatch, no tag or release call.
  assert.match(workflow, /permissions:\n(?:.|\n)*?contents: read/)
})
