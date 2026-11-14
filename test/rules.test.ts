import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { loadRepoRules, RulesError } from '../src/rules.js'
import { GithubClient } from '../src/repos/github.js'
import { json, makeUser, MemoryMailer, startFakeServer, testConfig } from './helpers.js'

const COMMIT = 'a'.repeat(40)

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

async function rulesGithub(options: { ruleType?: string; skillCount?: number } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  return startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/repos/o/r/branches/main') {
      json(response, 200, { name: 'main', commit: { sha: COMMIT } })
      return
    }
    if (url.pathname === '/repos/o/r/contents/' || url.pathname === '/repos/o/r/contents') {
      json(response, 200, { type: 'dir' })
      return
    }
    if (url.pathname === '/repos/o/r/contents/.fledge/rules.md') {
      if (options.ruleType !== undefined) {
        json(response, 200, { type: options.ruleType, sha: 'rulesha' })
        return
      }
      json(response, 200, {
        type: 'file',
        sha: 'rulesha',
        size: 20,
        encoding: 'base64',
        content: base64('# Rules\nAlways test.\n'),
      })
      return
    }
    if (url.pathname === '/repos/o/r/contents/.fledge/review.md' || url.pathname === '/repos/o/r/contents/.fledge/develop.md') {
      json(response, 404, { message: 'Not Found' })
      return
    }
    if (url.pathname === '/repos/o/r/contents/.agents/skills') {
      const count = options.skillCount ?? 1
      json(response, 200, Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, type: 'dir', path: `.agents/skills/skill-${index}` })))
      return
    }
    if (url.pathname.endsWith('/SKILL.md')) {
      json(response, 200, {
        type: 'file',
        sha: 'skillsha',
        size: 40,
        encoding: 'base64',
        content: base64('---\ndescription: Release notes\n---\n\n# Release\nUse the real sources.\n'),
      })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
}

test('loadRepoRules reads rules and skills from a fixed commit', async () => {
  const server = await rulesGithub()
  try {
    const client = new GithubClient('token', server.url)
    const rules = await loadRepoRules(client, 'o', 'r', COMMIT)
    assert.equal(rules.commit, COMMIT)
    assert.equal(rules.files.length, 1)
    assert.match(rules.effective, /Always test/)
    assert.equal(rules.skills.length, 1)
    assert.equal(rules.skills[0]?.description, 'Release notes')
    assert.equal(rules.hash.length, 64)
    assert.equal(rules.totalBytes, rules.files[0]!.bytes + rules.skills[0]!.bytes)
  } finally {
    await server.close()
  }
})

test('loadRepoRules refuses a symlinked rule file as a whole', async () => {
  const server = await rulesGithub({ ruleType: 'symlink' })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT),
      (error: unknown) => error instanceof RulesError && error.code === 'rules_invalid' && error.path === '.fledge/rules.md',
    )
  } finally {
    await server.close()
  }
})

test('loadRepoRules refuses more than the skill bound before reading each skill', async () => {
  const server = await rulesGithub({ skillCount: 33 })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT),
      (error: unknown) => error instanceof RulesError && error.code === 'rules_invalid' && error.path === '.agents/skills',
    )
  } finally {
    await server.close()
  }
})

test('enqueue stores the fixed-commit rule context and hands it to the runner', async () => {
  const server = await rulesGithub()
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: server.url },
    flybot: { ...base.flybot, instanceImage: '' },
    runner: { ...base.runner, queueDispatch: false },
  })
  const store = new Store(':memory:')
  const contexts: RunnerContext[] = []
  const runner: Runner = {
    name: 'flybot',
    async run(context) {
      contexts.push(context)
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'rules-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_rules',
      userId: user.id,
      owner: 'o',
      name: 'r',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const result = await jobs.enqueue(repo, 'manual', 'do the work', 'iterate')
    assert.equal(result.ok, true, result.error ?? '')
    const job = result.job!
    assert.equal(contexts[0]?.rules?.commit, COMMIT)
    assert.match(contexts[0]?.rules?.effective ?? '', /Always test/)
    const context = store.getJobContext(job.id)
    assert.equal(context?.commit_sha, COMMIT)
    assert.equal(store.getJobContextFile(job.id, '.fledge/rules.md')?.content, '# Rules\nAlways test.\n')
    assert.equal(store.getJobContextFile(job.id, '.agents/skills/skill-0/SKILL.md')?.sha256, 'skillsha')
  } finally {
    await server.close()
    store.close()
  }
})

test('the job context endpoint serves only stored files with the callback secret', async () => {
  const config = testConfig({ flybot: { ...testConfig().flybot, instanceImage: '' } })
  const store = new Store(':memory:')
  const secret = 'context-secret'
  const user = makeUser(store, { login: 'context-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_context',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const job = store.createJob({
    id: 'job_context',
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'work',
    callbackHash: sha256Hex(secret),
    platformTokenHash: '',
    kind: 'iterate',
  })
  store.saveJobContext({
    jobId: job.id,
    repoId: repo.id,
    commitSha: COMMIT,
    rulesJson: JSON.stringify({ effective: '# Rules', hash: 'h' }),
    manifestJson: JSON.stringify([{ path: '.fledge/rules.md', kind: 'rule', sha256: 'rulesha', bytes: 8 }]),
    files: [{ path: '.fledge/rules.md', sha256: 'rulesha', bytes: 8, content: '# Rules\n' }],
  })
  const built = await buildApp({ config, store, startScheduler: false })
  try {
    const ok = await built.app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/context?path=${encodeURIComponent('.fledge/rules.md')}`,
      headers: { authorization: `Bearer ${secret}` },
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.body, '# Rules\n')
    assert.equal(ok.headers['x-content-sha256'], 'rulesha')

    const manifest = await built.app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/context`,
      headers: { authorization: `Bearer ${secret}` },
    })
    assert.equal(manifest.statusCode, 200)
    assert.equal((JSON.parse(manifest.body) as { commit: string }).commit, COMMIT)

    const badSecret = await built.app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/context?path=${encodeURIComponent('.fledge/rules.md')}`,
      headers: { authorization: 'Bearer wrong' },
    })
    assert.equal(badSecret.statusCode, 401)

    const outside = await built.app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/context?path=${encodeURIComponent('README.md')}`,
      headers: { authorization: `Bearer ${secret}` },
    })
    assert.equal(outside.statusCode, 404)

    store.updateJob(job.id, { status: 'succeeded', finished_at: new Date().toISOString() })
    const finished = await built.app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}/context?path=${encodeURIComponent('.fledge/rules.md')}`,
      headers: { authorization: `Bearer ${secret}` },
    })
    assert.equal(finished.statusCode, 409)
  } finally {
    await built.close()
  }
})

test('a PR that changes a rule file blocks auto-merge until a maintainer acknowledges it', async () => {
  const sha = 'b'.repeat(40)
  const server = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/repos/o/r/pulls/1') {
      json(response, 200, {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        title: 'change rules',
        state: 'open',
        head: { ref: 'fledge/rules', sha },
        base: { ref: 'main' },
        mergeable: true,
        mergeable_state: 'clean',
        draft: false,
        merged: false,
        changed_files: 1,
      })
      return
    }
    if (url.pathname === `/repos/o/r/commits/${sha}/check-runs`) {
      json(response, 200, { check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })
      return
    }
    if (url.pathname === `/repos/o/r/commits/${sha}/status`) {
      json(response, 200, { state: 'success', statuses: [] })
      return
    }
    if (url.pathname === '/repos/o/r/pulls/1/reviews') {
      json(response, 200, [])
      return
    }
    if (url.pathname === '/repos/o/r/pulls/1/files') {
      json(response, 200, [{ filename: '.fledge/rules.md', status: 'modified', additions: 1, deletions: 0 }])
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: server.url } })
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'mock', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'rule-pr-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_rule_pr',
      userId: user.id,
      owner: 'o',
      name: 'r',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
      upstreamHtmlUrl: 'https://github.com',
    })
    const job = store.createJob({
      id: 'job_rule_pr',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'work',
      callbackHash: sha256Hex('secret'),
      platformTokenHash: '',
      kind: 'iterate',
      baseBranch: 'main',
    })
    store.updateJob(job.id, { pr_url: 'https://github.com/o/r/pull/1', status: 'succeeded', finished_at: new Date().toISOString() })
    store.saveJobContext({ jobId: job.id, repoId: repo.id, commitSha: sha, rulesJson: '{}', manifestJson: '[]', files: [] })
    const blocked = await jobs.verifyPullRequest(store.getJob(job.id)!, 'https://github.com/o/r/pull/1')
    assert.equal(blocked.ok, false)
    assert.match(blocked.message ?? '', /rule change/i)
    const verification = JSON.parse(store.getJob(job.id)!.verification_json ?? '{}') as { ruleChange?: { paths?: string[]; acknowledged?: boolean } }
    assert.deepEqual(verification.ruleChange?.paths, ['.fledge/rules.md'])
    assert.equal(verification.ruleChange?.acknowledged, false)

    store.setSetting(`rule_change_ack:${job.id}:${sha}`, new Date().toISOString())
    const allowed = await jobs.verifyPullRequest(store.getJob(job.id)!, 'https://github.com/o/r/pull/1')
    assert.equal(allowed.ok, true, allowed.message ?? '')
    const after = JSON.parse(store.getJob(job.id)!.verification_json ?? '{}') as { ruleChange?: { acknowledged?: boolean } }
    assert.equal(after.ruleChange?.acknowledged, true)
  } finally {
    store.close()
    await server.close()
  }
})
