import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import type { Runner, RunnerContext } from '../src/jobs/runner.js'
import { encryptSecret, sha256Hex } from '../src/lib/secrets.js'
import { failureBannerSentence } from '../src/lib/failure.js'
import { loadRepoRules, MAX_RULE_FILE_BYTES, MAX_RULES_PROMPT_BYTES, MAX_RULES_TOTAL_BYTES, MAX_SKILL_BYTES, RulesError } from '../src/rules.js'
import { GithubClient } from '../src/repos/github.js'
import { formBody, json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

const COMMIT = 'a'.repeat(40)

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

async function rulesGithub(options: { ruleType?: string; ruleSize?: number; ruleBytes?: number; reviewBytes?: number; skillCount?: number; skillBytes?: number; hasRules?: boolean } = {}): Promise<{ url: string; close: () => Promise<void> }> {
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
      if (options.hasRules === false) {
        json(response, 404, { message: 'Not Found' })
        return
      }
      if (options.ruleType !== undefined) {
        json(response, 200, { type: options.ruleType, sha: 'rulesha' })
        return
      }
      if (options.ruleSize !== undefined) {
        // The size ceiling is checked against the metadata, before the body is used.
        json(response, 200, { type: 'file', sha: 'rulesha', size: options.ruleSize, encoding: 'base64', content: base64('# Rules\nAlways test.\n') })
        return
      }
      if (options.ruleBytes !== undefined) {
        const content = 'r'.repeat(options.ruleBytes)
        json(response, 200, { type: 'file', sha: 'rulesha', size: Buffer.byteLength(content), encoding: 'base64', content: base64(content) })
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
    if (url.pathname === '/repos/o/r/contents/.fledge/review.md' && options.reviewBytes !== undefined) {
      const content = 'v'.repeat(options.reviewBytes)
      json(response, 200, { type: 'file', sha: 'reviewsha', size: Buffer.byteLength(content), encoding: 'base64', content: base64(content) })
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
      // An explicit byte count pads the body so the total ceiling can be reached
      // with skills that each stay under the per-file ceiling.
      const header = '---\ndescription: Release notes\n---\n\n'
      const content = options.skillBytes === undefined
        ? `${header}# Release\nUse the real sources.\n`
        : `${header}${'x'.repeat(Math.max(0, options.skillBytes - header.length))}`
      json(response, 200, {
        type: 'file',
        sha: 'skillsha',
        size: Buffer.byteLength(content),
        encoding: 'base64',
        content: base64(content),
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

test('a console override supplies a rule file when the repository has none', async () => {
  const server = await rulesGithub({ hasRules: false, skillCount: 0 })
  try {
    const client = new GithubClient('token', server.url)
    const rules = await loadRepoRules(client, 'o', 'r', COMMIT, [
      { path: '.fledge/rules.md', content: '# Console\nUse the override.\n', revision: 3 },
    ])
    assert.equal(rules.files.length, 1)
    assert.equal(rules.files[0]?.layer, 'console')
    assert.match(rules.effective, /Use the override/)
    assert.deepEqual(rules.layers.find((layer) => layer.path === '.fledge/rules.md'), { path: '.fledge/rules.md', layer: 'console', revision: 3 })
    assert.deepEqual(rules.layers.find((layer) => layer.path === '.fledge/review.md'), { path: '.fledge/review.md', layer: 'builtin', revision: null })
  } finally {
    await server.close()
  }
})

test('a repository file wins over a console override for the same path', async () => {
  const server = await rulesGithub()
  try {
    const client = new GithubClient('token', server.url)
    const rules = await loadRepoRules(client, 'o', 'r', COMMIT, [
      { path: '.fledge/rules.md', content: '# Console\nThis must not win.\n', revision: 2 },
    ])
    assert.equal(rules.files.length, 1)
    assert.equal(rules.files[0]?.layer, 'repository')
    assert.match(rules.effective, /Always test/)
    assert.doesNotMatch(rules.effective, /This must not win/)
    assert.deepEqual(rules.layers.find((layer) => layer.path === '.fledge/rules.md'), { path: '.fledge/rules.md', layer: 'repository', revision: null })
  } finally {
    await server.close()
  }
})

test('an empty console override is refused instead of replacing the built-in layer', async () => {
  const server = await rulesGithub({ hasRules: false, skillCount: 0 })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT, [{ path: '.fledge/rules.md', content: '   ', revision: 1 }]),
      (error: unknown) => error instanceof RulesError && error.code === 'rules_invalid' && error.path === '.fledge/rules.md',
    )
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

test('a rule file over the per-file ceiling is refused as a whole', async () => {
  const server = await rulesGithub({ ruleSize: MAX_RULE_FILE_BYTES + 1 })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT),
      (error: unknown) => error instanceof RulesError && error.code === 'rules_invalid' && error.path === '.fledge/rules.md' && /larger than/.test(error.message),
    )
  } finally {
    await server.close()
  }
})

test('a skill file over its own ceiling is refused with the skill path', async () => {
  const server = await rulesGithub({ skillCount: 1, skillBytes: MAX_SKILL_BYTES + 1 })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT),
      (error: unknown) => error instanceof RulesError && error.code === 'rules_invalid' && error.path === '.agents/skills/skill-0/SKILL.md' && /larger than/.test(error.message),
    )
  } finally {
    await server.close()
  }
})

test('a console override over the per-file ceiling is refused, not stored as the effective layer', async () => {
  const server = await rulesGithub({ hasRules: false, skillCount: 0 })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT, [{ path: '.fledge/rules.md', content: 'x'.repeat(MAX_RULE_FILE_BYTES + 1), revision: 4 }]),
      (error: unknown) => error instanceof RulesError && error.code === 'rules_invalid' && error.path === '.fledge/rules.md' && /larger than/.test(error.message),
    )
  } finally {
    await server.close()
  }
})

test('rules and skills together over the total ceiling are refused', async () => {
  // Nine skills that each stay under the per-file ceiling still go over the
  // total: 9 * 32 000 bytes is 288 000, above the 256 KiB set ceiling.
  const server = await rulesGithub({ skillCount: 9, skillBytes: 32000 })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT),
      (error: unknown) => error instanceof RulesError && error.code === 'rules_invalid' && error.path === '.fledge' && /exceed/.test(error.message),
    )
  } finally {
    await server.close()
  }
})

test('a set just under the total ceiling loads instead of being refused', async () => {
  const server = await rulesGithub({ skillCount: 8, skillBytes: 32000 })
  try {
    const client = new GithubClient('token', server.url)
    const rules = await loadRepoRules(client, 'o', 'r', COMMIT)
    assert.equal(rules.skills.length, 8)
    assert.ok(rules.totalBytes > MAX_RULES_TOTAL_BYTES - 32 * 1024)
    assert.ok(rules.totalBytes <= MAX_RULES_TOTAL_BYTES)
  } finally {
    await server.close()
  }
})

test('a rule file over the prompt budget is refused naming that file, not sliced', async () => {
  // One file may be 32 KiB, but the bridge prompt only carries the rule text up
  // to MAX_RULES_PROMPT_BYTES. Past that the set is refused as a whole; a silent
  // slice would drop the later files from every prompt.
  const server = await rulesGithub({ ruleBytes: MAX_RULES_PROMPT_BYTES + 1 })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT),
      (error: unknown) => error instanceof RulesError
        && error.code === 'rules_invalid'
        && error.path === '.fledge/rules.md'
        && /prompt budget/.test(error.message)
        && /16021 bytes/.test(error.message),
    )
  } finally {
    await server.close()
  }
})

test('the file that crosses the prompt budget is the one the refusal names', async () => {
  // `.fledge/rules.md` is legal on its own; the second file is what pushes the
  // assembled text over, so naming the first file would hide the actual cause.
  const server = await rulesGithub({ ruleBytes: 12_000, reviewBytes: 4_000 })
  try {
    const client = new GithubClient('token', server.url)
    await assert.rejects(
      () => loadRepoRules(client, 'o', 'r', COMMIT),
      (error: unknown) => error instanceof RulesError
        && error.code === 'rules_invalid'
        && error.path === '.fledge/review.md'
        && /16043 bytes/.test(error.message)
        && /\.fledge\/review\.md/.test(error.message),
    )
  } finally {
    await server.close()
  }
})

test('a set just under the prompt budget loads with the whole text intact', async () => {
  const server = await rulesGithub({ ruleBytes: 10_000, reviewBytes: 3_000 })
  try {
    const client = new GithubClient('token', server.url)
    const rules = await loadRepoRules(client, 'o', 'r', COMMIT)
    const bytes = Buffer.byteLength(rules.effective, 'utf8')
    assert.ok(bytes <= MAX_RULES_PROMPT_BYTES, `effective text is ${bytes} bytes`)
    assert.ok(bytes > MAX_RULES_PROMPT_BYTES - 4_000)
    assert.match(rules.effective, /^## \.fledge\/rules\.md\nr{10000}\n\n## \.fledge\/review\.md\nv{3000}$/)
    assert.ok(rules.effective.endsWith('v'.repeat(3_000)), 'the last file must not lose bytes')
  } finally {
    await server.close()
  }
})

test('a job that starts during admission answers JOB_ACTIVE before the rule layer is read', async () => {
  // The early active check already answered, so a rule read here can only be a
  // race window: another enqueue inserts a job while this one resolves its base
  // commit. That refusal needs no network and must win over an invalid rule set.
  const base = testConfig()
  const store = new Store(':memory:')
  const user = makeUser(store, { login: 'busy-rules-user', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_busy_rules',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('token', base.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  let raced = false
  const server = await startFakeServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/repos/o/r/branches/main') {
      if (!raced) {
        raced = true
        store.createJob({ id: 'job_raced_rules', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'won the race', callbackHash: 'cb_raced', platformTokenHash: '' })
      }
      json(response, 200, { name: 'main', commit: { sha: COMMIT } })
      return
    }
    if (url.pathname === '/repos/o/r/contents/' || url.pathname === '/repos/o/r/contents') {
      json(response, 200, { type: 'dir' })
      return
    }
    if (url.pathname === '/repos/o/r/contents/.fledge/rules.md') {
      // If the rule layer is read first, this refusal is what the caller sees.
      json(response, 200, { type: 'file', sha: 'rulesha', size: MAX_RULE_FILE_BYTES + 1, encoding: 'base64', content: base64('# Rules\nAlways test.\n') })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
  const configLive = testConfig({
    tokenEncryptionKey: base.tokenEncryptionKey,
    github: { ...base.github, apiBase: server.url },
    flybot: { ...base.flybot, instanceImage: '' },
    runner: { ...base.runner, queueDispatch: false },
  })
  const runner: Runner = { name: 'flybot', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, configLive, runner, new MemoryMailer())
  try {
    const result = await jobs.enqueue(repo, 'manual', 'do the work', 'iterate')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'JOB_ACTIVE', `got ${result.code ?? ''}: ${result.error ?? ''}`)
    assert.equal(store.listJobs(user.id, 10).length, 1)
  } finally {
    await server.close()
    store.close()
  }
})

test('the platform job limit answers JOB_LIMIT before it reads the rule layer', async () => {
  const server = await rulesGithub({ ruleSize: MAX_RULE_FILE_BYTES + 1 })
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: server.url },
    flybot: { ...base.flybot, instanceImage: '' },
    runner: { ...base.runner, queueDispatch: false, maxActiveJobs: 1 },
  })
  const store = new Store(':memory:')
  const runner: Runner = { name: 'flybot', async run() { return { status: 'running' } } }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'limit-rules-user', status: 'approved' })
    const other = store.createRepo({
      id: 'repo_limit_other',
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
    store.createJob({ id: 'job_limit_other', repoId: other.id, userId: user.id, trigger: 'manual', goal: 'running elsewhere', callbackHash: 'cb_limit', platformTokenHash: '' })
    const second = makeUser(store, { login: 'limit-rules-user-two', status: 'approved' })
    const fresh = store.createRepo({
      id: 'repo_limit_fresh',
      userId: second.id,
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
    const result = await jobs.enqueue(fresh, 'manual', 'do the work', 'iterate')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'JOB_LIMIT')
    assert.equal(store.listJobs(user.id, 10).length, 1)
    assert.equal(store.listJobs(second.id, 10).length, 0)
  } finally {
    await server.close()
    store.close()
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

test('an invalid rule set refuses the enqueue with a code the banner can render', async () => {
  // The ceiling refuses the whole set before a job row exists, so the refusal
  // travels as a code on the redirect and the banner has to name the cause.
  const server = await rulesGithub({ ruleSize: MAX_RULE_FILE_BYTES + 1 })
  const base = testConfig()
  const config = testConfig({
    github: { ...base.github, apiBase: server.url },
    flybot: { ...base.flybot, instanceImage: '' },
    runner: { ...base.runner, queueDispatch: false },
  })
  const store = new Store(':memory:')
  const runner: Runner = {
    name: 'flybot',
    async run() {
      return { status: 'running' }
    },
  }
  const jobs = new Jobs(store, config, runner, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'rules-refused', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_rules_refused',
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
    assert.equal(result.ok, false)
    assert.equal(result.code, 'RULES_INVALID')
    assert.equal(result.detail, '.fledge/rules.md is larger than 32768 bytes')
    const value = `${result.code}:${result.detail ?? ''}`
    assert.match(failureBannerSentence('en', value) ?? '', /rules or skills are invalid: \.fledge\/rules\.md is larger than 32768 bytes/)
    assert.match(failureBannerSentence('zh', value) ?? '', /规则或技能不合法：\.fledge\/rules\.md is larger than 32768 bytes/)
  } finally {
    await server.close()
    store.close()
  }
})

test('console overrides bump the revision, refuse a stale write, and clear back to built-in', async () => {
  const store = new Store(':memory:')
  const config = testConfig()
  const server = await rulesGithub({ hasRules: false, skillCount: 0 })
  try {
    const user = makeUser(store, { login: 'override-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_override',
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
    const created = store.upsertRepoRuleOverride({ repoId: repo.id, path: '.fledge/rules.md', content: '# First\n', updatedBy: user.id, expectedRevision: 0 })
    assert.equal(created.ok, true)
    if (!created.ok) throw new Error('expected the first override to be created')
    assert.equal(created.row.revision, 1)

    const stale = store.upsertRepoRuleOverride({ repoId: repo.id, path: '.fledge/rules.md', content: '# Stale\n', updatedBy: user.id, expectedRevision: 0 })
    assert.equal(stale.ok, false)
    if (stale.ok) throw new Error('expected the stale write to be refused')
    assert.equal(stale.code, 'rule_override_conflict')
    assert.equal(stale.revision, 1)
    assert.equal(store.getRepoRuleOverride(repo.id, '.fledge/rules.md')?.content, '# First\n')

    const updated = store.upsertRepoRuleOverride({ repoId: repo.id, path: '.fledge/rules.md', content: '# Second\n', updatedBy: user.id, expectedRevision: 1 })
    assert.equal(updated.ok, true)
    if (!updated.ok) throw new Error('expected the revision-fenced write to succeed')
    assert.equal(updated.row.revision, 2)

    const staleDelete = store.deleteRepoRuleOverride({ repoId: repo.id, path: '.fledge/rules.md', expectedRevision: 1 })
    assert.equal(staleDelete.ok, false)
    if (staleDelete.ok) throw new Error('expected the stale clear to be refused')
    assert.equal(staleDelete.code, 'rule_override_conflict')
    assert.equal(staleDelete.revision, 2)

    const cleared = store.deleteRepoRuleOverride({ repoId: repo.id, path: '.fledge/rules.md', expectedRevision: 2 })
    assert.equal(cleared.ok, true)
    assert.equal(store.listRepoRuleOverrides(repo.id).length, 0)

    const client = new GithubClient('token', server.url)
    const rules = await loadRepoRules(client, 'o', 'r', COMMIT, store.listRepoRuleOverrides(repo.id).map((row) => ({ path: row.path, content: row.content, revision: row.revision })))
    assert.deepEqual(rules.layers.find((layer) => layer.path === '.fledge/rules.md'), { path: '.fledge/rules.md', layer: 'builtin', revision: null })
    assert.equal(rules.effective, '')
  } finally {
    await server.close()
    store.close()
  }
})

test('a console override is the effective layer in the job context when no repository file exists', async () => {
  const server = await rulesGithub({ hasRules: false, skillCount: 0 })
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
    const user = makeUser(store, { login: 'override-job-user', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_override_job',
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
    store.upsertRepoRuleOverride({ repoId: repo.id, path: '.fledge/rules.md', content: '# Console\nAlways use the console override.\n', updatedBy: user.id, expectedRevision: 0 })
    const result = await jobs.enqueue(repo, 'manual', 'do the work', 'iterate')
    assert.equal(result.ok, true, result.error ?? '')
    const job = result.job!
    assert.equal(contexts[0]?.rules?.files[0]?.layer, 'console')
    assert.match(contexts[0]?.rules?.effective ?? '', /Always use the console override/)
    const context = store.getJobContext(job.id)
    const rulesJson = JSON.parse(context?.rules_json ?? '{}') as { layers?: Array<{ path: string; layer: string; revision: number | null }>; files?: Array<{ path: string; layer: string }> }
    assert.deepEqual(rulesJson.layers?.find((layer) => layer.path === '.fledge/rules.md'), { path: '.fledge/rules.md', layer: 'console', revision: 1 })
    assert.deepEqual(rulesJson.layers?.find((layer) => layer.path === '.fledge/review.md'), { path: '.fledge/review.md', layer: 'builtin', revision: null })
    assert.equal(rulesJson.files?.[0]?.layer, 'console')
    assert.equal(store.getJobContextFile(job.id, '.fledge/rules.md')?.content, '# Console\nAlways use the console override.\n')
  } finally {
    await server.close()
    store.close()
  }
})

test('the maintainer rule override form saves with a revision, refuses a stale write and clears', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'rules-maintainer', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_rules_form',
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
    const { cookie, csrf } = sessionFor(built, user)
    const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' }

    const saved = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/rules`,
      headers,
      payload: formBody({ csrf, path: '.fledge/rules.md', content: '# Console\n', expected_revision: '0' }),
    })
    assert.equal(saved.statusCode, 302)
    assert.match(String(saved.headers.location), /saved=/)
    assert.equal(store.getRepoRuleOverride(repo.id, '.fledge/rules.md')?.revision, 1)

    const stale = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/rules`,
      headers,
      payload: formBody({ csrf, path: '.fledge/rules.md', content: '# Stale\n', expected_revision: '0' }),
    })
    // #983: a refused write re-renders the page with the submitted text and the
    // submitted revision, so nothing typed is lost and a blind resubmit stays
    // refused until the maintainer reloads.
    assert.equal(stale.statusCode, 200)
    assert.match(String(stale.headers['content-type']), /text\/html/)
    assert.match(stale.body, /# Stale/)
    assert.match(stale.body, /data-rules-override-conflict="\.fledge\/rules\.md"/)
    const staleForm = stale.body.slice(stale.body.indexOf('data-rules-override-form=".fledge/rules.md"'))
    assert.match(staleForm.slice(0, 400), /name="expected_revision" value="0"/)
    assert.match(staleForm.slice(0, 2000), /# Stale/)
    assert.equal(store.getRepoRuleOverride(repo.id, '.fledge/rules.md')?.content, '# Console\n')

    const skills = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/rules`,
      headers,
      payload: formBody({ csrf, path: '.agents/skills', content: '# Nope\n', expected_revision: '0' }),
    })
    assert.equal(skills.statusCode, 200)
    assert.match(skills.body, /data-rules-override-refused="path_invalid"/)
    assert.match(skills.body, /data-rules-override-kept="\.agents\/skills"/)
    assert.match(skills.body, /# Nope/)

    const cleared = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/rules/delete`,
      headers,
      payload: formBody({ csrf, path: '.fledge/rules.md', expected_revision: '1' }),
    })
    assert.equal(cleared.statusCode, 302)
    assert.match(String(cleared.headers.location), /cleared=/)
    assert.equal(store.getRepoRuleOverride(repo.id, '.fledge/rules.md'), undefined)

    const actions = store.listAudit(20).map((row) => row.action)
    assert.ok(actions.includes('repo.rules_override_saved'))
    assert.ok(actions.includes('repo.rules_override_refused'))
    assert.ok(actions.includes('repo.rules_override_cleared'))

    store.updateRepo(repo.id, { repo_role: 'developer' })
    const denied = await built.app.inject({ method: 'GET', url: `/repos/${repo.id}/rules`, headers: { cookie } })
    assert.equal(denied.statusCode, 403)
  } finally {
    await built.close()
  }
})

test('a refused rule override keeps the submitted text and the submitted revision on the page', async () => {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, startScheduler: false })
  try {
    const user = makeUser(store, { login: 'rules-keeper', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_rules_kept',
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
    const { cookie, csrf } = sessionFor(built, user)
    const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' }
    const post = (values: Record<string, string>) => built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/rules`,
      headers,
      payload: formBody({ csrf, ...values }),
    })

    const empty = await post({ path: '.fledge/rules.md', content: '   ', expected_revision: '0' })
    assert.equal(empty.statusCode, 200)
    assert.match(empty.body, /data-rules-override-refused="content_empty"/)

    const invalid = await post({ path: '.fledge/rules.md', content: '# Nul\n\0 tail\n', expected_revision: '0' })
    assert.equal(invalid.statusCode, 200)
    assert.match(invalid.body, /data-rules-override-refused="content_invalid"/)
    assert.match(invalid.body, /data-rules-override-kept="\.fledge\/rules\.md"/)

    const huge = `# Big\n${'x'.repeat(33 * 1024)}\n983-KEPT-TAIL`
    const tooLarge = await post({ path: '.fledge/rules.md', content: huge, expected_revision: '0' })
    assert.equal(tooLarge.statusCode, 200)
    assert.match(tooLarge.body, /data-rules-override-refused="content_too_large"/)
    assert.ok(tooLarge.body.includes(huge), 'the submitted 33 KiB body is rendered back')

    const badRevision = await post({ path: '.fledge/rules.md', content: '# Revision\n', expected_revision: 'abc' })
    assert.equal(badRevision.statusCode, 200)
    assert.match(badRevision.body, /data-rules-override-refused="revision_invalid"/)
    assert.match(badRevision.body, /# Revision/)
    assert.match(badRevision.body, /name="expected_revision" value="abc"/)

    assert.equal(store.getRepoRuleOverride(repo.id, '.fledge/rules.md'), undefined)
  } finally {
    await built.close()
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
    // docs/rules.md promises that every read is recorded as a job event; a read
    // that leaves no trace cannot be audited after the job is gone.
    const reads = store.listJobEvents(job.id).filter((event) => event.kind === 'job.context_read')
    assert.equal(reads.length, 1)
    assert.equal(reads[0]?.meta, '.fledge/rules.md')
    assert.equal(reads[0]?.step, 'context')

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
