import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { Config } from '../src/config.js'
import { Store } from '../src/db.js'
import type { RepoRow, UserRow } from '../src/db.js'
import { InstanceManager } from '../src/flybot/instances.js'
import { PLAYBOOK_VERSION, playbookFingerprint } from '../src/flybot/playbook.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner } from '../src/jobs/runner.js'
import { classifyFailure, failureSentence } from '../src/lib/failure.js'
import { retryDecision } from '../src/lib/retry.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, testConfig } from './helpers.js'

// #260: the reviewer session of a repository instance answered the DSH send
// with 202, never started a model call because the provider was over budget, and
// Fledge only saw the 30-minute no-heartbeat window. The provider signal existed
// at the boundary and was dropped in two places: the bridge replaced whatever
// DSH said with "could not reach DSH", and the dispatch catch stored every start
// failure as BRIDGE_ERROR, which the retry policy treats as transient. These
// tests pin the text and the category at both boundaries.
const BUDGET_TEXT = 'Budget has been exceeded! Current cost: 501.49 / Max budget: 500.0'
const RATE_TEXT = 'Rate limit exceeded: Current limit: 50, Remaining: 0'

const zh = (zhText: string): string => zhText

test('the provider budget and rate-limit vocabulary is quota, not a bridge or GitHub failure', () => {
  assert.equal(classifyFailure({ status: 'failed', kind: 'review', error: BUDGET_TEXT })?.kind, 'quota')
  assert.equal(classifyFailure({ status: 'failed', kind: 'review', error: RATE_TEXT })?.kind, 'quota', 'Remaining: 0 is the provider refusing, not a GitHub rate limit')
  assert.equal(retryDecision('quota', 0).retry, false, 'a budget refusal is not retried')
})

test('a provider refusal carries its own failure code so the job page names the provider', async () => {
  // Imported here rather than at the top so this file reports the behavioural
  // failures at the unbroken tip instead of one module-resolution error.
  const module = await import('../src/lib/failure.js') as unknown as {
    providerRefusalCode?: (text: string | null | undefined) => 'PROVIDER_BUDGET_EXCEEDED' | 'PROVIDER_RATE_LIMITED' | null
  }
  const code = module.providerRefusalCode
  assert.equal(typeof code, 'function', 'the dispatch path has a provider-refusal classifier')
  if (code === undefined) return
  assert.equal(code(`FlyBot bridge 502: DSH did not accept the job: ${BUDGET_TEXT}`), 'PROVIDER_BUDGET_EXCEEDED')
  assert.equal(code(RATE_TEXT), 'PROVIDER_RATE_LIMITED')
  assert.equal(code('FlyBot bridge unreachable (http://127.0.0.1:9/run): fetch failed'), null)
  assert.equal(code('DSH /api/bot 502: upstream closed the connection'), null)
})

test('the provider codes have their own sentence instead of the heartbeat one', () => {
  const budget = failureSentence(zh, 'PROVIDER_BUDGET_EXCEEDED') ?? ''
  assert.match(budget, /供应商|预算/)
  assert.doesNotMatch(budget, /心跳/)
  const never = failureSentence(zh, 'PROVIDER_CALL_NEVER_STARTED') ?? ''
  assert.match(never, /模型调用/)
  assert.doesNotMatch(never, /没有心跳/)
})

interface Harness {
  config: Config
  store: Store
  jobs: Jobs
  repo: RepoRow
  user: UserRow
}

function harness(run: Runner['run'], options: { instancePort?: number } = {}): Harness {
  const config = testConfig()
  const store = new Store(':memory:')
  const runner: Runner = { name: 'capture', run }
  const jobs = new Jobs(store, config, runner, new MemoryMailer(), new InstanceManager(store, config))
  const user = makeUser(store, { login: 'provider-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_provider', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x',
    permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    canReview: true, reviewerEnabled: true,
  })
  if (options.instancePort !== undefined) {
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: '/tmp/provider', bridge_script: '/tmp/bridge',
      dsh_port: 1, bridge_port: options.instancePort, model_port: 3, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1',
      team_json: JSON.stringify({ chief: 'chief-1', lead: 'lead-1', product: 'p', test: 't', security: 's', reviewer: 'reviewer-1', dev1: 'd1', dev2: 'd2', reviewerScope: 'upstream', team: 'Repo', playbook: PLAYBOOK_VERSION, playbookHash: playbookFingerprint('') }),
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
  }
  return { config, store, jobs, repo, user }
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  return { server, port: (server.address() as AddressInfo).port }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function jsonBody(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) })
  response.end(text)
}

// The instance `state` endpoint is what the stall sweep can read without the job
// log: a role session whose turn ended with zero model calls never started one.
async function fakeInstanceBridge(ended: Array<{ sessionId: string; calls: number; at: number }>): Promise<{ server: Server; port: number }> {
  return listen((request, response) => {
    if (request.method !== 'POST' || request.url !== '/dsh') {
      response.writeHead(404).end()
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      jsonBody(response, 200, { value: { bots: [], work: { bots: {}, ended }, questions: {} } })
    })
  })
}

test('a dispatch refusal is stored as the provider failure, not a transient bridge error', async () => {
  const h = harness(async () => {
    throw new Error(`FlyBot bridge 502: DSH did not accept the job: ${BUDGET_TEXT}`)
  })
  try {
    const enqueued = await h.jobs.enqueue(h.repo, 'manual')
    assert.equal(enqueued.ok, false)
    const job = h.store.getJob(enqueued.job!.id)!
    assert.equal(job.error_code, 'PROVIDER_BUDGET_EXCEEDED', 'the start failure keeps the provider category')
    assert.equal(classifyFailure(job)?.kind, 'quota')
    assert.equal(h.store.listSettings('retry_pending:').length, 0, 'a provider refusal schedules no retry')
  } finally {
    h.store.close()
  }
})

test('a stall whose role session never called the model names the provider, not only the heartbeat', async () => {
  const started = Date.parse(minutesAgo(35))
  const bridge = await fakeInstanceBridge([{ sessionId: 'chief-1', calls: 0, at: started + 60_000 }])
  const h = harness(async () => ({ status: 'running' }), { instancePort: bridge.port })
  try {
    const enqueued = await h.jobs.enqueue(h.repo, 'manual')
    const jobId = enqueued.job!.id
    h.store.updateJob(jobId, { started_at: new Date(started).toISOString(), last_callback_at: null })
    await h.jobs.tick()
    const job = h.store.getJob(jobId)!
    assert.equal(job.status, 'failed')
    assert.equal(job.error_code, 'PROVIDER_CALL_NEVER_STARTED', 'a turn that ended with no model call is a provider refusal')
    assert.match(job.error ?? '', /模型调用/)
    assert.equal(h.store.listSettings('retry_pending:').length, 0, 'a provider refusal is not retried as a transient stall')
  } finally {
    await close(bridge.server)
    h.store.close()
  }
})

test('a genuine no-heartbeat job still fails as stalled', async () => {
  const started = Date.parse(minutesAgo(35))
  const bridge = await fakeInstanceBridge([{ sessionId: 'chief-1', calls: 12, at: started + 60_000 }])
  const h = harness(async () => ({ status: 'running' }), { instancePort: bridge.port })
  try {
    const enqueued = await h.jobs.enqueue(h.repo, 'manual')
    const jobId = enqueued.job!.id
    h.store.updateJob(jobId, { started_at: new Date(started).toISOString(), last_callback_at: null })
    await h.jobs.tick()
    const job = h.store.getJob(jobId)!
    assert.equal(job.status, 'failed')
    assert.equal(job.error_code, 'JOB_STALLED')
    assert.match(job.error ?? '', /没有心跳/)
  } finally {
    await close(bridge.server)
    h.store.close()
  }
})

// The bridge is the only place that sees DSH's answer to the send, and it used
// to throw that answer away: every send failure became `could not reach DSH`, so
// the budget text never reached `jobs.error`.
async function freePort(): Promise<number> {
  const { server, port } = await listen((_request, response) => response.writeHead(200).end())
  await close(server)
  return port
}

async function spawnBridge(web: string, logPath: string): Promise<{ child: ReturnType<typeof spawn>; port: number }> {
  const port = await freePort()
  const child = spawn(process.execPath, [join(process.cwd(), 'bridge/flybot-bridge.mjs')], {
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_HOST: '127.0.0.1',
      BRIDGE_TOKEN: 'bridge-token-for-the-test',
      FLYBOT_CHAT_SESSION_ID: 'session-test',
      FLYBOT_WEB: web,
      FLYBOT_LOG: logPath,
      MODEL_PROXY_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (response.ok) return { child, port }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  child.kill('SIGKILL')
  throw new Error('the bridge did not answer /healthz')
}

test('the bridge relays the DSH refusal instead of calling it an unreachable bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-provider-'))
  const logPath = join(dir, 'dsh-web.log')
  writeFileSync(logPath, 'dsh web listening url=http://127.0.0.1:3080/?token=testtoken\n')
  const dsh = await listen((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'set-cookie': 'dsh=ok; Path=/' }).end('ok')
      return
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      jsonBody(response, 429, { error: { message: BUDGET_TEXT } })
    })
  })
  let child: ReturnType<typeof spawn> | undefined
  try {
    const bridge = await spawnBridge(`http://127.0.0.1:${dsh.port}`, logPath)
    child = bridge.child
    const response = await fetch(`http://127.0.0.1:${bridge.port}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer bridge-token-for-the-test' },
      body: JSON.stringify({
        jobId: 'job_provider_refused',
        kind: 'review',
        goal: 'review the open PRs',
        upstream: { owner: 'o', name: 'r', defaultBranch: 'main' },
        fork: { owner: 'o', name: 'r', defaultBranch: 'main' },
        credentialUrl: 'http://127.0.0.1:9999/credential',
        callbackUrl: 'http://127.0.0.1:9999/callback',
      }),
    })
    assert.equal(response.ok, false, 'a refused send is not accepted as a started job')
    const body = await response.text()
    assert.match(body, /Budget has been exceeded/, `the DSH text survives the bridge: ${body}`)
    assert.match(body, /501\.49/)
    assert.doesNotMatch(body, /could not reach DSH/)
  } finally {
    child?.kill('SIGKILL')
    await close(dsh.server)
  }
})
