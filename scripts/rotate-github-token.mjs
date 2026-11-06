#!/usr/bin/env node
// Rotate the GitHub PAT used by the Fledge development routine.
//
//   NEW_GITHUB_TOKEN=... node scripts/rotate-github-token.mjs
//   NEW_GITHUB_TOKEN=... SECRETS_PATH=/path/to/secrets.json node scripts/rotate-github-token.mjs
//
// The new token is created in GitHub settings by the owner; this script only
// validates it, backs up the secrets file, updates the GITHUB_TOKEN entry and
// never prints the token. The old token must be revoked in GitHub settings.

import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const token = process.env.NEW_GITHUB_TOKEN ?? ''
if (token === '') {
  console.error('rotate-github-token: NEW_GITHUB_TOKEN is required')
  process.exit(1)
}

const path = process.env.SECRETS_PATH ?? join(homedir(), '.dsh/bot/secrets.json')
const api = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '')

const response = await fetch(`${api}/user`, {
  headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'fledge-rotate-token' },
  signal: AbortSignal.timeout(15_000),
})
if (!response.ok) {
  console.error(`rotate-github-token: token validation failed with HTTP ${response.status}`)
  process.exit(1)
}
const user = await response.json()
const parsed = JSON.parse(readFileSync(path, 'utf8'))
const secrets = Array.isArray(parsed.secrets) ? parsed.secrets : []
const entry = secrets.find((item) => item?.name === 'GITHUB_TOKEN')
if (entry === undefined) {
  console.error('rotate-github-token: GITHUB_TOKEN entry not found')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
copyFileSync(path, `${path}.bak-${stamp}`)
entry.value = token
entry.updatedAt = new Date().toISOString()
writeFileSync(`${path}.tmp`, JSON.stringify(parsed, null, 2) + '\n', { mode: 0o600 })
renameSync(`${path}.tmp`, path)
console.log(`rotate-github-token: updated GITHUB_TOKEN for @${user.login}; revoke the old token in GitHub settings`)
