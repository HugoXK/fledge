#!/usr/bin/env node
// Rotate the GitHub PAT used by the Fledge development routine.
//
//   node scripts/rotate-github-token.mjs --token-file /path/to/new-token
//   cat /path/to/new-token | node scripts/rotate-github-token.mjs --token-file -
//
// #71: the token never arrives on the command line or in the environment. The
// command line is kept in shell history and shown by `ps`, and an environment
// variable is inherited by every child process, so both are refused rather than
// merely discouraged. `--token-file` must name a regular file only its owner can
// read; `-` reads stdin.
//
// The new token is created in GitHub settings by the owner; this script only
// validates it, backs up the secrets file, updates the GITHUB_TOKEN entry and
// never prints the token. The old token must be revoked in GitHub settings.
//
// #71: the script itself produces the evidence that the old value is dead, and
// it only believes the one pair that counts: inside this run the old value
// answers 401 and the new value answers 200. Exit codes:
//
//   0  rotated and proven: the old value is dead, the new one works, and this
//      run's backup was removed
//   1  nothing proven: bad input, an account that is not EXPECTED_LOGIN, or an
//      INCONCLUSIVE pair; the backup stays
//   2  the old value is still live (200): the new value is written, and the
//      backup stays because it is the only copy of a token that still works
//
// EXPECTED_LOGIN (default HugoXK) names the account the new token must belong to;
// a valid token for another account is refused before anything is written.

import { closeSync, copyFileSync, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const USAGE = 'usage: rotate-github-token.mjs --token-file <path|->'
const OWNER_ONLY = 0o077
const EXIT_OLD_TOKEN_LIVE = 2

function fail(message, code = 1) {
  console.error(`rotate-github-token: ${message}`)
  process.exit(code)
}

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const tokenFile = argValue('--token-file')
if (tokenFile === undefined || tokenFile === '') fail(`--token-file is required. ${USAGE}`)

// A token in the environment is as exposed as one on the command line: `env`, a
// crash dump or any child process can read it, and the documented form used to
// put it in shell history. Refusing it by name teaches the safe form instead of
// letting the run appear to work.
if ((process.env.NEW_GITHUB_TOKEN ?? '') !== '') fail('the token must not come from NEW_GITHUB_TOKEN; pass --token-file <path|-> instead')

// #840: the same redirect the check above refuses for the token itself has a
// second form — the origin it is sent to. GITHUB_API_URL is inherited from the
// environment, so a hostile or stale value would carry the freshly read PAT to
// another host, and this is the one script whose whole job is handling a token.
// Only GitHub itself and a loopback fake server are accepted; a loopback host is
// the exception test/rotateToken.test.ts needs to exercise the rest of the run.
// There is no fallback to the default base: a value that does not parse is
// refused the same way, because a silent rewrite would hide the hostile input.
const API_ORIGIN = 'https://api.github.com'

function apiBase() {
  const raw = process.env.GITHUB_API_URL ?? API_ORIGIN
  let url
  try {
    url = new URL(raw)
  } catch {
    fail(`GITHUB_API_URL ${raw} is refused; only ${API_ORIGIN} or a loopback host is accepted`)
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (!(url.protocol === 'https:' && url.hostname === 'api.github.com') && !loopback) {
    fail(`GITHUB_API_URL ${raw} is refused; only ${API_ORIGIN} or a loopback host is accepted`)
  }
  return raw.replace(/\/$/, '')
}

function readToken(path) {
  if (path === '-') {
    // 0 is stdin: the caller pipes the token, so it is in neither the history
    // nor the process table.
    return readFileSync(0, 'utf8')
  }
  // The descriptor is opened once and everything after it reads that same
  // descriptor. Checking the path and then reading the path would leave a
  // window in which the file is swapped for another one between the two.
  let fd
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'
    if (code === 'EISDIR') fail(`${path} is not a regular file`)
    fail(`cannot read ${path}: ${code}`)
  }
  const stat = fstatSync(fd)
  if (!stat.isFile()) fail(`${path} is not a regular file`)
  const mode = stat.mode & 0o777
  if ((mode & OWNER_ONLY) !== 0) fail(`${path} is mode ${mode.toString(8).padStart(3, '0')}; the token file must be 0600 so only its owner can read it`)
  if ((mode & 0o400) === 0) fail(`${path} is not readable by its owner; the token file must be 0600`)
  try {
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

// The destination is settled before the secret is opened, so a refused origin
// can never see it: this line has to stay above the readToken call below.
const api = apiBase()

const token = readToken(tokenFile).trim()
if (token === '') fail(`no token in ${tokenFile === '-' ? 'stdin' : tokenFile}`)

const path = process.env.SECRETS_PATH ?? join(homedir(), '.dsh/bot/secrets.json')

// `probe` answers with the HTTP status the token got, and 0 when the request
// never reached GitHub. A network failure is not a 401: only an answer counts as
// evidence that a value is dead.
async function probe(value) {
  try {
    const answer = await fetch(`${api}/user`, {
      headers: { authorization: `Bearer ${value}`, accept: 'application/vnd.github+json', 'user-agent': 'fledge-rotate-token' },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await answer.text()
    let login
    if (answer.ok) {
      try {
        login = JSON.parse(text).login
      } catch {
        login = undefined
      }
    }
    return { status: answer.status, login: typeof login === 'string' ? login : undefined }
  } catch {
    return { status: 0, login: undefined }
  }
}

const validation = await probe(token)
if (validation.status !== 200) fail(`token validation failed with HTTP ${validation.status === 0 ? 'no answer' : validation.status}`)
const user = { login: validation.login }

const expectedLogin = process.env.EXPECTED_LOGIN ?? 'HugoXK'
if (user.login !== expectedLogin) {
  // Fail closed: a valid token for another account would rotate this routine
  // onto an identity that is not the one the host is documented to use.
  fail(`the new token belongs to @${user.login}, not @${expectedLogin}; nothing was written`)
}

// #71: a JSON.parse error quotes the input around the offset, and this file
// holds the token at this moment — so only the position is reported, never the
// message Node built out of the text.
const text = readFileSync(path, 'utf8')
let parsed
try {
  parsed = JSON.parse(text)
} catch (error) {
  const message = error instanceof Error ? error.message : ''
  const position = /position (\d+)/.exec(message)
  fail(`${path} is not valid JSON${position === null ? '' : ` (at position ${position[1] ?? ''})`}; nothing was written`)
}

const secrets = Array.isArray(parsed.secrets) ? parsed.secrets : []
const entry = secrets.find((item) => item?.name === 'GITHUB_TOKEN')
if (entry === undefined) fail('GITHUB_TOKEN entry not found')

const previous = String(entry.value ?? '')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${path}.bak-${stamp}`
copyFileSync(path, backup)
entry.value = token
entry.updatedAt = new Date().toISOString()
writeFileSync(`${path}.tmp`, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
renameSync(`${path}.tmp`, path)

// #71: the backup is deleted only on the one pair that proves the rotation: the
// old value is dead (401) and the new value works (200), both answered inside
// this run. Anything else keeps it, because the file now holds the new value.
const oldStatus = (await probe(previous)).status
const newStatus = (await probe(token)).status
if (oldStatus === 200) {
  console.error(`rotate-github-token: old token still live (it answers 200 as @${user.login}); the new value is written and ${backup} keeps the old one`)
  process.exit(EXIT_OLD_TOKEN_LIVE)
}
if (oldStatus === 401 && newStatus === 200) {
  unlinkSync(backup)
  console.log(`rotate-github-token: updated GITHUB_TOKEN for @${user.login}; the old token is dead and ${backup} was removed`)
} else {
  fail(`INCONCLUSIVE: the old value answered ${oldStatus === 0 ? 'no answer' : oldStatus} and the new value answered ${newStatus === 0 ? 'no answer' : newStatus}; ${backup} was kept and the rotation must be re-run`)
}
