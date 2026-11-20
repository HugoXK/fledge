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

interface UserReply {
  status: number
  login?: string
}

// #71 P2: what makes a rotation provable is the pair of answers inside one run,
// so the fake has to answer per token. By default the value that sits in the
// secrets file is dead and the new one works; a case that wants another pair
// says so.
// Assembled so the tracked-tree scan has no token-shaped literal to find.
const NEW_TOKEN = 'new-secret' + '-token'

function backups(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('secrets.json.bak-'))
}

async function githubUser(
  answer: (token: string, call: number) => UserReply = (token) => (token === NEW_TOKEN ? { status: 200, login: 'HugoXK' } : { status: 401 }),
): Promise<{ url: string; close: () => Promise<void> }> {
  const calls = new Map<string, number>()
  const server = await startFakeServer((request, response) => {
    if (request.url !== '/user') {
      json(response, 404, { message: 'not found' })
      return
    }
    const token = String(request.headers.authorization ?? '').replace(/^Bearer /i, '')
    const call = (calls.get(token) ?? 0) + 1
    calls.set(token, call)
    const reply = answer(token, call)
    if (reply.status === 200) json(response, 200, { login: reply.login ?? 'HugoXK' })
    else json(response, reply.status, { message: 'bad credentials' })
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
    const result = await runRotate([], { NEW_GITHUB_TOKEN: 'new-secret' + '-token', SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /--token-file/, 'the refusal teaches the safe form')
    assert.equal(secrets.value(), 'old-token', 'nothing is written when the token arrives the wrong way')
    assert.doesNotMatch(result.stdout + result.stderr, /new-secret-token/)
  } finally {
    secrets.cleanup()
    await github.close()
  }
})

// #840: this script's whole job is handling a token, and GITHUB_API_URL is
// inherited from the environment, so a hostile or stale value would carry the
// fresh PAT to another origin. The check must run before the token file is
// opened; the absent path makes that order observable — a refused origin must
// never turn into a read error.
test('rotate-github-token refuses a non-GitHub API origin before it opens the token file', async () => {
  const secrets = secretsFile()
  try {
    const absent = join(secrets.dir, 'absent-token')
    const result = await runRotate(['--token-file', absent], { SECRETS_PATH: secrets.path, GITHUB_API_URL: 'http://evil.example' })
    assert.equal(result.code, 1)
    assert.equal(
      result.stderr,
      'rotate-github-token: GITHUB_API_URL http://evil.example is refused; only https://api.github.com or a loopback host is accepted\n',
      'the refusal names the refused origin and the one origin it accepts',
    )
    assert.doesNotMatch(result.stderr, /cannot read|ENOENT/, 'the token file was never opened')
    assert.equal(secrets.value(), 'old-token')
  } finally {
    secrets.cleanup()
  }
})

// The documented base carries a trailing slash in the docs; refusing it would
// break the happy path this file exists for, so the accept rule is proven by the
// run moving on to the file rather than by a fetch to the real GitHub.
test('rotate-github-token accepts https://api.github.com/ and moves on to the token file', async () => {
  const secrets = secretsFile()
  try {
    const absent = join(secrets.dir, 'absent-token')
    const result = await runRotate(['--token-file', absent], { SECRETS_PATH: secrets.path, GITHUB_API_URL: 'https://api.github.com/' })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /cannot read|ENOENT/, 'the documented base is accepted; the run reaches the file')
    assert.doesNotMatch(result.stderr, /refused/i)
  } finally {
    secrets.cleanup()
  }
})

test('rotate-github-token refuses an unparseable GITHUB_API_URL with the same message', async () => {
  const secrets = secretsFile()
  try {
    const absent = join(secrets.dir, 'absent-token')
    const result = await runRotate(['--token-file', absent], { SECRETS_PATH: secrets.path, GITHUB_API_URL: 'not a url' })
    assert.equal(result.code, 1)
    assert.equal(
      result.stderr,
      'rotate-github-token: GITHUB_API_URL not a url is refused; only https://api.github.com or a loopback host is accepted\n',
      'the refusal quotes the value it could not parse',
    )
    assert.doesNotMatch(result.stderr, /cannot read|ENOENT/, 'the token file was never opened')
  } finally {
    secrets.cleanup()
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
    // #71 P2: this run proved the old value dead (401) while the new value
    // answered 200, so the backup it made for itself is the one thing that no
    // longer needs to exist.
    assert.deepEqual(backups(secrets.dir), [], 'a proven-dead rotation deletes this run\'s backup')
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

// #71 P2: the old value answering 200 is the one outcome a rotation must never
// record as done. The new value is already written at that point, so the backup
// is the only copy of the old value an operator can put back.
test('rotate-github-token exits 2 and keeps its backup while the old token still answers 200', async () => {
  const secrets = secretsFile()
  const github = await githubUser(() => ({ status: 200 }))
  try {
    const file = tokenFile(secrets.dir, 'token', 0o600)
    const result = await runRotate(['--token-file', file], { SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 2, 'a live old token is its own exit code, not a generic failure')
    assert.match(result.stdout + result.stderr, /old token still live/)
    assert.equal(backups(secrets.dir).length, 1, 'the backup holds the old value and must survive')
    assert.equal(secrets.value(), NEW_TOKEN, 'the new value was written before the probe ran')
    assert.doesNotMatch(result.stdout + result.stderr, /new-secret-token|old-token/, 'neither value reaches the output')
  } finally {
    secrets.cleanup()
    await github.close()
  }
})

// The only pair that counts: old value 401 and new value 200 in this same run.
test('rotate-github-token deletes its backup only when the old value is 401 and the new value is 200', async () => {
  const secrets = secretsFile()
  const github = await githubUser()
  try {
    const file = tokenFile(secrets.dir, 'token', 0o600)
    const result = await runRotate(['--token-file', file], { SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /HugoXK/)
    assert.deepEqual(backups(secrets.dir), [], 'the proven-dead pair is the only one that deletes the backup')
    assert.equal(secrets.value(), NEW_TOKEN)
  } finally {
    secrets.cleanup()
    await github.close()
  }
})

// A 401 for the old value on its own is not evidence of anything: a proxy, a
// rate limit or a typo produces one too. When the new value does not answer 200
// in this run the result says INCONCLUSIVE and the backup stays.
test('rotate-github-token calls an inconclusive pair inconclusive, exits 1 and keeps the backup', async () => {
  const secrets = secretsFile()
  const github = await githubUser((token, call) => (token === NEW_TOKEN ? (call === 1 ? { status: 200, login: 'HugoXK' } : { status: 503 }) : { status: 401 }))
  try {
    const file = tokenFile(secrets.dir, 'token', 0o600)
    const result = await runRotate(['--token-file', file], { SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 1, 'an unproven pair is a failure, not a rotation')
    assert.match(result.stdout + result.stderr, /INCONCLUSIVE/)
    assert.equal(backups(secrets.dir).length, 1, 'the backup stays until a run can prove the old value dead')
  } finally {
    secrets.cleanup()
    await github.close()
  }
})

// #71 P2: a valid token for some other account is not a rotation of this one.
test('rotate-github-token refuses a token that belongs to another account and writes nothing', async () => {
  const secrets = secretsFile()
  const github = await githubUser(() => ({ status: 200, login: 'someone-else' }))
  const before = readFileSync(secrets.path)
  try {
    const file = tokenFile(secrets.dir, 'token', 0o600)
    const result = await runRotate(['--token-file', file], { SECRETS_PATH: secrets.path, GITHUB_API_URL: github.url })
    assert.equal(result.code, 1)
    assert.match(result.stderr, /@someone-else/)
    assert.match(result.stderr, /HugoXK/, 'the refusal names the account the run expected')
    assert.deepEqual(readFileSync(secrets.path), before, 'the secrets file is byte-identical after a refusal')
    assert.deepEqual(backups(secrets.dir), [], 'a refused run does not leave a backup behind')
  } finally {
    secrets.cleanup()
    await github.close()
  }
})
