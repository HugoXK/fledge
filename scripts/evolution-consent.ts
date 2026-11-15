#!/usr/bin/env node
// #425: the consent switch. A repository enters an evolution dataset only when an
// admin or superadmin turns it on here; the change is audited and the exporter
// reads nothing else. `#235` owns the settings-card control, so this slice ships
// the operator path only.
//
// Run with tsx: `npm run evolution:consent -- --repo owner/name --on --actor <login>`
import { loadConfig } from '../src/config.js'
import { openStore } from '../src/db.js'

function arg(name: string, fallback = ''): string {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback)
}

const repoName = arg('--repo', '').trim()
const on = process.argv.includes('--on')
const off = process.argv.includes('--off')
const actorLogin = arg('--actor', process.env.EVOLUTION_ACTOR ?? '').trim()

if (repoName === '' || on === off || actorLogin === '') {
  console.error('usage: npm run evolution:consent -- --repo <owner/name> <--on|--off> --actor <github-login>')
  process.exit(1)
}

const config = loadConfig()
const store = openStore(config.dbPath)
try {
  const actor = store.userByLogin(actorLogin)
  if (actor === undefined) throw new Error(`actor not found: ${actorLogin}`)
  // The operator path is audited; the role check is what keeps a non-admin from
  // widening the dataset, exactly as the console would.
  if (actor.role !== 'admin' && actor.role !== 'superadmin') {
    throw new Error(`refused: ${actorLogin} is ${actor.role}, and consent is admin-only`)
  }
  const target = store.listEvolutionConsent().find((row) => row.repo.toLowerCase() === repoName.toLowerCase())
  if (target === undefined) throw new Error(`repository not found: ${repoName}`)
  store.setRepoEvolutionConsent(target.repoId, on, actor.id)
  console.log(`consent ${on ? 'on' : 'off'}: ${target.repo}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  store.close()
}
