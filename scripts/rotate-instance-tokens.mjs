#!/usr/bin/env node
// Rotate the Fledge-managed bridge and per-instance gateway tokens.
//
//   node --env-file=.env scripts/rotate-instance-tokens.mjs
//   node --env-file=.env scripts/rotate-instance-tokens.mjs --dry-run
//
// This rotates BRIDGE_TOKEN and FLEDGE_GATEWAY_TOKEN in each ready instance's
// bridge.env, the encrypted bridge token in repo_instances, and the matching
// api_tokens row. It refuses to run while a job is active unless --force is
// passed. The GitHub PAT used by the dev routine is not managed here; rotate it
// in GitHub settings and replace it in ~/.dsh/bot/secrets.json.

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from '../dist/config.js'
import { Store } from '../dist/db.js'
import { InstanceManager } from '../dist/flybot/instances.js'
import { encryptSecret, randomToken, sha256Hex } from '../dist/lib/secrets.js'
import { nowIso } from '../dist/lib/time.js'

const dryRun = process.argv.includes('--dry-run')
const force = process.argv.includes('--force')

function upsertEnv(text, values) {
  const seen = new Set()
  const lines = text.split(/\r?\n/).filter((line) => line !== '')
  const next = lines.map((line) => {
    const index = line.indexOf('=')
    if (index <= 0) return line
    const key = line.slice(0, index)
    if (!(key in values)) return line
    seen.add(key)
    return `${key}=${values[key]}`
  })
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${value}`)
  }
  return next.join('\n') + '\n'
}

const config = loadConfig()
const store = new Store(config.dbPath)
const manager = new InstanceManager(store, config)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')

try {
  const instances = store.listRepoInstances().filter((instance) => instance.status === 'ready')
  if (!dryRun) {
    const active = store.countActiveJobs()
    if (active > 0 && !force) {
      console.error(`rotate-instance-tokens: refusing to rotate while ${active} job(s) are active; finish them or pass --force`)
      process.exit(2)
    }
  }
  if (instances.length === 0) {
    console.log('rotate-instance-tokens: no ready instances')
    process.exit(0)
  }
  for (const instance of instances) {
    const repo = store.getRepo(instance.repo_id)
    const label = repo === undefined ? instance.repo_id : `${repo.owner}/${repo.name}`
    const envPath = join(dirname(instance.data_dir), 'bridge.env')
    if (dryRun) {
      console.log(`would rotate ${label}`)
      continue
    }
    const oldEnv = readFileSync(envPath, 'utf8')
    const oldBridgeEnc = instance.bridge_token_enc
    const bridgeToken = randomToken(32)
    const gatewayToken = `flg_${randomToken(32)}`
    copyFileSync(envPath, `${envPath}.bak-${stamp}`)
    writeFileSync(envPath, upsertEnv(oldEnv, { BRIDGE_TOKEN: bridgeToken, FLEDGE_GATEWAY_TOKEN: gatewayToken }), { mode: 0o600 })
    store.updateRepoInstance(instance.repo_id, { bridge_token_enc: encryptSecret(bridgeToken, config.tokenEncryptionKey), updated_at: nowIso() })
    const newToken = store.createApiToken({
      id: `tok_${randomToken(8)}`,
      userId: instance.user_id,
      kind: 'instance',
      name: `flybot:${instance.repo_id}`,
      tokenHash: sha256Hex(gatewayToken),
      prefix: gatewayToken.slice(0, 8),
      repoId: instance.repo_id,
      expiresAt: null,
    })
    try {
      await manager.restartBridge(instance.repo_id)
      for (const token of store.listApiTokens(instance.user_id)) {
        if (token.kind === 'instance' && token.name === `flybot:${instance.repo_id}` && token.revoked_at === null && token.id !== newToken.id) {
          store.revokeApiToken(token.id, token.user_id)
        }
      }
      store.audit(instance.user_id, 'flybot.tokens.rotated', instance.repo_id)
      console.log(`rotated ${label}`)
    } catch (error) {
      writeFileSync(envPath, oldEnv, { mode: 0o600 })
      store.updateRepoInstance(instance.repo_id, { bridge_token_enc: oldBridgeEnc ?? '', updated_at: nowIso() })
      store.revokeApiToken(newToken.id, newToken.user_id)
      await manager.restartBridge(instance.repo_id).catch(() => {})
      console.error(`rolled back ${label}: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
} finally {
  store.close()
}
