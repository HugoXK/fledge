import test from 'node:test'
import assert from 'node:assert/strict'
import { Store, type RepoRow } from '../src/db.js'
import { Jobs } from '../src/jobs/service.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { managementActor } from '../src/management/actor.js'
import { ManagementService, type CommandEnvelope } from '../src/management/service.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { formBody, makeUser, MemoryMailer, sessionFor, testConfig } from './helpers.js'

// #540 slice 4: the merge-policy block of the console settings form is the first
// non-job write behind the contract. The cases below are the three things that
// make the move worth doing: a replay is a no-op even after a restart, a stale
// page is refused instead of overwriting policy someone else changed, and the
// console path really posts through the command rather than writing the row.

const REPO_ID = 'repo_settings'

interface Harness {
  store: Store
  jobs: Jobs
  service: ManagementService
  userId: string
  repo: RepoRow
}

function harness(permission = 'admin'): Harness {
  const config = testConfig()
  const store = new Store(':memory:')
  const jobs = new Jobs(store, config, { name: 'noop', async run() { return { status: 'running' as const } } }, new MemoryMailer())
  const user = makeUser(store, { login: `settings-${permission}`, status: 'approved' })
  const repo = store.createRepo({
    id: REPO_ID,
    userId: user.id,
    owner: 'o',
    name: 'settings',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission,
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { store, jobs, service: new ManagementService(store, jobs), userId: user.id, repo }
}

function envelope(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
  return {
    operation: 'repo.update',
    target: { projectId: REPO_ID },
    arguments: {
      targetBranch: 'release',
      allowPaths: 'src/**',
      denyPaths: 'deploy/**',
      requireProtection: true,
      stageMode: 'enforced',
      repoRole: 'maintainer',
    },
    expectedRevision: 1,
    idempotencyKey: 'key-settings-1',
    ...overrides,
  }
}

test('repo.update writes the merge policy once and bumps the repository revision', async () => {
  const h = harness()
  const actor = managementActor({ userId: h.userId, repo: h.repo, channel: 'web', requestId: 'req-1' })
  const outcome = await h.service.run(actor, envelope())
  assert.equal(outcome.ok, true, `the command must exist and succeed: ${outcome.ok ? '' : outcome.code}`)
  if (!outcome.ok) return
  assert.equal(outcome.receipt.operation, 'repo.update')
  const row = h.store.getRepo(REPO_ID)
  assert.equal(row?.target_branch, 'release')
  assert.equal(row?.allow_paths, 'src/**')
  assert.equal(row?.deny_paths, 'deploy/**')
  assert.equal(row?.require_protection, 1)
  assert.equal(row?.stage_mode, 'enforced')
  assert.equal(h.store.revisionOf('repo', REPO_ID), 2, 'the write is the event that moves the repository fence')
})

test('a replay is a no-op after a restart, because the receipt is the mechanism', async () => {
  const h = harness()
  const actor = managementActor({ userId: h.userId, repo: h.repo, channel: 'web', requestId: 'req-1' })
  const first = await h.service.run(actor, envelope())
  assert.equal(first.ok, true)
  if (!first.ok) return
  // A new service over the same store is what a process restart looks like: no
  // process memory survives it, so a replay that still answers cannot be an
  // in-memory flag.
  const restarted = new ManagementService(h.store, h.jobs)
  h.store.updateRepo(REPO_ID, { allow_paths: 'someone/else/**' })
  const replay = await restarted.run(actor, envelope())
  assert.equal(replay.ok, true)
  if (!replay.ok) return
  assert.equal(replay.replayed, true)
  assert.equal(replay.receipt.id, first.receipt.id, 'the same key answers with the same receipt')
  assert.equal(h.store.getRepo(REPO_ID)?.allow_paths, 'someone/else/**', 'a replay must not re-apply the arguments')
  assert.equal(h.store.revisionOf('repo', REPO_ID), 2, 'a replay must not move the fence')
})

test('a stale page is refused with management_revision_conflict and writes nothing', async () => {
  const h = harness()
  const actor = managementActor({ userId: h.userId, repo: h.repo, channel: 'web', requestId: 'req-1' })
  assert.equal((await h.service.run(actor, envelope())).ok, true)
  const stale = await h.service.run(actor, envelope({
    idempotencyKey: 'key-settings-stale',
    arguments: { targetBranch: 'main', allowPaths: 'all/**', denyPaths: '', requireProtection: false, stageMode: 'off', repoRole: 'maintainer' },
  }))
  assert.equal(stale.ok, false)
  if (stale.ok) return
  assert.equal(stale.code, 'management_revision_conflict')
  const row = h.store.getRepo(REPO_ID)
  assert.equal(row?.target_branch, 'release', 'the refused write left the policy alone')
  assert.equal(row?.require_protection, 1)
})

test('an argument outside the closed sets is refused, not clamped', async () => {
  const h = harness()
  const actor = managementActor({ userId: h.userId, repo: h.repo, channel: 'web', requestId: 'req-1' })
  const badMode = await h.service.run(actor, envelope({ arguments: { stageMode: 'enforce' } }))
  assert.equal(badMode.ok, false)
  if (badMode.ok) return
  assert.equal(badMode.code, 'invalid_arguments')
  const badBranch = await h.service.run(actor, envelope({ idempotencyKey: 'key-settings-2', arguments: { targetBranch: 'bad branch name' } }))
  assert.equal(badBranch.ok, false)
  if (badBranch.ok) return
  assert.equal(badBranch.code, 'invalid_arguments')
  assert.equal(h.store.getRepo(REPO_ID)?.target_branch, 'main', 'no refused argument reached the row')
  assert.equal(h.store.revisionOf('repo', REPO_ID), 1)
})

test('a role the connection cannot hold is refused by the command, not only by the form', async () => {
  const h = harness('read')
  const actor = managementActor({ userId: h.userId, repo: h.repo, channel: 'web', requestId: 'req-1' })
  const outcome = await h.service.run(actor, envelope({ arguments: { repoRole: 'maintainer' } }))
  assert.equal(outcome.ok, false)
  if (outcome.ok) return
  assert.equal(outcome.code, 'repo_role_not_allowed')
  assert.equal(h.store.getRepo(REPO_ID)?.repo_role, 'maintainer', 'the seeded role is untouched, the refusal changed nothing else')
})

interface PageFixture {
  built: BuiltApp
  user: ReturnType<typeof makeUser>
  close: () => Promise<void>
}

async function pageFixture(): Promise<PageFixture> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  const user = makeUser(store, { login: 'settings-page', status: 'approved' })
  store.createRepo({
    id: REPO_ID,
    userId: user.id,
    owner: 'o',
    name: 'settings-page',
    defaultBranch: 'main',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  return { built, user, close: async () => { await built.close() } }
}

test('the settings form renders the revision it saw and a key, and the submit goes through the command', async () => {
  const f = await pageFixture()
  try {
    const session = sessionFor(f.built, f.user)
    const page = await f.built.app.inject({ method: 'GET', url: `/repos/${REPO_ID}`, headers: { cookie: session.cookie } })
    assert.equal(page.statusCode, 200)
    const html = page.body
    const start = html.indexOf(`action="/repos/${REPO_ID}/settings"`)
    assert.notEqual(start, -1, 'the settings form still posts to the settings route')
    const from = html.lastIndexOf('<form', start)
    const form = html.slice(from, html.indexOf('</form>', start))
    assert.match(form, /name="expected_revision"/, 'the form carries the repository revision it rendered')
    assert.match(form, /name="idempotency_key"/, 'the form carries the key a replay is recognised by')

    const post = async (payload: Record<string, string>): Promise<{ statusCode: number; location: string }> => {
      const response = await f.built.app.inject({
        method: 'POST',
        url: `/repos/${REPO_ID}/settings`,
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: session.cookie },
        payload: formBody({ csrf: session.csrf, ...payload }),
      })
      return { statusCode: response.statusCode, location: String(response.headers.location) }
    }

    // The target branch is left at the repository default on purpose: a changed
    // target branch makes the route read the branch upstream, and this test is
    // about the write path, not the GitHub read.
    const first = await post({
      expected_revision: '1',
      idempotency_key: 'key-page-1',
      targetBranch: 'main',
      requireProtection: '1',
      allowPaths: 'src/**',
      denyPaths: 'deploy/**',
      stageMode: 'enforced',
      repoRole: 'maintainer',
    })
    assert.equal(first.statusCode, 302, `the submit redirects back to the page: ${first.location}`)
    assert.doesNotMatch(first.location, /error=/, `the submit was accepted: ${first.location}`)
    const written = f.built.store?.getRepo(REPO_ID)
    assert.equal(written?.allow_paths, 'src/**')
    assert.equal(written?.deny_paths, 'deploy/**')
    assert.equal(written?.stage_mode, 'enforced')
    assert.equal(written?.require_protection, 1)

    // The same submit again — a refresh, a double click, a retried proxy — is the
    // receipt's answer, not a second write.
    const replay = await post({
      expected_revision: '1',
      idempotency_key: 'key-page-1',
      targetBranch: 'main',
      requireProtection: '1',
      allowPaths: 'src/**',
      denyPaths: 'deploy/**',
      stageMode: 'enforced',
      repoRole: 'maintainer',
    })
    assert.equal(replay.statusCode, 302)
    assert.equal(f.built.store?.revisionOf('repo', REPO_ID), 2, 'the replay did not move the fence a second time')
  } finally {
    await f.close()
  }
})
