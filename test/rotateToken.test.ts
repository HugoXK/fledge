import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json, startFakeServer } from './helpers.js'

const SCRIPT = new URL('../scripts/rotate-github-token.mjs', import.meta.url).pathname

interface Run {
  code: number
  stdout: string
  stderr: string
}

// `spawn` rather than `execFile`: one accepted input is stdin, and the point of
// the interface is that the token never reaches argv or the child's environment.
function runRotate(args: string[], env: Record<string, string>, stdin = ''): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

function secretsFile(): { dir: string; path: string; value: () => string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fledge-rotate-'))
  const path = join(dir, 'secrets.json')
  writeFileSync(path, JSON.stringify({ version: 1, secrets: [{ name: 'GITHUB_TOKEN', value: 'old-token', purpose: 'dev' }] }))
  return {
    dir,
    path,
    value: () => (JSON.parse(readFileSync(path, 'utf8')) as { secrets: Array<{ value: string }> }).secrets[0]?.value ?? '',
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function tokenFile(dir: string, name: string, mode: number, token = 'new-secret-token'): string {
  const path = join(dir, name)
  writeFileSync(path, `${token}\n`, { mode })
  chmodSync(path, mode)
  return path
}

async function githubUser(login = 'HugoXK'): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await startFakeServer((request, response) => {
    if (request.url === '/user') {
      json(response, 200, { login })
      return
    }
    json(response, 404, { message: 'not found' })
  })
  return { url: server.url, close: () => server.close() }
}

// #71 P1: the token must not reach the command line or the environment. The
// command line is kept in shell history and shown by `ps`, and an environment
// variable is inherited by every child process, so both are refused rather than
// merely discouraged.
test('rotate-github-token refuses a token from the environment and names the file flag', async () => {
  const secrets = secretsFile()
  const github = await githubUser()
  try {
    const result = await runRotate([], { NEW_GITHUB_TOKEN: 'new-secret-token', SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /--token-file/, 'the refusal teaches the safe form')
    assert.equal(secrets.value(), 'old-token', 'nothing is written when the token arrives the wrong way')
    assert.doesNotMatch(result.stdout + result.stderr, /new-secret-token/)
  } finally {
    secrets.cleanup()
    await github.close()
  }
})

// The file is opened once and checked and read through that one descriptor, so
// there is no path lookup between the permission check and the read. A path that
// is not a regular file is refused before anything is read from it.
test('rotate-github-token refuses a --token-file that is not a regular file', async () => {
  const secrets = secretsFile()
  const directory = join(secrets.dir, 'token-dir')
  mkdirSync(directory)
  try {
    const result = await runRotate(['--token-file', directory], { SECRETS_PATH: secrets.path, GITHUB_API_URL: 'http://127.0.0.1:1' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /not a regular file/)
    assert.equal(secrets.value(), 'old-token')
  } finally {
    secrets.cleanup()
  }
})

test('rotate-github-token accepts a 0600 token file and never prints the token', async () => {
  const secrets = secretsFile()
  const github = await githubUser()
  try {
    const file = tokenFile(secrets.dir, 'token', 0o600)
    const result = await runRotate(['--token-file', file], { SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /HugoXK/)
    assert.doesNotMatch(result.stdout + result.stderr, /new-secret-token/)
    assert.equal(secrets.value(), 'new-secret-token')
    assert.equal(readdirSync(secrets.dir).some((name) => name.startsWith('secrets.json.bak-')), true)
  } finally {
    secrets.cleanup()
    await github.close()
  }
})

test('rotate-github-token refuses a token file another account can read', async () => {
  const secrets = secretsFile()
  const github = await githubUser()
  try {
    const file = tokenFile(secrets.dir, 'token', 0o644)
    const result = await runRotate(['--token-file', file], { SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /0600|permission/i)
    assert.equal(secrets.value(), 'old-token')
    assert.doesNotMatch(result.stdout + result.stderr, /new-secret-token/)
  } finally {
    secrets.cleanup()
    await github.close()
  }
})

test('rotate-github-token reads the token from stdin when the flag names a dash', async () => {
  const secrets = secretsFile()
  const github = await githubUser()
  try {
    const result = await runRotate(['--token-file', '-'], { SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url }, 'new-secret-token\n')
    assert.equal(result.code, 0, result.stderr)
    assert.equal(secrets.value(), 'new-secret-token')
    assert.doesNotMatch(result.stdout + result.stderr, /new-secret-token/)
  } finally {
    secrets.cleanup()
    await github.close()
  }
})

// #71 P1: a JSON parse error quotes the input around the offset, and this file
// holds the still-valid old token at that moment — so the message carries a
// position and nothing else.
test('rotate-github-token reports a bad secrets file by position and never echoes a token fragment', async () => {
  const secrets = secretsFile()
  const github = await githubUser()
  // Built at run time so the repository never carries a token-shaped literal:
  // `secret:scan` flags one, and that guard is worth keeping honest.
  const token = `ghp_${'A'.repeat(36)}`
  writeFileSync(secrets.path, `{"secrets": [{"name": "GITHUB_TOKEN", "value": "${token}"`)
  try {
    const file = tokenFile(secrets.dir, 'token', 0o600)
    const result = await runRotate(['--token-file', file], { SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /position/i, 'the reader is told where the file stopped being JSON')
    assert.equal(result.stderr.includes(token), false, 'no fragment of the token reaches stderr')
    assert.doesNotMatch(result.stderr, /ghp_/, 'not even the token\'s prefix is echoed')
  } finally {
    secrets.cleanup()
    await github.close()
  }
})
