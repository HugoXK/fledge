import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/db.js'
import { parseAdversarialRecord } from '../src/lib/adversarialReview.js'
import { jobPage } from '../src/views/pages.js'
import { makeUser, testConfig } from './helpers.js'

// #794: a packet hash with no revision is a verdict a maintainer cannot place.
// The adversarial pass already records `tipSha` and `baseSha` in the
// `job.adversarial` event; the reader dropped both, so the page could print a
// hash that belongs to no revision. These cases pin the reader and the page
// against the record the pass actually writes.

const TIP = '40eb9d7bac304cb95b6249eddb2d67f90277f208'
const BASE = 'c3d16bbc51bc04e0fc405f1f4e6c0e7bc1868439'

test('a recorded packet identity exposes the revision it covers', () => {
  const record = parseAdversarialRecord(JSON.stringify({
    status: 'risk',
    tipSha: TIP,
    baseSha: BASE,
    model: 'fake/model',
    promptHash: 'abcdef0123456789',
    target: 'src/x.ts:9',
    verdict: { kind: 'risk', file: 'src/x.ts', line: 9, failureMode: 'stale read', repro: 'open twice', checks: ['read the diff'] },
  }))
  assert.equal(record?.tipSha, TIP, 'the tip the verdict covers is read back, not dropped')
  assert.equal(record?.baseSha, BASE, 'the base it was read against is read back')

  // A record written before the fields were read back is not an error; it says
  // "unknown" rather than borrowing a revision from somewhere else.
  const older = parseAdversarialRecord(JSON.stringify({
    status: 'none',
    model: 'fake/model',
    promptHash: 'abcdef0123456789',
    verdict: { kind: 'none', checks: [] },
  }))
  assert.equal(older?.tipSha, null)
  assert.equal(older?.baseSha, null)
})

function pageFor(events: Array<{ meta: string }>): string {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'packet-record-page', status: 'approved' })
    const repo = store.createRepo({
      id: 'repo_packet_record', userId: user.id, owner: 'o', name: 'pr', defaultBranch: 'main', tokenEnc: 'x',
      permission: 'admin', repoRole: 'maintainer', goal: '', autoIterate: false, intervalMinutes: 1440,
    })
    const job = store.createJob({ id: 'job_packet_record', repoId: repo.id, userId: user.id, trigger: 'manual', goal: 'g', callbackHash: 'cb', platformTokenHash: '' })
    return jobPage({
      config: testConfig(),
      locale: 'en',
      viewer: { user: store.userById(user.id)!, csrfToken: 'csrf' },
      repo,
      job,
      events: events.map((event, index) => ({
        id: index + 1,
        at: new Date().toISOString(),
        job_id: job.id,
        repo_id: repo.id,
        user_id: user.id,
        kind: 'job.adversarial',
        role: null,
        step: 'risk',
        meta: event.meta,
      })),
    })
  } finally {
    store.close()
  }
}

test('the job page names the tip beside the packet hash', () => {
  const html = pageFor([{
    meta: JSON.stringify({
      status: 'risk',
      tipSha: TIP,
      baseSha: BASE,
      model: 'fake/model',
      promptHash: 'abcdef0123456789',
      target: 'src/x.ts:9',
      verdict: { kind: 'risk', file: 'src/x.ts', line: 9, failureMode: 'stale read', repro: 'open twice', checks: [] },
    }),
  }])
  assert.match(html, new RegExp(TIP), 'the revision the hash belongs to is on the page')
  assert.match(html, /data-adversarial-tip/)
})

test('a record without a revision says so instead of printing a bare hash', () => {
  const html = pageFor([{
    meta: JSON.stringify({
      status: 'none',
      model: 'fake/model',
      promptHash: 'abcdef0123456789',
      verdict: { kind: 'none', checks: [] },
    }),
  }])
  assert.match(html, /abcdef012345/, 'the hash it did record is still shown')
  assert.match(html, /revision not recorded/i, 'a hash with no revision is labelled, not left to imply one')
})
