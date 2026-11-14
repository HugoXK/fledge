import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { ENQUEUE_REFUSAL_CODES, REFUSAL_SENTENCES, failureBannerSentence } from '../src/lib/failure.js'
import { encryptSecret } from '../src/lib/secrets.js'
import type { InstanceManager } from '../src/flybot/instances.js'
import { json, makeUser, MemoryMailer, formBody, sessionFor, startFakeServer, testConfig } from './helpers.js'

const CJK = /[\u3400-\u9fff]/
const LEAK = /ECONNREFUSED|127\.0\.0\.1|8080|HttpError|500/

function banner(html: string): string {
  return /<div class="banner bad" role="alert">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
}

function makeRepo(store: Store, userId: string) {
  return store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 10)}`,
    userId,
    owner: 'acme',
    name: 'demo',
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
}

// #611: every code the enqueue path can put on the redirect has one bilingual
// sentence, and the table is locked to the code tuple. A code added to the tuple
// with no table entry fails typecheck; this test pins the runtime shape so a
// half-filled entry cannot ship either.
test('every enqueue refusal code has a complete bilingual sentence', () => {
  assert.deepEqual(
    Object.keys(REFUSAL_SENTENCES).sort(),
    [...ENQUEUE_REFUSAL_CODES].sort(),
    'the refusal sentence table and the enqueue code tuple drifted',
  )
  for (const code of ENQUEUE_REFUSAL_CODES) {
    const [zh, en] = REFUSAL_SENTENCES[code]
    assert.ok(zh.trim() !== '', `${code} has no Chinese sentence`)
    assert.ok(en.trim() !== '', `${code} has no English sentence`)
    assert.notEqual(zh, en, `${code} does not carry two languages`)
  }
})

// The banner itself, for every code, not only the twelve that were missing: a
// table entry that still renders the writer's Chinese, or a bare parameter, is
// the same failure in a new place.
test('every enqueue refusal reaches the English banner as an English sentence', () => {
  for (const code of ENQUEUE_REFUSAL_CODES) {
    const english = failureBannerSentence('en', `${code}:sample-value`)
    const chinese = failureBannerSentence('zh', `${code}:sample-value`)
    assert.ok(english !== null && english !== '', `${code} produced no English banner`)
    assert.doesNotMatch(english, CJK, `${code} leaked Chinese into the English banner: ${english}`)
    assert.ok(chinese !== null && chinese !== '', `${code} produced no Chinese banner`)
    assert.match(chinese, CJK, `${code} produced no Chinese sentence: ${chinese}`)
  }
})

// The triage pair was three meanings behind one code. The mismatch is its own
// code with `<kind>/<type>`; an unknown token stays unknown, and a declared type
// with no handler is still its own code. `scope` is only reachable as an unknown
// token, `docs` only as an unimplemented type.
test('the work-type refusals separate mismatch, unknown token and missing handler', async () => {
  const store = new Store(':memory:')
  const jobs = new Jobs(store, testConfig(), { name: 'noop', async run() { return { status: 'running' } } }, new MemoryMailer())
  try {
    const user = makeUser(store, { login: 'work-type-refusals', status: 'approved' })
    const repo = makeRepo(store, user.id)

    const mismatch = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workType: 'triage' })
    assert.equal(mismatch.code, 'WORK_TYPE_MISMATCH')
    assert.equal(mismatch.detail, 'iterate/triage')
    const mismatchBanner = failureBannerSentence('en', `${mismatch.code}:${mismatch.detail}`)
    assert.match(mismatchBanner ?? '', /iterate\/triage/, 'the mismatch banner does not name the pair')
    assert.doesNotMatch(mismatchBanner ?? '', CJK, `the mismatch banner leaked Chinese: ${mismatchBanner}`)

    const unknown = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workType: 'scope' })
    assert.equal(unknown.code, 'UNKNOWN_WORK_TYPE')
    assert.equal(unknown.detail, 'scope')
    const unknownBanner = failureBannerSentence('en', `${unknown.code}:${unknown.detail}`)
    assert.notEqual(unknownBanner, 'scope', 'the unknown work type is still the bare token')
    assert.match(unknownBanner ?? '', /unknown work type/i, `the unknown work type lost its sentence: ${unknownBanner}`)
    assert.doesNotMatch(unknownBanner ?? '', CJK, `the unknown work type leaked Chinese: ${unknownBanner}`)

    const unsupported = await jobs.enqueue(repo, 'manual', undefined, 'iterate', { workType: 'docs' })
    assert.equal(unsupported.code, 'WORK_TYPE_UNSUPPORTED')
    assert.equal(unsupported.detail, 'docs')
    const unsupportedBanner = failureBannerSentence('en', `${unsupported.code}:${unsupported.detail}`)
    assert.match(unsupportedBanner ?? '', /not implemented/i, `the unsupported type lost its sentence: ${unsupportedBanner}`)
    assert.doesNotMatch(unsupportedBanner ?? '', /\bdocs\b/i, 'the unsupported type is still the bare payload token')
  } finally {
    store.close()
  }
})

// An exception's text used to travel as the refusal payload and land in the
// banner, so the bridge port and a raw upstream error class reached the URL and
// the page. The sentence is fixed now; the upstream text stays only in the audit
// row that the route writes.
test('INSTANCE_NOT_READY hides the bridge host and port from the banner but keeps it in the audit row', async () => {
  const store = new Store(':memory:')
  const mailer = new MemoryMailer()
  const base = testConfig()
  const upstream = 'ECONNREFUSED 127.0.0.1:8080'
  const config = { ...base, flybot: { ...base.flybot, instanceImage: 'fledge/test' }, runner: { ...base.runner, queueDispatch: false } }
  const instances = {
    ensurePlaybook: async () => undefined,
    refreshTeam: async () => undefined,
    bridgeFor: () => { throw new Error(upstream) },
    applyBotModels: async () => ({ updated: 0, skipped: [] }),
  } as unknown as InstanceManager
  const built = await buildApp({
    config,
    store,
    mailer,
    runner: { name: 'flybot', async run() { return { status: 'running' } } },
    startScheduler: false,
    instances,
  })
  try {
    const user = makeUser(built.store, { login: 'instance-not-ready', status: 'approved' })
    const repo = makeRepo(built.store, user.id)
    const session = sessionFor(built, user)
    const response = await built.app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/plan`,
      headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: formBody({ csrf: session.csrf }),
    })
    assert.equal(response.statusCode, 302)
    const location = String(response.headers.location)
    assert.match(location, /error=INSTANCE_NOT_READY(?:%3A|:)/, `the redirect did not carry the refusal code: ${location}`)

    const page = await built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie, 'accept-language': 'en' } })
    assert.equal(page.statusCode, 200)
    const text = banner(page.body)
    assert.match(text, /FlyBot instance is not ready/i, `the banner lost the fixed sentence: ${text}`)
    assert.doesNotMatch(text, LEAK, `the banner leaked the upstream exception text: ${text}`)

    // #540 moved the console writes behind the management contract, so a refused
    // plan is now one `management.command` row rather than `plan.enqueued`. The
    // operator copy stays with it: the row records the refusal code and the value
    // the service named.
    const audit = built.store.listAudit(50).find((row) => row.action === 'management.command' && (row.detail ?? '').includes('status=failed'))
    assert.ok(audit !== undefined, 'the refusal was not audited in the command ledger')
    assert.match(audit.detail ?? '', /ECONNREFUSED 127\.0\.0\.1:8080/, `the audit row lost the operator copy: ${audit.detail}`)
  } finally {
    await built.close()
  }
})

// `PREFLIGHT_FAILED:HttpError: 500` splits at the first colon like every other
// refusal, so the fixed sentence has to ignore the remainder entirely.
test('PREFLIGHT_FAILED hides the upstream error class and status from the banner but keeps them in the audit row', async () => {
  const github = await startFakeServer((_request, response) => {
    json(response, 500, { message: 'HttpError: 500' })
  })
  const base = testConfig()
  const config = testConfig({ github: { ...base.github, apiBase: github.url }, runner: { ...base.runner, queueDispatch: false } })
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'preflight-failed', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_preflight_failed',
      userId: user.id,
      owner: 'acme',
      name: 'demo',
      defaultBranch: 'main',
      tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const item = store.createWorkItem({ id: 'wi_preflight', repoId: repo.id, userId: user.id, title: 'fix one thing' })
    const built = await buildApp({
      config,
      store,
      mailer: new MemoryMailer(),
      runner: { name: 'flybot', async run() { return { status: 'running' } } },
      startScheduler: false,
    })
    try {
      const session = sessionFor(built, user)
      const response = await built.app.inject({
        method: 'POST',
        url: `/repos/${repo.id}/work/${item.id}/run`,
        headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: formBody({ csrf: session.csrf }),
      })
      assert.equal(response.statusCode, 302)
      const location = String(response.headers.location)
      assert.match(location, /error=PREFLIGHT_FAILED(?:%3A|:)/, `the redirect did not carry the refusal code: ${location}`)

      const page = await built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie, 'accept-language': 'en' } })
      assert.equal(page.statusCode, 200)
      const text = banner(page.body)
      assert.match(text, /preflight check failed/i, `the banner lost the fixed sentence: ${text}`)
      assert.doesNotMatch(text, LEAK, `the banner leaked the upstream exception text: ${text}`)

      // The same move as the plan route above: `task.create` owns the write, so the
      // refusal lives in the command ledger instead of a `work_item.run` row.
      const audit = built.store.listAudit(50).find((row) => row.action === 'management.command' && (row.detail ?? '').includes('status=failed'))
      assert.ok(audit !== undefined, 'the refusal was not audited in the command ledger')
      assert.match(audit.detail ?? '', /HttpError: 500/, `the audit row lost the operator copy: ${audit.detail}`)
    } finally {
      await built.close()
    }
  } finally {
    await github.close()
  }
})
