import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { FlyBotRunner } from '../src/jobs/flybot.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext, RunnerResult } from '../src/jobs/runner.js'
import { log } from '../src/lib/log.js'
import { randomToken, sha256Hex } from '../src/lib/secrets.js'
import { json, makeUser, MemoryMailer, readBody, startFakeServer, testConfig } from './helpers.js'

// #100: a correlation value is only worth anything if the lines really carry it,
// so these tests read the same JSON the service writes. Both streams are tapped
// (error lines go to stderr) and every chunk is passed through: node:test
// reports on stdout, and swallowing it would hide the run itself.
function captureLog(): { lines: Array<Record<string, unknown>>; restore: () => void } {
  const lines: Array<Record<string, unknown>> = []
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  const tap = (write: typeof process.stdout.write): typeof process.stdout.write => ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    for (const line of text.split('\n')) {
      if (!line.startsWith('{"ts":"')) continue
      try {
        lines.push(JSON.parse(line) as Record<string, unknown>)
      } catch {}
    }
    return (write as unknown as (value: string | Uint8Array, ...args: unknown[]) => boolean)(chunk, ...rest)
  }) as unknown as typeof process.stdout.write
  process.stdout.write = tap(stdout.bind(process.stdout))
  process.stderr.write = tap(stderr.bind(process.stderr))
  return {
    lines,
    restore: () => {
      process.stdout.write = stdout
      process.stderr.write = stderr
    },
  }
}

function newRepo(store: Store, user: { id: string }, id: string, name: string) {
  return store.createRepo({
    id,
    userId: user.id,
    owner: 'o',
    name,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
}

test('every job line carries its own job id as trace, and pass-level lines carry none', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  // One repository fails at dispatch, the other runs the mock runner: the two
  // jobs are concurrent, so a shared or leaked value shows up as the wrong id.
  const runner: Runner = {
    name: 'trace-mixed',
    async run(context: RunnerContext): Promise<RunnerResult> {
      if (context.repo.name === 'trace-fails') throw new Error('bridge is down')
      // A runner writes its own lines through the logger the dispatch hands it;
      // that is the whole point of putting the binding on the context.
      context.log?.info('trace runner started', { kind: context.kind })
      return { status: 'succeeded', summary: 'ok' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  const capture = captureLog()
  try {
    const user = makeUser(store, { login: 'trace-user', status: 'approved' })
    const failing = newRepo(store, user, 'repo_trace_failing', 'trace-fails')
    const passing = newRepo(store, user, 'repo_trace_passing', 'trace-passes')
    const [failed, succeeded] = await Promise.all([jobs.enqueue(failing, 'manual'), jobs.enqueue(passing, 'manual')])
    assert.equal(failed.ok, false, 'the first job fails at dispatch')
    assert.equal(succeeded.ok, true, 'the second job succeeds')
    const failedId = failed.job?.id ?? ''
    const succeededId = succeeded.job?.id ?? ''
    assert.ok(failedId !== '' && succeededId !== '' && failedId !== succeededId)

    const failureLine = capture.lines.find((line) => line.msg === 'job start failed')
    const dispatchLine = capture.lines.find((line) => line.msg === 'trace runner started')
    assert.ok(failureLine !== undefined, 'the failed dispatch is logged')
    assert.equal(failureLine.trace, failedId, 'the failed job line names its own job under trace')
    assert.ok(dispatchLine !== undefined, 'the successful job wrote its own line through the bound logger')
    assert.equal(dispatchLine.trace, succeededId, 'the runner line names its own job under trace')
    for (const line of capture.lines) {
      if (line.msg === 'job start failed') assert.notEqual(line.trace, succeededId, 'a job line never carries the other job id')
      if (line.msg === 'trace runner started') assert.notEqual(line.trace, failedId, 'the runner line never carries the other job id')
    }
    for (const line of capture.lines) {
      if (!('trace' in line)) continue
      assert.ok(line.trace === failedId || line.trace === succeededId, `no line carries a third job id: ${String(line.trace)}`)
    }

    // The pass-level exemption is a claim about lines written with no job in
    // scope, so drive a pass that fails and read what it wrote.
    const instances = { healthSweep: async () => { throw new Error('sweep is down') } }
    const passJobs = new Jobs(store, testConfig({ env: 'production' }), runner, new MemoryMailer(), instances as never)
    await passJobs.tick()
    const sweepLine = capture.lines.find((line) => line.msg === 'instance health sweep failed')
    assert.ok(sweepLine !== undefined, 'the failed health sweep is logged')
    assert.equal('trace' in sweepLine, false, 'a pass-level line has no job in scope and carries no trace')
  } finally {
    capture.restore()
    jobs.stop()
    store.close()
  }
})

test('a call site cannot shadow the job a line is bound to', () => {
  const capture = captureLog()
  try {
    // The binding decides which job a line belongs to, so a call site that
    // passes its own `trace` must not be able to split a job's lines across two
    // ids. Anything else a call site knows better still lands.
    type Bindable = { with: (fields: Record<string, unknown>) => { info: (message: string, fields?: Record<string, unknown>) => void } }
    const binder = (log as unknown as Partial<Bindable>).with
    assert.equal(typeof binder, 'function', 'the logger binds a field once for a whole job')
    const jobLog = (binder as Bindable['with']).call(log, { trace: 'job_bound' })
    jobLog.info('shadow attempt', { trace: 'job_other', kind: 'trace-test' })
    const line = capture.lines.find((entry) => entry.msg === 'shadow attempt')
    assert.ok(line !== undefined, 'the line is written')
    assert.equal(line.trace, 'job_bound', 'the bound job id wins over the call-site field')
    assert.equal(line.kind, 'trace-test', 'a call-site field the binding does not name still lands')
  } finally {
    capture.restore()
  }
})

test('the bridge handoff, the gateway usage and the follow-up enqueue reuse the job trace', async () => {
  const bridge = await startFakeServer(async (request, response) => {
    await readBody(request)
    json(response, 202, { ok: true })
  })
  const config = testConfig({ runner: { ...testConfig().runner, bridgeUrl: bridge.url, bridgeToken: 'bridge-token' } })
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const captureRunner: Runner = {
    name: 'capture',
    async run(context: RunnerContext): Promise<RunnerResult> {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, captureRunner, new MemoryMailer())
  const capture = captureLog()
  try {
    const user = makeUser(store, { login: 'trace-seams', status: 'approved' })
    const repo = newRepo(store, user, 'repo_trace_seams', 'trace-seams')
    const queued = await jobs.enqueue(repo, 'manual')
    assert.equal(queued.ok, true)
    const jobId = queued.job?.id ?? ''
    const context = contexts[0]
    assert.ok(context !== undefined, 'the dispatch reached the runner')
    assert.ok(context.log !== undefined, 'the dispatch hands the runner a job-bound logger')

    // The bridge handoff writes its own line; it must use the bound logger the
    // dispatch handed it, not the module-level one.
    const handoffResult = await new FlyBotRunner(config).run(context)
    assert.equal(handoffResult.status, 'running')
    const handoff = capture.lines.find((line) => line.msg === 'job handed to FlyBot bridge')
    assert.ok(handoff !== undefined, 'the handoff is logged')
    assert.equal(handoff.trace, jobId, 'the bridge handoff carries the same trace as the job')

    // The gateway names the job it spends on; a job token carries that job id.
    const platform = await startFakeServer(async (request, response) => {
      await readBody(request)
      json(response, 200, { id: 'x', choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { total_tokens: 10 } }, { 'x-litellm-response-cost': '0.0002' })
    })
    const appConfig = testConfig({ llm: { ...testConfig().llm, baseUrl: `${platform.url}/v1`, key: 'k', model: 'm' } })
    const built = await buildApp({ config: appConfig, store, mailer: new MemoryMailer(), runner: captureRunner, startScheduler: false })
    try {
      const raw = `flg_${randomToken(32)}`
      store.createApiToken({ id: 'tok_trace', userId: user.id, kind: 'job', name: `job:${jobId}`, tokenHash: sha256Hex(raw), prefix: raw.slice(0, 8), repoId: repo.id, expiresAt: null })
      const usage = await built.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        payload: { model: 'ignored', messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(usage.statusCode, 200)
      const usageLine = capture.lines.find((line) => line.msg === 'gateway usage')
      assert.ok(usageLine !== undefined, 'the usage line is logged')
      assert.equal(usageLine.trace, jobId, 'the gateway usage line carries the job trace')

      // A follow-up enqueued from a check-run webhook announces its new job; the
      // line must name it under the same key. Its app gets its own store: closing
      // a built app closes the store it was handed.
      const followStore = new Store(':memory:')
      const followUser = makeUser(followStore, { login: 'trace-follow', status: 'approved' })
      const followRepo = followStore.createRepo({ id: 'repo_trace_follow', userId: followUser.id, owner: 'HugoXK', name: 'trace-follow', defaultBranch: 'main', tokenEnc: '', permission: 'admin', repoRole: 'maintainer', installationId: 4242, goal: '', autoIterate: false, intervalMinutes: 1440 })
      const original = followStore.createJob({ id: 'job_trace_original', repoId: followRepo.id, userId: followUser.id, trigger: 'manual', goal: 'g', callbackHash: sha256Hex('cb'), platformTokenHash: '' })
      followStore.updateJob(original.id, { status: 'succeeded', pr_url: 'https://github.com/HugoXK/trace-follow/pull/7', branch: 'fledge/fix', finished_at: new Date().toISOString() })
      const webhookConfig = testConfig({ githubApp: { id: '1', slug: 'fledge-platform', privateKeyPath: '/tmp/fake.pem', webhookSecret: 'secret', useUserToken: false } })
      const webhookApp = await buildApp({ config: webhookConfig, store: followStore, mailer: new MemoryMailer(), runner: captureRunner, startScheduler: false })
      try {
        const payload = {
          installation: { id: 4242 },
          repository: { full_name: 'HugoXK/trace-follow' },
          check_run: { conclusion: 'failure', name: 'node-ut', head_sha: 'abc', pull_requests: [{ number: 7, html_url: 'https://github.com/HugoXK/trace-follow/pull/7', head: { ref: 'fledge/fix', sha: 'abc' } }] },
        }
        const body = Buffer.from(JSON.stringify(payload))
        const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
        const response = await webhookApp.app.inject({
          method: 'POST',
          url: '/api/github/webhook',
          headers: { 'content-type': 'application/json', 'x-github-event': 'check_run', 'x-github-delivery': 'trace-delivery', 'x-hub-signature-256': signature },
          payload: body,
        })
        assert.equal(response.statusCode, 200)
        const followUp = followStore.listJobsForRepo(followRepo.id).find((job) => job.trigger === 'followup')
        assert.ok(followUp !== undefined, 'the follow-up job exists')
        const followLine = capture.lines.find((line) => line.msg === 'github follow-up')
        assert.ok(followLine !== undefined, 'the follow-up enqueue is logged')
        assert.equal(followLine.trace, followUp.id, 'the follow-up line carries the new job trace')
      } finally {
        await webhookApp.close()
      }
    } finally {
      await built.close()
      await platform.close()
    }
  } finally {
    capture.restore()
    jobs.stop()
    await bridge.close()
  }
})
