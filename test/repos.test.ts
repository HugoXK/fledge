import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareRepo } from '../src/repos/github.js'
import { json, readBody, startFakeServer } from './helpers.js'

interface FakeState {
  forkExists: boolean
  forkCreated: boolean
  upstreamMaintain: boolean
}

function repoPayload(owner: string, name: string, options: { fork?: boolean; parent?: string; maintain?: boolean; admin?: boolean } = {}) {
  return {
    name,
    full_name: `${owner}/${name}`,
    default_branch: 'main',
    private: false,
    html_url: `https://github.com/${owner}/${name}`,
    fork: options.fork === true,
    parent: options.parent === undefined ? null : { full_name: options.parent },
    owner: { login: owner },
    permissions: { admin: options.admin === true, maintain: options.maintain === true, push: options.admin === true || options.maintain === true, pull: true },
  }
}

function fakeGithub(state: FakeState) {
  return startFakeServer(async (request, response) => {
    const url = request.url ?? ''
    if (request.method === 'GET' && url === '/user') {
      json(response, 200, { login: 'HugoXK', id: 1 })
      return
    }
    if (request.method === 'GET' && url === '/repos/openJiuwen-ai/DigitalMate') {
      json(response, 200, repoPayload('openJiuwen-ai', 'DigitalMate', { maintain: state.upstreamMaintain }))
      return
    }
    if (request.method === 'GET' && url === '/repos/openJiuwen-ai/Conflict') {
      json(response, 200, repoPayload('openJiuwen-ai', 'Conflict'))
      return
    }
    if (request.method === 'GET' && url === '/repos/HugoXK/DigitalMate') {
      if (!state.forkExists) {
        json(response, 404, { message: 'Not Found' })
        return
      }
      json(response, 200, repoPayload('HugoXK', 'DigitalMate', { fork: true, parent: 'openJiuwen-ai/DigitalMate', admin: true }))
      return
    }
    if (request.method === 'GET' && url === '/repos/HugoXK/Conflict') {
      json(response, 200, repoPayload('HugoXK', 'Conflict', { admin: true }))
      return
    }
    if (request.method === 'GET' && url === '/repos/HugoXK/OwnRepo') {
      json(response, 200, repoPayload('HugoXK', 'OwnRepo', { admin: true }))
      return
    }
    if (request.method === 'POST' && url === '/repos/openJiuwen-ai/DigitalMate/forks') {
      await readBody(request)
      state.forkExists = true
      state.forkCreated = true
      json(response, 202, repoPayload('HugoXK', 'DigitalMate', { fork: true, parent: 'openJiuwen-ai/DigitalMate', admin: true }))
      return
    }
    json(response, 404, { message: 'Not Found' })
  })
}

test('prepareRepo uses the upstream directly when the token user owns it', async () => {
  const state: FakeState = { forkExists: false, forkCreated: false, upstreamMaintain: false }
  const github = await fakeGithub(state)
  try {
    const prepared = await prepareRepo('token', 'HugoXK', 'OwnRepo', 'HugoXK', github.url)
    assert.equal(prepared.isFork, false)
    assert.equal(prepared.forkCreated, false)
    assert.equal(prepared.fork.fullName, 'HugoXK/OwnRepo')
    assert.equal(prepared.permission, 'admin')
    assert.equal(prepared.canReview, true)
  } finally {
    await github.close()
  }
})

test('prepareRepo uses an existing fork and enables review only with upstream permission', async () => {
  const state: FakeState = { forkExists: true, forkCreated: false, upstreamMaintain: false }
  const github = await fakeGithub(state)
  try {
    const prepared = await prepareRepo('token', 'openJiuwen-ai', 'DigitalMate', 'HugoXK', github.url)
    assert.equal(prepared.isFork, true)
    assert.equal(prepared.forkCreated, false)
    assert.equal(prepared.fork.fullName, 'HugoXK/DigitalMate')
    assert.equal(prepared.permission, 'read')
    assert.equal(prepared.canReview, false)
    assert.equal(prepared.canCreateIssue, true)
  } finally {
    await github.close()
  }
})

test('prepareRepo creates a missing fork and then uses it', async () => {
  const state: FakeState = { forkExists: false, forkCreated: false, upstreamMaintain: true }
  const github = await fakeGithub(state)
  try {
    const prepared = await prepareRepo('token', 'openJiuwen-ai', 'DigitalMate', 'HugoXK', github.url)
    assert.equal(prepared.isFork, true)
    assert.equal(prepared.forkCreated, true)
    assert.equal(state.forkCreated, true)
    assert.equal(prepared.fork.fullName, 'HugoXK/DigitalMate')
    assert.equal(prepared.canReview, true)
  } finally {
    await github.close()
  }
})

test('prepareRepo rejects a same-name repository that is not a fork of the upstream', async () => {
  const state: FakeState = { forkExists: false, forkCreated: false, upstreamMaintain: false }
  const github = await fakeGithub(state)
  try {
    await assert.rejects(
      prepareRepo('token', 'openJiuwen-ai', 'Conflict', 'HugoXK', github.url),
      /不是 .* 的 fork/,
    )
  } finally {
    await github.close()
  }
})

test('prepareRepo rejects a token that belongs to another GitHub user', async () => {
  const state: FakeState = { forkExists: false, forkCreated: false, upstreamMaintain: false }
  const github = await fakeGithub(state)
  try {
    await assert.rejects(
      prepareRepo('token', 'HugoXK', 'OwnRepo', 'SomeoneElse', github.url),
      /属于 @HugoXK/,
    )
  } finally {
    await github.close()
  }
})
