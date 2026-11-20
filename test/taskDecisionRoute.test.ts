import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { buildApp, type BuiltApp } from '../src/app.js'
import { MemoryMailer, flashOf, formBody, makeUser, sessionFor, testConfig } from './helpers.js'

// #639: the post-QA decision is one bounded write, reached from the job page
// where a verify or review run ends. The page preselects the framework default
// (a separate P2 task) so an undecided follow-up is still an ordinary task, and
// the route names every refusal in the request's own language.

interface Fixture {
  built: BuiltApp
  store: Store
  user: ReturnType<typeof makeUser>
  repoId: string
  verifyId: string
  existedTaskId: string
  existedJobId: string
  close: () => Promise<void>
}

async function fixture(tag: string, repoRole: string | null = 'maintainer'): Promise<Fixture> {
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({
    config,
    store,
    mailer: new MemoryMailer(),
    runner: { name: 'capture', async run() { return { status: 'running' as const } } },
    startScheduler: false,
  })
  const user = makeUser(store, { login: `decision-route-${tag}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_decision_${tag}`,
    userId: user.id,
    owner: 'o',
    name: `decision-${tag}`,
    defaultBranch: 'main',
    tokenEnc: 'x',
    permission: 'admin',
    // #1113: a repository connected before any role was checked records NULL,
    // and the caller decides whether this fixture is that shape.
    repoRole,
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  // The earlier task is finished, so `jobs_one_active_per_repo` lets the verify
  // run exist beside it and the decision can name it.
  const earlier = store.createJob({
    id: `job_decision_${tag}_earlier`,
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'fix the flaky retry',
    callbackHash: `cba-${tag}`,
    platformTokenHash: '',
  })
  store.updateJob(earlier.id, { status: 'succeeded' })
  const existed = store.createWorkItem({
    id: `work_decision_${tag}_existed`,
    repoId: repo.id,
    userId: user.id,
    title: 'the retry helper loses the attempt count',
    detail: 'Reported twice.',
    state: 'proposed',
    priority: 10,
    jobId: earlier.id,
  })
  const verify = store.createJob({
    id: `job_decision_${tag}_verify`,
    repoId: repo.id,
    userId: user.id,
    trigger: 'manual',
    goal: 'verify the retry fix',
    callbackHash: `cbv-${tag}`,
    platformTokenHash: '',
    kind: 'verify',
    workItemId: existed.id,
  })
  store.updateJob(verify.id, { status: 'succeeded' })
  return {
    built,
    store,
    user,
    repoId: repo.id,
    verifyId: verify.id,
    existedTaskId: existed.id,
    existedJobId: earlier.id,
    close: async () => { await built.close() },
  }
}

async function post(f: Fixture, locale: 'zh' | 'en', payload: Record<string, string>): Promise<{ statusCode: number; location: string; flash: ReturnType<typeof flashOf> }> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({
    method: 'POST',
    url: `/repos/${f.repoId}/jobs/${f.verifyId}/decision`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${session.cookie}; fledge_lang=${locale}` },
    payload: formBody({ csrf: session.csrf, ...payload }),
  })
  return { statusCode: response.statusCode, location: decodeURIComponent(String(response.headers.location ?? '')), flash: flashOf(response) }
}

async function page(f: Fixture, jobId: string): Promise<string> {
  const session = sessionFor(f.built, f.user)
  const response = await f.built.app.inject({ method: 'GET', url: `/repos/${f.repoId}/jobs/${jobId}`, headers: { cookie: session.cookie } })
  assert.equal(response.statusCode, 200)
  return response.body
}

const good = { reason: 'the retry helper is still wrong in the second call site', evidence: 'https://github.com/o/r/pull/9#discussion_r1' }

test('a decision without checkable evidence is refused in English for an English request', async () => {
  const f = await fixture('en')
  try {
    const before = f.store.listWorkItems(f.repoId).length
    const response = await post(f, 'en', { ...good, kind: 'new', title: 'another retry fix', evidence: 'obviously needed' })
    assert.equal(response.statusCode, 302)
    assert.ok(response.flash?.error)
    assert.match(response.flash?.error?.text ?? '', /checkable evidence/)
    assert.doesNotMatch(response.flash?.error?.text ?? '', /可核对的证据/, 'the English page does not carry the Chinese sentence')
    assert.equal(f.store.listWorkItems(f.repoId).length, before, 'a refused decision writes no task')
  } finally {
    await f.close()
  }
})

test('the same refusal is Chinese for a Chinese request', async () => {
  const f = await fixture('zh')
  try {
    const response = await post(f, 'zh', { ...good, kind: 'new', title: '再修一次', evidence: '显然需要' })
    assert.ok(response.flash?.error)
    assert.match(response.flash?.error?.text ?? '', /可核对的证据/)
    assert.doesNotMatch(response.flash?.error?.text ?? '', /checkable evidence/)
  } finally {
    await f.close()
  }
})

test('a new task gets the framework default level and one audit row', async () => {
  const f = await fixture('new')
  try {
    const response = await post(f, 'en', { ...good, kind: 'new', title: 'fix the second call site' })
    assert.ok(response.flash?.notice)
    assert.match(response.flash?.notice?.text ?? '', /Recorded as the next step/)
    const created = f.store.listWorkItems(f.repoId).filter((item) => item.title === 'fix the second call site')
    assert.equal(created.length, 1)
    assert.equal(created[0]?.priority, 10, 'P2 is the framework default')
    assert.equal(created[0]?.state, 'proposed')
    const audits = f.store.listAudit(50).filter((entry) => entry.action === 'task.decision_new')
    assert.equal(audits.length, 1)
  } finally {
    await f.close()
  }
})

test('new plus an existing task id is repaired once into related, not duplicated', async () => {
  const f = await fixture('repair')
  try {
    const before = f.store.listWorkItems(f.repoId).length
    const response = await post(f, 'en', { ...good, kind: 'new', title: 'the same retry helper', existing_task_id: f.existedTaskId })
    assert.ok(response.flash?.notice)
    assert.match(response.flash?.notice?.text ?? '', /repaired once into related/)
    assert.equal(f.store.listWorkItems(f.repoId).length, before + 1, 'the repair still opens the follow-up task')
    const relations = f.store.listTaskRelations(f.verifyId)
    assert.equal(relations.length, 1)
    assert.equal(relations[0]?.kind, 'related')
    assert.equal(relations[0]?.target_job_id, f.existedJobId)
    assert.equal(f.store.listAudit(50).some((entry) => entry.action === 'task.decision_related'), true)
    assert.equal(f.store.listAudit(50).some((entry) => entry.action === 'task.decision_new'), false, 'the contradictory answer does not also count as new')
  } finally {
    await f.close()
  }
})

test('supplement appends to the existing task and starts no second execution', async () => {
  const f = await fixture('supp')
  try {
    const before = f.store.listWorkItems(f.repoId).length
    const jobsBefore = f.store.listWorkItems(f.repoId).map((item) => item.job_id).join(',')
    const response = await post(f, 'en', { ...good, kind: 'supplement', existing_task_id: f.existedTaskId })
    assert.match(response.flash?.notice?.text ?? '', /Supplement an existing task/)
    assert.equal(f.store.listWorkItems(f.repoId).length, before, 'a supplement opens no task')
    assert.equal(f.store.listWorkItems(f.repoId).map((item) => item.job_id).join(','), jobsBefore, 'and no second execution')
    assert.match(String(f.store.getWorkItem(f.existedTaskId)?.detail), /second call site/)
    assert.equal(f.store.listAudit(50).some((entry) => entry.action === 'task.decision_supplement'), true)
  } finally {
    await f.close()
  }
})

test('supplement without a task id is refused instead of silently opening one', async () => {
  const f = await fixture('noTarget')
  try {
    const before = f.store.listWorkItems(f.repoId).length
    const response = await post(f, 'en', { ...good, kind: 'supplement' })
    assert.ok(response.flash?.error)
    assert.match(response.flash?.error?.text ?? '', /name an existing task/)
    assert.equal(f.store.listWorkItems(f.repoId).length, before)
  } finally {
    await f.close()
  }
})

test('the job page offers the decision where a verify run ends and preselects the default', async () => {
  const f = await fixture('page')
  try {
    const html = await page(f, f.verifyId)
    assert.match(html, /id="decision"/)
    assert.match(html, /data-decision-default>new · P2</)
    assert.match(html, /name="kind"/)
    assert.match(html, /<option value="new" selected>/)
    assert.match(html, /<option value="P2" selected>/)
    assert.match(html, /下一步/, 'the Chinese label is present for the default zh page')
  } finally {
    await f.close()
  }
})

test('an iterate job does not offer the post-QA decision', async () => {
  const f = await fixture('noCard')
  try {
    const html = await page(f, f.existedJobId)
    assert.doesNotMatch(html, /id="decision"/)
  } finally {
    await f.close()
  }
})

// #639 review round: the task used to be inserted before the two refusals, so a
// `related` decision the page reported as failed still left a `proposed` task and
// no audit row. A decision that cannot write its relation now writes nothing.
test('a related decision on a task that never ran writes no task and no decision audit row', async () => {
  const f = await fixture('neverran')
  try {
    // A triage-created task has no job yet, so there is no target to relate to.
    const pending = f.store.createWorkItem({
      id: 'work_decision_neverran_pending',
      repoId: f.repoId,
      userId: f.user.id,
      title: 'triaged, not run yet',
      detail: 'Waiting for a run.',
      state: 'proposed',
      priority: 10,
    })
    assert.equal(pending.job_id, null)
    const before = f.store.listWorkItems(f.repoId).length
    const audits = () => f.store.listAudit(200).filter((entry) => entry.action.startsWith('task.decision_')).length
    const auditsBefore = audits()

    const payload = { ...good, kind: 'related', existing_task_id: pending.id, title: 'relate the triaged task' }
    for (const attempt of [1, 2]) {
      const response = await post(f, 'en', payload)
      assert.equal(response.statusCode, 302, `attempt ${attempt} redirects`)
      assert.ok(response.flash?.error, `attempt ${attempt} is a refusal`)
      assert.equal(f.store.listWorkItems(f.repoId).length, before, `attempt ${attempt} writes no task`)
      assert.equal(audits(), auditsBefore, `attempt ${attempt} writes no decision audit row`)
    }
    assert.equal(f.store.listWorkItems(f.repoId).filter((item) => item.title === 'relate the triaged task').length, 0)
  } finally {
    await f.close()
  }
})

test('a related decision pointing at the decision job itself writes no task', async () => {
  const f = await fixture('self')
  try {
    const own = f.store.createWorkItem({
      id: 'work_decision_self_own',
      repoId: f.repoId,
      userId: f.user.id,
      title: 'the task this verify run belongs to',
      detail: '',
      state: 'proposed',
      priority: 10,
      jobId: f.verifyId,
    })
    assert.equal(own.job_id, f.verifyId)
    const before = f.store.listWorkItems(f.repoId).length
    const audits = () => f.store.listAudit(200).filter((entry) => entry.action.startsWith('task.decision_')).length
    const auditsBefore = audits()

    const response = await post(f, 'en', { ...good, kind: 'related', existing_task_id: own.id, title: 'relate this very run' })
    assert.equal(response.statusCode, 302)
    assert.ok(response.flash?.error)
    assert.match(response.flash?.error?.text ?? '', /itself/)
    assert.equal(f.store.listWorkItems(f.repoId).length, before, 'a self relation writes no task')
    assert.equal(audits(), auditsBefore, 'a self relation writes no decision audit row')
  } finally {
    await f.close()
  }
})

test('a related decision on a task that did run still writes the task and one relation', async () => {
  const f = await fixture('ok')
  try {
    const before = f.store.listWorkItems(f.repoId).length
    const response = await post(f, 'en', { ...good, kind: 'related', existing_task_id: f.existedTaskId, title: 'fix the retry in the second call site' })
    assert.ok(response.flash?.notice)
    assert.equal(f.store.listWorkItems(f.repoId).length, before + 1)
    const relations = f.store.listTaskRelations(f.existedJobId)
    assert.equal(relations.length, 1)
    assert.equal(relations[0]?.kind, 'related')
  } finally {
    await f.close()
  }
})

// #1113: the "may not decide" answer belongs to the shared mutating guard, not
// to a branch written inside this route: `ownedRepo` already answers 404 for a
// non-member and 403 for a viewer, so a check of its own could never run. This
// case keeps the refusal on the record instead of on an unreachable line.
test('a viewer member posting a decision is refused by the shared write guard', async () => {
  const f = await fixture('viewer')
  try {
    const viewer = makeUser(f.store, { login: 'decision-route-viewer', status: 'approved' })
    f.store.addRepoMember({ repoId: f.repoId, userId: viewer.id, role: 'viewer', grantedBy: f.user.id })
    assert.equal(f.store.memberRoleFor(f.repoId, viewer.id), 'viewer')
    const before = f.store.listWorkItems(f.repoId).length
    const session = sessionFor(f.built, viewer)
    const response = await f.built.app.inject({
      method: 'POST',
      url: `/repos/${f.repoId}/jobs/${f.verifyId}/decision`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${session.cookie}; fledge_lang=en` },
      payload: formBody({ csrf: session.csrf, ...good, kind: 'new', title: 'a viewer cannot decide' }),
    })
    assert.equal(response.statusCode, 403, 'a viewer is refused before the decision is read')
    assert.equal(f.store.listWorkItems(f.repoId).length, before, 'a refused viewer writes no task')
    assert.equal(
      f.store.listAudit(200).some((entry) => entry.action.startsWith('task.decision_')),
      false,
      'and no decision audit row',
    )
  } finally {
    await f.close()
  }
})

// #1113: a repository connected before any upstream role was recorded keeps
// `repo_role` NULL, and the page already offers the decision there because the
// page reads the actor's role (#1081). The route read the upstream column
// instead, so the form the page drew could only come back as "choose your role
// first". This case is the one that tells the two readers apart: no role on the
// repository, an owner session, a finished verify job.
test('a repository with no recorded upstream role takes the decision the page offers', async () => {
  const f = await fixture('nullrole', null)
  try {
    const html = await page(f, f.verifyId)
    assert.match(html, /action="\/repos\/[^"]+\/jobs\/[^"]+\/decision"/, 'the page offers the decision form')
    assert.doesNotMatch(html, /data-decision-role-required/, 'the page does not tell the owner to pick a role')
    const before = f.store.listWorkItems(f.repoId).length
    const response = await post(f, 'en', { ...good, kind: 'new', title: 'fix the retry in the second call site' })
    assert.equal(response.statusCode, 302)
    assert.equal(response.flash?.error, undefined, 'the route does not refuse a decision the page offered')
    assert.ok(response.flash?.notice)
    assert.match(response.flash?.notice?.text ?? '', /Recorded as the next step/)
    assert.equal(f.store.listWorkItems(f.repoId).length, before + 1)
  } finally {
    await f.close()
  }
})
