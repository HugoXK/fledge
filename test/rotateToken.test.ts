import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json, startFakeServer } from './helpers.js'

const execFileAsync = promisify(execFile)

test('rotate-github-token validates, backs up and updates without printing the token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-rotate-'))
  const secretsPath = join(dir, 'secrets.json')
  writeFileSync(secretsPath, JSON.stringify({ version: 1, secrets: [{ name: 'GITHUB_TOKEN', value: 'old-token', purpose: 'dev' }] }))
  const github = await startFakeServer((request, response) => {
    if (request.url === '/user') {
      json(response, 200, { login: 'HugoXK' })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  try {
    const { stdout: output } = await execFileAsync(process.execPath, [new URL('../scripts/rotate-github-token.mjs', import.meta.url).pathname], {
      env: { ...process.env, NEW_GITHUB_TOKEN: 'new-secret-token', SECRETS_PATH: secretsPath, GITHUB_API_URL: github.url },
      encoding: 'utf8',
    })
    assert.match(output, /HugoXK/)
    assert.doesNotMatch(output, /new-secret-token/)
    const parsed = JSON.parse(readFileSync(secretsPath, 'utf8')) as { secrets: Array<{ value: string }> }
    assert.equal(parsed.secrets[0]?.value, 'new-secret-token')
    assert.equal(readdirSync(dir).some((name) => name.startsWith('secrets.json.bak-')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await github.close()
  }
})
