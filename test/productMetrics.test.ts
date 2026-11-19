import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #635 slice: the two answers the existing counts cannot give, read off the
// page a maintainer already opens, not off a second page.
function loopCell(body: string, name: string): { samples: number; value: string } | undefined {
  const match = new RegExp(`data-loop-metric="${name}" data-loop-samples="(\\d+)">([^<]*)<`).exec(body)
  return match === null ? undefined : { samples: Number(match[1]), value: (match[2] ?? '').trim() }
}

const DAY = 86_400_000
const HOUR = 3_600_000

function seedRepo(store: Store, userId: string, id: string): { repoId: string; createdAt: string } {
  store.createRepo({
    id,
    userId,
    owner: 'o',
    name: id,
    defaultBranch: 'main',
    tokenEnc: encryptSecret('token', testConfig().tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { repoId: id, createdAt: store.getRepo(id)!.created_at }
}

test('the product metrics page answers first-merge duration and ready-PR wait', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'loop-admin', superadmin: true, status: 'approved' })
    const { repoId, createdAt } = seedRepo(store, admin.id, 'repo_loop')
    // The repository's first merge lands three days after it was connected, and
    // the job that opened that PR finished one hour before the merge: the two
    // durations this slice answers, with values a wrong denominator cannot fake.
    const mergedAt = new Date(Date.parse(createdAt) + 3 * DAY).toISOString()
    const finishedAt = new Date(Date.parse(mergedAt) - HOUR).toISOString()
    store.createJob({ id: 'job_loop', repoId, userId: admin.id, trigger: 'manual', goal: 'g', callbackHash: 'cb_loop', platformTokenHash: '' })
    store.updateJob('job_loop', { status: 'succeeded', finished_at: finishedAt })
    store.createWorkItem({
      id: 'wi_loop',
      repoId,
      userId: admin.id,
      title: 'the first merged change',
      jobId: 'job_loop',
      prUrl: 'https://github.com/o/repo_loop/pull/1',
      state: 'merged',
      prState: 'merged',
      mergedAt,
    })

    const since = new Date(Date.now() - 30 * DAY).toISOString()
    const metrics = store.productMetrics(since) as unknown as {
      firstMerge?: { repositories: number; samples: number; medianMs: number | null }
      readyWait?: { samples: number; medianMs: number | null }
    }
    assert.deepEqual(metrics.firstMerge, { repositories: 1, samples: 1, medianMs: 3 * DAY })
    assert.deepEqual(metrics.readyWait, { samples: 1, medianMs: HOUR })

    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin/metrics', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.deepEqual(loopCell(page.body, 'first-merge'), { samples: 1, value: '3.0d' })
    assert.deepEqual(loopCell(page.body, 'ready-wait'), { samples: 1, value: '1.0h' })
  } finally {
    await built.close()
  }
})

test('a quiet window reports n/a for both durations, never a confident zero', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const admin = makeUser(store, { login: 'quiet-admin', superadmin: true, status: 'approved' })
    const { cookie } = sessionFor(built, admin)
    const page = await built.app.inject({ method: 'GET', url: '/admin/metrics', headers: { cookie } })
    assert.equal(page.statusCode, 200)
    assert.deepEqual(loopCell(page.body, 'first-merge'), { samples: 0, value: 'n/a' })
    assert.deepEqual(loopCell(page.body, 'ready-wait'), { samples: 0, value: 'n/a' })
  } finally {
    await built.close()
  }
})

test('the loop read model medians samples and refuses a duration that runs backwards', async () => {
  const mod = await import('../src/metrics/product.js') as {
    loopMetrics: (input: {
      repositories: Array<{ createdAt: string; firstMergedAt: string | null }>
      readyPrs: Array<{ readyAt: string; mergedAt: string }>
    }) => {
      repositories: number
      firstMerge: { samples: number; medianMs: number | null }
      readyWait: { samples: number; medianMs: number | null }
    }
  }
  const run = mod.loopMetrics
  assert.equal(typeof run, 'function', 'src/metrics/product.ts exports loopMetrics')

  const empty = run({ repositories: [], readyPrs: [] })
  assert.equal(empty.firstMerge.medianMs, null)
  assert.equal(empty.readyWait.medianMs, null)

  const base = Date.parse('2026-11-01T00:00:00.000Z')
  const at = (ms: number): string => new Date(base + ms).toISOString()
  const odd = run({
    repositories: [
      { createdAt: at(0), firstMergedAt: at(DAY) },
      { createdAt: at(0), firstMergedAt: at(3 * DAY) },
      { createdAt: at(0), firstMergedAt: at(8 * DAY) },
      { createdAt: at(0), firstMergedAt: null },
    ],
    readyPrs: [
      { readyAt: at(0), mergedAt: at(HOUR) },
      { readyAt: at(0), mergedAt: at(2 * HOUR) },
    ],
  })
  assert.equal(odd.repositories, 4)
  assert.deepEqual(odd.firstMerge, { samples: 3, medianMs: 3 * DAY })
  assert.deepEqual(odd.readyWait, { samples: 2, medianMs: 1.5 * HOUR })

  const backwards = run({
    repositories: [{ createdAt: at(DAY), firstMergedAt: at(0) }],
    readyPrs: [{ readyAt: at(HOUR), mergedAt: at(0) }],
  })
  assert.deepEqual(backwards.firstMerge, { samples: 0, medianMs: null })
  assert.deepEqual(backwards.readyWait, { samples: 0, medianMs: null })
})
