import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.js'
import { Store } from '../src/db.js'
import { rewriteWorkspaceHtml } from '../src/flybot/workspace.js'
import { MockRunner } from '../src/jobs/mock.js'
import { encryptSecret } from '../src/lib/secrets.js'
import { makeUser, MemoryMailer, sessionFor, startFakeServer, testConfig } from './helpers.js'

test('workspace html is rebranded and keeps a workspace base', () => {
  const store = new Store(':memory:')
  try {
    const user = makeUser(store, { login: 'brand-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_brand', userId: user.id, owner: 'o', name: 'r', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    const html = rewriteWorkspaceHtml('<html><head><title>DeepSeek Harness</title><base href="./"></head><body></body></html>', repo, '/repos/repo_brand/workspace/app/')
    assert.match(html, /<title>Fledge · r<\/title>/)
    assert.match(html, /<base href="\/repos\/repo_brand\/workspace\/app\/">/)
    assert.match(html, /workspace-brand\.js/)
    assert.match(html, /data-fledge-repo="o\/r"/)
    assert.doesNotMatch(html, /DeepSeek Harness/)
  } finally {
    store.close()
  }
})

test('workspace shell and proxied html are owner-only and rebranded', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'fledge-workspace-'))
  writeFileSync(join(dataDir, 'dsh-web.log'), 'dsh web: http://127.0.0.1:3080/?token=testtoken\n')
  let proxyOrigin = ''
  const dsh = await startFakeServer((request, response) => {
    if (request.url === '/') proxyOrigin = String(request.headers.origin ?? '')
    if (request.url?.startsWith('/?token=')) {
      response.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-test=abc; Path=/; HttpOnly' })
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'dsh-auth-test=abc; Path=/' })
    response.end('<html><head><title>DeepSeek Harness</title><base href="./"></head><body>workspace</body></html>')
  })
  const config = testConfig()
  const store = new Store(':memory:')
  const built = await buildApp({ config, store, mailer: new MemoryMailer(), runner: new MockRunner(), startScheduler: false })
  try {
    const user = makeUser(store, { login: 'workspace-user', status: 'approved' })
    const repo = store.createRepo({ id: 'repo_workspace', userId: user.id, owner: 'o', name: 'w', defaultBranch: 'main', tokenEnc: 'x', goal: '', autoIterate: false, intervalMinutes: 1440 })
    store.saveRepoInstance({
      repo_id: repo.id, user_id: user.id, container: 'c', network: 'n', data_dir: dataDir, bridge_script: '/tmp/bridge',
      dsh_port: Number(new URL(dsh.url).port), bridge_port: 2, model_port: 3, model_bind: '127.0.0.1', image: 'image',
      status: 'ready', chief_session: 'chief-1', team_json: null,
      bridge_token_enc: encryptSecret('bridge-token', config.tokenEncryptionKey), bridge_pid: null, log_pid: null,
      last_error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), last_health_at: null,
    })
    await built.app.listen({ port: 0, host: '127.0.0.1' })
    const address = built.app.server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const { cookie } = sessionFor(built, user)
    const shell = await fetch(`http://127.0.0.1:${port}/repos/${repo.id}/workspace`, { headers: { cookie } })
    const shellBody = await shell.text()
    assert.equal(shell.status, 200)
    assert.match(shellBody, /workspace-frame/)
    assert.match(shellBody, /powered by FlyBot/)
    const proxied = await fetch(`http://127.0.0.1:${port}/repos/${repo.id}/workspace/app/`, { headers: { cookie } })
    const proxiedBody = await proxied.text()
    assert.equal(proxied.status, 200)
    assert.match(proxiedBody, /Fledge · w/)
    assert.match(proxiedBody, /workspace-brand\.js/)
    assert.match(proxiedBody, /workspace/)
    assert.doesNotMatch(proxiedBody, /DeepSeek Harness/)
    assert.equal(proxied.headers.get('set-cookie'), null)
    assert.equal(proxyOrigin, `http://127.0.0.1:${new URL(dsh.url).port}`)
    const anonymous = await fetch(`http://127.0.0.1:${port}/repos/${repo.id}/workspace`)
    assert.equal(anonymous.status, 401)
  } finally {
    await built.close()
    await dsh.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

