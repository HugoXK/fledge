import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { assembleStrategy, fuseStrategies, strategyHash, strategyRefusal } from '../src/strategy/bundle.js'
import { flashOf, formBody, makeUser, sessionFor, testConfig } from './helpers.js'

// #433 slice 1: a repository's development strategy is one content-addressed
// bundle. The hash is decided by the section map, a candidate is frozen against
// the base version the page showed, and a frozen section (evaluator, CI, gate,
// auth, gateway, capability) can never enter a bundle. Nothing here promotes:
// `stable` moves only in a later slice with human approval.

const SECTIONS = {
  'rules:review': 'file:.github/rules/review.md@abc123',
  'playbook:reviewer': 'playbook:v8:deadbeef',
  'routing:review': 'console:revision:2',
}

test('the bundle hash depends on the sections, not on their order', () => {
  const first = strategyHash(SECTIONS)
  const reordered = strategyHash({ 'routing:review': SECTIONS['routing:review'], 'rules:review': SECTIONS['rules:review'], 'playbook:reviewer': SECTIONS['playbook:reviewer'] })
  assert.equal(first, reordered, 'the same sections in another order must hash the same')
  const changed = strategyHash({ ...SECTIONS, 'rules:review': 'file:.github/rules/review.md@def456' })
  assert.notEqual(changed, first, 'a changed section value must change the hash')
  assert.match(first, /^[0-9a-f]{64}$/)
})

test('a frozen section is refused before anything is evaluated or written', () => {
  const refused = assembleStrategy({
    sections: { ...SECTIONS, 'evaluator:score': 'file:.agents/evaluator.md@abc123' },
  })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'frozen_section')
  assert.deepEqual(refused.keys, ['evaluator:score'])
  assert.equal(strategyRefusal(refused), 'the strategy names a frozen section (evaluator:score); the evaluator, evidence, CI, merge gate, auth, gateway and capability checks are never evolved by a strategy')
  // Every frozen family is refused, not just the one the test names first.
  for (const key of ['evidence:build', 'ci:workflow', 'gate:merge', 'auth:session', 'gateway:route', 'capability:scopes']) {
    const result = assembleStrategy({ sections: { ...SECTIONS, [key]: 'x' } })
    assert.equal(result.ok, false, `${key} was allowed into a strategy`)
  }
  const allowed = assembleStrategy({ sections: SECTIONS })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.ok && allowed.hash, strategyHash(SECTIONS))
})

test('two candidates on different keys fuse, and two on the same key conflict cleanly', () => {
  const fused = fuseStrategies({ ...SECTIONS, 'rules:review': 'file:.github/rules/review.md@aaa111' }, { 'rules:review': 'file:.github/rules/review.md@bbb222', 'template:bug': 'file:.github/templates/bug.md@ccc333' })
  assert.equal(fused.ok, false, 'the same key with two values must not fuse')
  assert.deepEqual(fused.ok === false ? fused.conflicts : [], ['rules:review'])
  const disjoint = fuseStrategies(SECTIONS, { 'template:bug': 'file:.github/templates/bug.md@ccc333' })
  assert.equal(disjoint.ok, true)
  assert.deepEqual(Object.keys(disjoint.ok === true ? disjoint.sections : {}).sort(), [...Object.keys(SECTIONS), 'template:bug'].sort())
})

async function harness() {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: undefined, runner: new MockRunner(), startScheduler: false })
  const user = makeUser(store, { login: 'strategy-user', status: 'approved' })
  const other = makeUser(store, { login: 'strategy-other', status: 'approved' })
  const repo = store.createRepo({
    id: 'repo_strategy',
    userId: user.id,
    owner: 'o',
    name: 'r',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    autoMerge: false,
    roleCheckedAt: new Date().toISOString(),
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const foreign = store.createRepo({
    id: 'repo_strategy_other',
    userId: other.id,
    owner: 'o2',
    name: 'r2',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    autoMerge: false,
    roleCheckedAt: new Date().toISOString(),
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const session = sessionFor(built, user)
  const page = (location: string) => built.app.inject({ method: 'GET', url: location, headers: { cookie: session.cookie, 'accept-language': 'en' } })
  const freeze = (values: Record<string, string> = {}) => built.app.inject({
    method: 'POST',
    url: `/repos/${repo.id}/strategy`,
    headers: { cookie: session.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: formBody({ csrf: session.csrf, base: '0', confirm: '1', ...values }),
  })
  return { built, store, user, other, repo, foreign, session, page, freeze, close: async () => { await built.close() } }
}

test('the strategy page shows the bundle version and hash a maintainer is on', async () => {
  const h = await harness()
  try {
    const response = await h.page(`/repos/${h.repo.id}/strategy`)
    assert.equal(response.statusCode, 200)
    assert.match(response.body, /strategy/i)
    assert.match(response.body, /candidate/)
    assert.match(response.body, /stable/)
  } finally {
    await h.close()
  }
})

test('a stale base is refused by CAS, names both versions, and moves nothing', async () => {
  const h = await harness()
  try {
    const base = strategyHash(SECTIONS)
    const first = h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: SECTIONS, createdBy: h.user.login, expectedBase: 0 })
    assert.equal(first.ok, true)
    assert.equal(first.ok && first.version, 1)
    const stale = h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: { ...SECTIONS, 'template:bug': 'file:x@y' }, createdBy: h.user.login, expectedBase: 0 })
    assert.equal(stale.ok, false)
    assert.equal(stale.ok === false && stale.code, 'stale_base')
    assert.equal(stale.ok === false && stale.candidate, 1)
    assert.equal(h.store.strategyBundle(h.repo.id, 2), undefined, 'a refused candidate was still written')
    assert.equal(h.store.strategyPointers(h.repo.id).candidate?.version, 1, 'a refused candidate moved the pointer')
    assert.equal(h.store.strategyPointers(h.repo.id).stable, null, 'slice 1 must never move stable')
    assert.equal(h.store.strategyBundle(h.repo.id, 1)?.hash, base)
  } finally {
    await h.close()
  }
})

test('an accepted candidate moves only the candidate pointer', async () => {
  const h = await harness()
  try {
    const first = h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: SECTIONS, createdBy: h.user.login, expectedBase: 0 })
    assert.equal(first.ok, true)
    const second = h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: { ...SECTIONS, 'template:bug': 'file:x@y' }, createdBy: h.user.login, expectedBase: 1 })
    assert.equal(second.ok, true)
    assert.equal(second.ok && second.version, 2)
    assert.equal(second.ok && second.parentVersion, 1, 'the accepted candidate does not record its parent')
    const pointers = h.store.strategyPointers(h.repo.id)
    assert.equal(pointers.candidate?.version, 2)
    assert.equal(pointers.stable, null, 'freezing a candidate moved stable')
    // Both versions stay readable.
    assert.equal(h.store.strategyBundle(h.repo.id, 1)?.hash, strategyHash(SECTIONS))
    assert.ok(h.store.strategyBundle(h.repo.id, 2) !== undefined)
  } finally {
    await h.close()
  }
})

test('freezing content that is already stored moves the candidate back to that bundle', async () => {
  const h = await harness()
  try {
    const first = h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: SECTIONS, createdBy: h.user.login, expectedBase: 0 })
    assert.equal(first.ok && first.version, 1)
    const second = h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: { ...SECTIONS, 'template:bug': 'file:x@y' }, createdBy: h.user.login, expectedBase: 1 })
    assert.equal(second.ok && second.version, 2)
    assert.equal(h.store.strategyPointers(h.repo.id).candidate?.version, 2)
    // The repository's sources return to content that was frozen before. The hash
    // is the identity, so no third bundle is written — but the button freezes the
    // strategy the page composes now, so the candidate must name that bundle and
    // not the one it was on.
    const again = h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: SECTIONS, createdBy: h.user.login, expectedBase: 2 })
    assert.equal(again.ok, true)
    assert.equal(again.ok && again.version, 1, 'the existing bundle was reported under the wrong version')
    assert.equal(again.ok && again.duplicate, true, 'a repeated content freeze was not reported as the existing bundle')
    const pointers = h.store.strategyPointers(h.repo.id)
    assert.equal(pointers.candidate?.version, 1, 'the candidate pointer still names a bundle whose content is not what the page assembles')
    assert.equal(pointers.candidate?.hash, strategyHash(SECTIONS), 'the candidate pointer names the wrong content')
    assert.equal(h.store.strategyBundle(h.repo.id, 3), undefined, 'a repeated content freeze wrote a third bundle')
    assert.equal(h.store.listStrategyBundles(h.repo.id).length, 2, 'a repeated content freeze changed the bundle count')
    assert.equal(pointers.stable, null, 'a repeated content freeze moved stable')
  } finally {
    await h.close()
  }
})

test('one repository can never read another repository bundle', async () => {
  const h = await harness()
  try {
    const foreign = h.store.freezeStrategyCandidate({ repoId: h.foreign.id, sections: { 'rules:review': 'file:other@z' }, createdBy: h.other.login, expectedBase: 0 })
    assert.equal(foreign.ok, true)
    assert.equal(h.store.strategyBundle(h.repo.id, 1), undefined, 'a bundle leaked across repositories')
    assert.equal(h.store.strategyPointers(h.repo.id).candidate, null)
    const denied = await h.page(`/repos/${h.foreign.id}/strategy`)
    assert.notEqual(denied.statusCode, 200, 'a non-owner read another repository strategy page')
  } finally {
    await h.close()
  }
})

test('freezing from the page refuses a stale base and writes no bundle', async () => {
  const h = await harness()
  try {
    h.store.freezeStrategyCandidate({ repoId: h.repo.id, sections: SECTIONS, createdBy: h.user.login, expectedBase: 0 })
    const response = await h.freeze({ base: '0' })
    assert.equal(response.statusCode, 302)
    const flash = flashOf(response)
    const text = `${flash?.error?.text ?? ''}${flash?.outcome?.text ?? ''}`
    assert.match(text, /base/, `the refusal does not name the stale base: ${text}`)
    assert.equal(h.store.strategyBundle(h.repo.id, 2), undefined, 'a stale form still wrote a bundle')
  } finally {
    await h.close()
  }
})

test('a frozen section in the sources is refused and writes nothing', async () => {
  const h = await harness()
  try {
    h.store.upsertRepoRuleOverride({ repoId: h.repo.id, path: 'evaluator/score.md', content: 'x', updatedBy: h.user.login, expectedRevision: 0 })
    const response = await h.freeze({ base: '0' })
    assert.equal(response.statusCode, 302)
    const flash = flashOf(response)
    assert.match(`${flash?.error?.text ?? ''}${flash?.outcome?.text ?? ''}`, /frozen/, 'the refusal does not name the frozen section')
    assert.equal(h.store.strategyBundle(h.repo.id, 1), undefined, 'a frozen section reached the store')
    assert.equal(h.store.strategyPointers(h.repo.id).candidate, null)
  } finally {
    await h.close()
  }
})

test('the page form freezes the current strategy and reports the new version', async () => {
  const h = await harness()
  try {
    const response = await h.freeze({ base: '0' })
    assert.equal(response.statusCode, 302)
    const flash = flashOf(response)
    assert.match(`${flash?.outcome?.text ?? ''}${flash?.notice?.text ?? ''}`, /1/, 'the created version is not reported')
    const pointers = h.store.strategyPointers(h.repo.id)
    assert.equal(pointers.candidate?.version, 1)
    assert.equal(pointers.stable, null)
    const page = await h.page(`/repos/${h.repo.id}/strategy`)
    assert.match(page.body, new RegExp(String(pointers.candidate?.hash ?? 'never').slice(0, 12)), 'the page does not show the bundle hash it is on')
  } finally {
    await h.close()
  }
})
