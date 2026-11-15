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

import { copyFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const USAGE = 'usage: rotate-github-token.mjs --token-file <path|->'
const OWNER_ONLY = 0o077

function fail(message) {
  console.error(`rotate-github-token: ${message}`)
  process.exit(1)
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

function readToken(path) {
  if (path === '-') {
    // 0 is stdin: the caller pipes the token, so it is in neither the history
    // nor the process table.
    return readFileSync(0, 'utf8')
  }
  let mode
  try {
    const stat = statSync(path)
    if (!stat.isFile()) fail(`${path} is not a regular file`)
    mode = stat.mode & 0o777
  } catch (error) {
    fail(`cannot read ${path}: ${error instanceof Error && 'code' in error ? String(error.code) : 'unknown error'}`)
  }
  if ((mode & OWNER_ONLY) !== 0) fail(`${path} is mode ${mode.toString(8).padStart(3, '0')}; the token file must be 0600 so only its owner can read it`)
  if ((mode & 0o400) === 0) fail(`${path} is not readable by its owner; the token file must be 0600`)
  return readFileSync(path, 'utf8')
}

const token = readToken(tokenFile).trim()
if (token === '') fail(`no token in ${tokenFile === '-' ? 'stdin' : tokenFile}`)

const path = process.env.SECRETS_PATH ?? join(homedir(), '.dsh/bot/secrets.json')
const api = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '')

const response = await fetch(`${api}/user`, {
  headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'fledge-rotate-token' },
  signal: AbortSignal.timeout(15_000),
})
if (!response.ok) fail(`token validation failed with HTTP ${response.status}`)
const user = await response.json()

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

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(path, `${path}.bak-${stamp}`)
entry.value = token
entry.updatedAt = new Date().toISOString()
writeFileSync(`${path}.tmp`, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
renameSync(`${path}.tmp`, path)
console.log(`rotate-github-token: updated GITHUB_TOKEN for @${user.login}; revoke the old token in GitHub settings`)
