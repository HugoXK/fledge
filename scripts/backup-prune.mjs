#!/usr/bin/env node
// #692: which backup copies a run with the configured keep counts would take.
//
// The production host wrapper kept its own retention number and never collected
// the plaintext copy or its sidecars, so the policy lived outside the repository
// and could regress silently. This scan reads the same counts the console shows
// (`BACKUP_KEEP_PLAINTEXT`, `BACKUP_KEEP_ENCRYPTED`) and decides what the next
// run would take without removing anything: deletion stays the owner's, and it
// stays out of this tip until an `--apply` mode exists and is approved.
import { resolve, join } from 'node:path'
import {
  DEFAULT_KEEP_ENCRYPTED,
  DEFAULT_KEEP_PLAINTEXT,
  planBackupExpiry,
} from './lib/backup-manifest.mjs'

const USAGE = 'usage: node scripts/backup-prune.mjs [--backup-dir <dir>] [--keep-plaintext <n>] [--keep-encrypted <n>] [--json] [--dry-run]'

function fail(code, message) {
  process.stderr.write(`backup-prune: ${message}\n`)
  process.exit(code)
}

function keepCount(name, raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) fail(2, `${name} must be a positive whole number, got ${raw}`)
  return value
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else if (arg === '--backup-dir') {
      index += 1
      parsed.backupDir = argv[index]
    } else if (arg === '--keep-plaintext') {
      index += 1
      parsed.keepPlaintext = argv[index]
    } else if (arg === '--keep-encrypted') {
      index += 1
      parsed.keepEncrypted = argv[index]
    } else if (arg === '--json') {
      parsed.json = true
    } else if (arg === '--dry-run') {
      // The default, accepted so a runbook can say it out loud.
      parsed.dryRun = true
    } else {
      fail(2, `unknown argument ${arg}\n${USAGE}`)
    }
  }
  return parsed
}

const args = parseArgs(process.argv.slice(2))
const dir = resolve(args.backupDir ?? process.env.BACKUP_DIR ?? join(process.env.DATA_DIR ?? './data', 'backups'))
const keepPlaintext = keepCount('--keep-plaintext', args.keepPlaintext ?? process.env.BACKUP_KEEP_PLAINTEXT, DEFAULT_KEEP_PLAINTEXT)
const keepEncrypted = keepCount('--keep-encrypted', args.keepEncrypted ?? process.env.BACKUP_KEEP_ENCRYPTED, DEFAULT_KEEP_ENCRYPTED)

const plan = planBackupExpiry({ dir, keepPlaintext, keepEncrypted })

if (args.json) {
  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    dir: plan.dir,
    keep: plan.keep,
    scanned: plan.scanned,
    expiredCopies: plan.expiredCopies,
    candidateCount: plan.candidateCount,
    candidates: plan.candidates,
  }, null, 2)}\n`)
  process.exit(0)
}

process.stdout.write(`backup-prune: dry run on ${plan.dir}, nothing deleted\n`)
for (const candidate of plan.candidates) {
  process.stdout.write(`${candidate.kind} ${candidate.path} class=${candidate.class} age=${candidate.ageHours}h reason=${candidate.reason}\n`)
}
process.stdout.write(`scanned=${plan.scanned.plaintext + plan.scanned.encrypted} expired=${plan.expiredCopies} candidates=${plan.candidateCount}\n`)
