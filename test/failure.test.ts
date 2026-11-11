import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, failureBreakdown, failureLabel } from '../src/lib/failure.js'

const base = { kind: 'iterate', status: 'failed' as const }

test('failures map to actionable categories', () => {
  assert.equal(classifyFailure({ ...base, error: '平台额度已用完，请在 Settings → Model 配置自己的模型 API。' })?.kind, 'quota')
  assert.equal(classifyFailure({ ...base, error: 'GitHub token 权限不足，请重新授权这个仓库。' })?.kind, 'credential')
  assert.equal(classifyFailure({ ...base, error: 'STAGE_EVIDENCE_MISSING: 缺少失败测试证据' })?.kind, 'stage_evidence')
  assert.equal(classifyFailure({ ...base, error: '任务停滞：超过 30 分钟没有心跳。' })?.kind, 'stalled')
  assert.equal(classifyFailure({ ...base, error: '任务超时未回报' })?.kind, 'timeout')
  assert.equal(classifyFailure({ ...base, error: 'FlyBot 实例尚未就绪' })?.kind, 'bridge')
  assert.equal(classifyFailure({ ...base, error: 'PR 检查还没有全绿' })?.kind, 'github')
  assert.equal(classifyFailure({ ...base, error: '模型供应商连接失败' })?.kind, 'model')
  assert.equal(classifyFailure({ ...base, error: 'something unexpected' })?.kind, 'unknown')
  assert.equal(classifyFailure({ ...base, status: 'succeeded', error: '' }), null)
})

test('failure labels are bilingual and the breakdown is ordered', () => {
  const t = (zh: string, en: string): string => `${zh}/${en}`
  assert.match(failureLabel(t, 'quota'), /平台额度不足\/Platform quota exhausted/)
  const rows = failureBreakdown([
    { ...base, error: '模型供应商连接失败' },
    { ...base, error: '平台额度已用完' },
    { ...base, error: '平台额度已用完' },
    { ...base, status: 'succeeded', error: '' },
  ])
  assert.deepEqual(rows, [{ kind: 'quota', count: 2 }, { kind: 'model', count: 1 }])
})

// #163: a job that never reached the bridge is stored with the raw transport
// error, and the classifier has no pattern for it, so an outage was reported as
// "unknown, retry once". The runner knows the target, so it names the bridge and
// keeps the original cause inside the message (#55: the cause is never hidden).
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { Store } from '../src/db.js'
import { InstanceManager } from '../src/flybot/instances.js'
import { PLAYBOOK_VERSION, playbookFingerprint } from '../src/flybot/playbook.js'
import { FlyBotRunner } from '../src/jobs/flybot.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

async function capturedDispatchContext(): Promise<RunnerContext> {
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: 'image' } })
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = { name: 'capture', async run(context) { contexts.push(context); return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer(), new InstanceManager(store, config))
  try {
    const user = makeUser(store, { login: 'bridge-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_bridge', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440, canReview: true, reviewerEnabled: true })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/bridge', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: 2, model_port: 3, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1',
      team_json: JSON.stringify({ chief: 'chief-1', lead: 'lead-1', product: 'p', test: 't', security: 's', reviewer: 'reviewer-1', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo', playbook: PLAYBOOK_VERSION, playbookHash: playbookFingerprint('') }),
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    const enqueued = await jobs.enqueue(repo, 'manual')
    assert.equal(enqueued.ok, true)
    const context = contexts[0]
    assert.ok(context, 'the service hands the runner a context')
    return context
  } finally {
    store.close()
  }
}

async function refusedUrl(): Promise<string> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${address.port}/run`
}

function runnerFor(url: string): FlyBotRunner {
  return new FlyBotRunner(testConfig({ runner: { ...testConfig().runner, bridgeUrl: url, bridgeToken: 'test' } }))
}

function withUrl(context: RunnerContext, url: string): RunnerContext {
  return { ...context, flybot: { ...context.flybot!, url, token: 'bridge-token' } }
}

test('a dispatch transport failure is a bridge failure', async () => {
  const context = await capturedDispatchContext()
  const url = await refusedUrl()
  await assert.rejects(
    () => runnerFor(url).run(withUrl(context, url)),
    (error: Error) => {
      assert.match(error.message, /FlyBot bridge/)
      assert.match(error.message, /ECONNREFUSED|fetch failed/i)
      assert.equal(classifyFailure({ ...base, error: error.message })?.kind, 'bridge')
      return true
    },
  )
})

test('a dispatch that never answers names the bridge, not an unknown failure', async () => {
  const context = await capturedDispatchContext()
  const url = 'http://127.0.0.1:9/run'
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }) as typeof fetch
  try {
    await assert.rejects(
      () => runnerFor(url).run(withUrl(context, url)),
      (error: Error) => {
        assert.match(error.message, /FlyBot bridge/)
        assert.match(error.message, /The operation was aborted due to timeout/)
        assert.equal(classifyFailure({ ...base, error: error.message })?.kind, 'bridge')
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('the stored dispatch error never carries bridge credentials', async () => {
  const context = await capturedDispatchContext()
  const url = 'http://127.0.0.1:9/run?token=supersecret'
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  try {
    await assert.rejects(
      () => runnerFor(url).run(withUrl(context, url)),
      (error: Error) => {
        assert.match(error.message, /127\.0\.0\.1:9\/run/)
        assert.doesNotMatch(error.message, /supersecret/)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})
