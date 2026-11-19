import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { documentRefusal, type DocumentProof } from '../src/lib/memoryDocument.js'
import { formBody, json, makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

// #1070: a merged repository document, proved by its merge commit and its blob
// SHA, makes one memory entry authoritative and its body stops being editable.
//
// The four proofs are separate refusals because they fail for different reasons
// a maintainer has to act on differently: an unmerged PR, a PR based on another
// branch, a merge commit that never reached the default branch, and a document
// that changed after the link was made. Every case below drives the HTTP route,
// because the defect this card exists for is a write that promotes on a partial
// proof or rewrites a body a document already owns.

const PATH = 'docs/decisions/x.md'
const BLUE = 'blob-blue-000000'
const RED = 'blob-red-000000'

interface Proof {
  merged?: boolean
  base?: string
  mergeCommit?: string
  ancestor?: 'ahead' | 'identical' | 'behind' | 'diverged'
  mergeBlob?: string | null
  liveBlob?: string | null
}

interface Harness {
  store: Store
  built: Awaited<ReturnType<typeof buildApp>>
  repo: ReturnType<Store['createRepo']>
  cookie: string
  csrf: string
  calls: string[]
  close: () => Promise<void>
}

async function harness(proof: Proof = {}): Promise<Harness> {
  const calls: string[] = []
  const merged = proof.merged ?? true
  const base = proof.base ?? 'main'
  const mergeCommit = proof.mergeCommit ?? 'merge-sha'
  const ancestor = proof.ancestor ?? 'ahead'
  const mergeBlob = proof.mergeBlob === undefined ? BLUE : proof.mergeBlob
  const liveBlob = proof.liveBlob === undefined ? BLUE : proof.liveBlob
  const server = await startFakeServer((request, response) => {
    const method = request.method ?? 'GET'
    const url = request.url ?? ''
    calls.push(`${method} ${url}`)
    if (method === 'GET' && url === '/repos/owner/repo/pulls/12') {
      json(response, 200, {
        number: 12,
        html_url: 'https://github.com/owner/repo/pull/12',
        title: 'record the decision',
        state: merged ? 'closed' : 'open',
        head: { ref: 'docs/decision', sha: 'head-sha' },
        base: { ref: base },
        mergeable: true,
        mergeable_state: 'clean',
        draft: false,
        merged,
        merge_commit_sha: merged ? mergeCommit : null,
      })
      return
    }
    if (method === 'GET' && url === `/repos/owner/repo/compare/${mergeCommit}...main`) {
      json(response, 200, { status: ancestor, ahead_by: ancestor === 'ahead' ? 3 : 0 })
      return
    }
    const contents = /^\/repos\/owner\/repo\/contents\/(.+)\?ref=(.+)$/.exec(url)
    if (method === 'GET' && contents !== null) {
      const ref = decodeURIComponent(contents[2] ?? '')
      const sha = ref === mergeCommit ? mergeBlob : ref === 'main' ? liveBlob : null
      if (sha === null) {
        json(response, 404, { message: 'Not Found' })
        return
      }
      json(response, 200, { type: 'file', sha, size: 12, encoding: 'base64', content: Buffer.from('the decision').toString('base64') })
      return
    }
    json(response, 404, { message: 'Not Found' })
  })

  const baseConfig = testConfig()
  const config = testConfig({ github: { ...baseConfig.github, apiBase: server.url } })
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), startScheduler: false })
  const user = makeUser(store, { login: `document-${Math.random().toString(36).slice(2, 8)}`, status: 'approved' })
  const repo = store.createRepo({
    id: `repo_${Math.random().toString(36).slice(2, 8)}`,
    userId: user.id,
    owner: 'owner',
    name: 'repo',
    defaultBranch: 'main',
    upstreamHtmlUrl: 'https://github.com/owner/repo',
    tokenEnc: encryptSecret('gh-token', config.tokenEncryptionKey),
    permission: 'admin',
    repoRole: 'maintainer',
    goal: '',
    autoIterate: false,
    intervalMinutes: 1440,
  })
  const session = sessionFor(built, user)
  return {
    store,
    built,
    repo,
    cookie: session.cookie,
    csrf: session.csrf,
    calls,
    close: async () => {
      store.close()
      await server.close()
    },
  }
}

function write(h: Harness, values: Record<string, string>): Promise<{ statusCode: number; headers: Record<string, unknown> }> {
  return h.built.app.inject({
    method: 'POST',
    url: `/repos/${h.repo.id}/memory`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `${h.cookie}; fledge_lang=en` },
    payload: formBody({ csrf: h.csrf, ...values }),
  })
}

function entry(values: Record<string, string> = {}): Record<string, string> {
  return {
    key: 'release-notes-format',
    kind: 'decision',
    status: 'active',
    verification: 'human_asserted',
    audience: 'project',
    scope: 'docs',
    body: 'Release notes are grouped by area, newest first.',
    reason: 'linked to its decision record',
    expected_revision: '0',
    ...values,
  }
}

function redirectLocation(result: { headers: Record<string, unknown> }): string {
  return String(result.headers.location ?? '')
}

test('a merged document on the default branch promotes the entry and the row names the path and the PR', async () => {
  const h = await harness()
  try {
    const result = await write(h, entry({ document_path: PATH, document_pr: '12' }))
    assert.equal(result.statusCode, 302)
    const location = redirectLocation(result)
    assert.match(location, /saved=1/)

    const row = h.store.getMemory(h.repo.id, 'release-notes-format')
    assert.ok(row !== undefined)
    assert.equal(row.verification, 'document')
    assert.equal(row.document_path, PATH)
    assert.equal(row.document_pr, 12)
    assert.equal(row.revision, 1)

    const page = await h.built.app.inject({
      method: 'GET',
      url: `/repos/${h.repo.id}/memory?key=release-notes-format`,
      headers: { cookie: `${h.cookie}; fledge_lang=en` },
    })
    assert.equal(page.statusCode, 200)
    assert.match(page.body, new RegExp(`data-memory-document-path="${PATH}"`))
    assert.match(page.body, /data-memory-document-pr="12"/)
    assert.match(page.body, new RegExp(`href="https://github.com/owner/repo/blob/main/${PATH}"`))
    assert.match(page.body, /href="https:\/\/github\.com\/owner\/repo\/pull\/12"/)
  } finally {
    await h.close()
  }
})

test('an unmerged PR is refused and the entry is not promoted', async () => {
  const h = await harness({ merged: false })
  try {
    const result = await write(h, entry({ document_path: PATH, document_pr: '12' }))
    assert.match(redirectLocation(result), /refused=document_not_merged/)
    // A refused link writes nothing at all: no entry appears, so there is no
    // half-promoted row to clean up later.
    assert.equal(h.store.getMemory(h.repo.id, 'release-notes-format'), undefined)
  } finally {
    await h.close()
  }
})

test('a PR based on another branch is refused', async () => {
  const h = await harness({ base: 'release/next' })
  try {
    const result = await write(h, entry({ document_path: PATH, document_pr: '12' }))
    assert.match(redirectLocation(result), /refused=document_base_not_default/)
    assert.equal(h.store.getMemory(h.repo.id, 'release-notes-format')?.document_path ?? null, null)
  } finally {
    await h.close()
  }
})

test('a merge commit that never reached the default branch is refused', async () => {
  const h = await harness({ ancestor: 'diverged' })
  try {
    const result = await write(h, entry({ document_path: PATH, document_pr: '12' }))
    assert.match(redirectLocation(result), /refused=document_not_on_default/)
    assert.equal(h.store.getMemory(h.repo.id, 'release-notes-format')?.document_path ?? null, null)
  } finally {
    await h.close()
  }
})

test('a document that changed after the merge is refused with its own reason', async () => {
  const h = await harness({ liveBlob: RED })
  try {
    const result = await write(h, entry({ document_path: PATH, document_pr: '12' }))
    assert.match(redirectLocation(result), /refused=document_blob_moved/)
    assert.equal(h.store.getMemory(h.repo.id, 'release-notes-format')?.document_path ?? null, null)
  } finally {
    await h.close()
  }
})

test('a path that is missing at the merge commit is refused instead of promoted', async () => {
  const h = await harness({ mergeBlob: null })
  try {
    const result = await write(h, entry({ document_path: PATH, document_pr: '12' }))
    assert.match(redirectLocation(result), /refused=document_blob_missing/)
    assert.equal(h.store.getMemory(h.repo.id, 'release-notes-format')?.document_path ?? null, null)
  } finally {
    await h.close()
  }
})

test('a promoted entry refuses a body rewrite and names the document that owns it', async () => {
  const h = await harness()
  try {
    await write(h, entry({ document_path: PATH, document_pr: '12' }))
    const result = await write(h, entry({ body: 'A different body.', expected_revision: '1' }))
    assert.match(redirectLocation(result), /refused=memory_document_locked/)
    const row = h.store.getMemory(h.repo.id, 'release-notes-format')
    assert.equal(row?.body, 'Release notes are grouped by area, newest first.')
    assert.equal(row?.revision, 1)
  } finally {
    await h.close()
  }
})

test('the verification select cannot be set to document by typing it', async () => {
  const h = await harness()
  try {
    const result = await write(h, entry({ verification: 'document' }))
    assert.match(redirectLocation(result), /refused=verification_invalid/)
    assert.equal(h.store.getMemory(h.repo.id, 'release-notes-format')?.verification ?? null, null)
  } finally {
    await h.close()
  }
})

test('the planner names each proof it is missing, in order, and accepts a full one', () => {
  const ok: DocumentProof = {
    path: PATH,
    pr: 12,
    merged: true,
    base: 'main',
    defaultBranch: 'main',
    mergeCommitSha: 'merge-sha',
    ancestor: true,
    mergeBlobSha: BLUE,
    liveBlobSha: BLUE,
  }
  assert.equal(documentRefusal(ok), null)
  assert.equal(documentRefusal({ ...ok, merged: false }), 'document_not_merged')
  assert.equal(documentRefusal({ ...ok, base: 'release/next' }), 'document_base_not_default')
  assert.equal(documentRefusal({ ...ok, ancestor: false }), 'document_not_on_default')
  assert.equal(documentRefusal({ ...ok, mergeBlobSha: null }), 'document_blob_missing')
  assert.equal(documentRefusal({ ...ok, liveBlobSha: null }), 'document_blob_missing')
  assert.equal(documentRefusal({ ...ok, liveBlobSha: RED }), 'document_blob_moved')
  // A PR that merged onto the default branch but reports no merge commit cannot
  // be proved at all, so it is refused as "not on the default branch".
  assert.equal(documentRefusal({ ...ok, mergeCommitSha: '' }), 'document_not_on_default')
})
