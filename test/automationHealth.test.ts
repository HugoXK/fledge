import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decideNextJob, type SchedulerState } from '../src/jobs/continuity.js'
import {
  automationHealth,
  clearIdleWithWork,
  readySinceMs,
  recordBlockedDispatch,
  recordDispatched,
} from '../src/jobs/automationHealth.js'
import { metricsSnapshot, renderMetrics, resetMetrics, setGauge } from '../src/lib/metrics.js'
import { automationHealthCard } from '../src/views/pages.js'

const root = fileURLToPath(new URL('..', import.meta.url))

function state(overrides: Partial<SchedulerState> = {}): SchedulerState {
  const now = Date.parse('2026-11-16T12:00:00.000Z')
  return {
    repo: {
      id: 'repo_1',
      owner: 'octo',
      name: 'demo',
      repo_role: 'maintainer',
      interval_minutes: 60,
    } as SchedulerState['repo'],
    now,
    lastRunAt: null,
    intervalMinutes: 15,
    lastDurationMs: null,
    failureStreak: 0,
    openWork: [
      {
        id: 'work_1',
        repo_id: 'repo_1',
        state: 'proposed',
        priority: 1,
        created_at: '2026-11-16T11:00:00.000Z',
        pr_url: null,
      } as SchedulerState['openWork'][number],
    ],
    reviewerEnabled: false,
    reviewDue: false,
    ...overrides,
  }
}

test('a not-due repository names the cooldown it waits for, and a failing one names the backoff', async () => {
  const cooling = await decideNextJob(state({ lastRunAt: '2026-11-16T11:59:30.000Z' }))
  assert.equal(cooling.kind, 'none')
  if (cooling.kind !== 'none' || cooling.reason !== 'not due') throw new Error('expected a blocked decision')
  assert.equal(cooling.blockedBy, 'cooldown')
  assert.equal(cooling.readyAt, Date.parse('2026-11-16T11:59:30.000Z'))

  const failing = await decideNextJob(state({ lastRunAt: '2026-11-16T11:59:30.000Z', failureStreak: 2 }))
  assert.equal(failing.kind, 'none')
  if (failing.kind !== 'none' || failing.reason !== 'not due') throw new Error('expected a blocked decision')
  assert.equal(failing.blockedBy, 'failure_backoff')

  // A failure that is not yet backing off is still the plain cooldown, because
  // `isDue` only multiplies the wait from the second consecutive failure.
  const oneFailure = await decideNextJob(state({ lastRunAt: '2026-11-16T11:59:30.000Z', failureStreak: 1 }))
  if (oneFailure.kind !== 'none' || oneFailure.reason !== 'not due') throw new Error('expected a blocked decision')
  assert.equal(oneFailure.blockedBy, 'cooldown')
})

test('readySince is the later of the oldest ready item and the last run', () => {
  const created = '2026-11-16T10:00:00.000Z'
  assert.equal(readySinceMs({ workCreatedAt: [created], lastRunAt: null }), Date.parse(created))
  // A run after the item was created restarts the wait: the item was not idle
  // while the repository was busy with it.
  assert.equal(readySinceMs({ workCreatedAt: [created], lastRunAt: '2026-11-16T11:45:00.000Z' }), Date.parse('2026-11-16T11:45:00.000Z'))
  // Two items: the wait starts at the oldest one.
  assert.equal(
    readySinceMs({ workCreatedAt: ['2026-11-16T11:30:00.000Z', created], lastRunAt: null }),
    Date.parse(created),
  )
  assert.equal(readySinceMs({ workCreatedAt: [], lastRunAt: null }), null)
})

test('a blocked decision records its reason and the idle-with-work age', () => {
  resetMetrics()
  const now = Date.parse('2026-11-16T12:00:00.000Z')
  recordBlockedDispatch({ reason: 'cooldown', repo: { owner: 'octo', name: 'demo' }, readyAt: now - 20 * 60_000, now })

  const snapshot = metricsSnapshot()
  const blocked = snapshot.counters.find((entry) => entry.name === 'fledge_automation_blocked_total')
  assert.ok(blocked, 'the blocked counter must be recorded')
  assert.equal(blocked.labels.reason, 'cooldown')
  assert.equal(blocked.value, 1)

  const idle = snapshot.gauges.find((entry) => entry.name === 'fledge_automation_idle_with_work_seconds')
  assert.ok(idle, 'a cooldown block is idle-with-work and must publish an age')
  assert.equal(idle.labels.repo, 'octo/demo')
  assert.equal(idle.value, 1200)

  // Work starting clears the age rather than leaving the last reading behind.
  recordDispatched({ repo: { owner: 'octo', name: 'demo' }, kind: 'iterate', readyAt: now - 1_000, now })
  const after = metricsSnapshot()
  assert.equal(after.gauges.some((entry) => entry.name === 'fledge_automation_idle_with_work_seconds'), false)
  const latency = after.histograms.find((entry) => entry.name === 'fledge_automation_dispatch_latency_seconds')
  assert.ok(latency, 'a dispatch must be measured, not only the blocks')
  assert.equal(latency.count, 1)
  // Recorded in seconds, with the registry's shared bucket list; the card turns
  // it back into milliseconds for display.
  assert.equal(latency.sum, 1)
})

test('a block that is not the cooldown does not leave a stale idle age behind', () => {
  resetMetrics()
  const now = Date.parse('2026-11-16T12:00:00.000Z')
  const repo = { owner: 'octo', name: 'demo' }
  recordBlockedDispatch({ reason: 'cooldown', repo, readyAt: now - 20 * 60_000, now })
  assert.equal(metricsSnapshot().gauges.some((entry) => entry.name === 'fledge_automation_idle_with_work_seconds'), true)
  // The repository is not idle any more: a job is running for it.
  recordBlockedDispatch({ reason: 'active_job', repo, readyAt: now - 20 * 60_000, now })
  assert.equal(metricsSnapshot().gauges.some((entry) => entry.name === 'fledge_automation_idle_with_work_seconds'), false)
  clearIdleWithWork(repo)
})

test('the summary reads the three numbers off the same registry, and says nothing when unmeasured', () => {
  resetMetrics()
  assert.deepEqual(automationHealth(), {
    idleWithWork: [],
    queueDepth: null,
    activeJobs: null,
    dispatchLatencyMs: null,
    dispatchSamples: 0,
  })

  const now = Date.parse('2026-11-16T12:00:00.000Z')
  recordBlockedDispatch({ reason: 'failure_backoff', repo: { owner: 'octo', name: 'demo' }, readyAt: now - 90_000, now })
  recordDispatched({ repo: { owner: 'octo', name: 'other' }, kind: 'iterate', readyAt: now - 4_000, now })
  recordDispatched({ repo: { owner: 'octo', name: 'other' }, kind: 'iterate', readyAt: now - 2_000, now })
  setGauge('fledge_queue_depth', 3)
  setGauge('fledge_jobs_active', 1)

  const summary = automationHealth()
  assert.deepEqual(summary.idleWithWork, [{ repo: 'octo/demo', seconds: 90 }])
  assert.equal(summary.queueDepth, 3)
  assert.equal(summary.activeJobs, 1)
  assert.equal(summary.dispatchLatencyMs, 3000)
  assert.equal(summary.dispatchSamples, 2)
})

test('the card names the three numbers in both languages and has an empty state', () => {
  const en = automationHealthCard('en', {
    idleWithWork: [{ repo: 'octo/demo', seconds: 1200 }],
    queueDepth: 3,
    activeJobs: 1,
    dispatchLatencyMs: 4500,
    dispatchSamples: 7,
  }, 30)
  assert.match(en, /Automation health/)
  assert.match(en, /1 repository with ready work/)
  assert.match(en, /4\.5 s/)
  assert.match(en, />3</) // queue depth
  assert.match(en, /30 minutes/)

  const zh = automationHealthCard('zh', {
    idleWithWork: [],
    queueDepth: 0,
    activeJobs: 0,
    dispatchLatencyMs: null,
    dispatchSamples: 0,
  }, 30)
  assert.match(zh, /自动化健康/)
  assert.match(zh, /还没有测量/)
  assert.doesNotMatch(zh, /Automation health/)
  assert.match(zh, /30 分钟/)
})

test('the metrics endpoint carries no work-item title and no free-form label', () => {
  resetMetrics()
  const now = Date.parse('2026-11-16T12:00:00.000Z')
  recordBlockedDispatch({ reason: 'quota', repo: { owner: 'octo', name: 'demo' }, readyAt: now - 60_000, now })
  recordDispatched({ repo: { owner: 'octo', name: 'demo' }, kind: 'iterate', readyAt: now - 60_000, now })
  const text = renderMetrics()
  assert.doesNotMatch(text, /SECRET-TITLE-807/)
  for (const line of text.split('\n')) {
    if (!line.startsWith('fledge_automation_')) continue
    const labels = /{(.*)}/.exec(line)?.[1] ?? ''
    for (const pair of labels.split(',').filter((entry) => entry !== '')) {
      assert.match(pair, /^(repo|kind|reason|le)="/, `unexpected metric label: ${pair}`)
    }
  }
})

test('the dispatch-latency alert rule pages on a series the code really records', () => {
  resetMetrics()
  const now = Date.parse('2026-11-16T12:00:00.000Z')
  recordDispatched({ repo: { owner: 'octo', name: 'demo' }, kind: 'iterate', readyAt: now - 5_000, now })
  const rendered = renderMetrics()
  const rules = readFileSync(`${root}/deploy/prometheus/fledge-alerts.yml`, 'utf8')
  const block = /- alert: FledgeDispatchLatencyHigh[\s\S]*?(?=\n\s*- alert:|\s*$)/.exec(rules)
  assert.ok(block, 'deploy/prometheus/fledge-alerts.yml must page on dispatch latency')
  const named = new Set([...block[0].matchAll(/fledge_[a-z0-9_]+/g)].map((match) => match[0]))
  assert.ok(named.size > 0, 'the rule must name the series it reads')
  for (const name of named) {
    assert.match(rendered, new RegExp(`^${name}(_bucket)?[{ ]`, 'm'), `the rule names ${name}, which the code does not record`)
  }
})
