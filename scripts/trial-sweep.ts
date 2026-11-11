#!/usr/bin/env node
// #265: operator entry point for the preview-trial sweep. Prints the login and
// the registration date only — no address, no token — so the output can be
// pasted into a ticket.
import { loadConfig } from '../src/config.js'
import { openStore } from '../src/db.js'
import { createMailer } from '../src/email/mailer.js'
import { TRIAL_DAYS } from '../src/lib/trials.js'
import { sweepExpiredTrials } from '../src/users/trial.js'

const usage = 'usage: npm run trial:sweep -- [--dry-run] [--login <github-login>]'
const args = process.argv.slice(2)
const known = new Set<string>()
let dryRun = false
let login: string | undefined

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!
  if (arg === '--dry-run') {
    dryRun = true
    known.add(arg)
    continue
  }
  if (arg === '--login') {
    const value = args[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      console.error(`--login needs a GitHub login\n${usage}`)
      process.exit(1)
    }
    login = value
    known.add(arg)
    known.add(value)
    index += 1
    continue
  }
  if (!known.has(arg)) {
    console.error(`unknown argument: ${arg}\n${usage}`)
    process.exit(1)
  }
}

const config = loadConfig()
const store = openStore(config.dbPath)
try {
  const mailer = createMailer(config)
  const result = await sweepExpiredTrials(store, mailer, config, { dryRun, login })
  console.log(`trial: approved accounts registered before ${result.cutoff} with no repository (${TRIAL_DAYS} days)`)
  for (const row of result.eligible) {
    console.log(`${result.dryRun ? 'would end' : 'ends'}: ${row.login} (registered ${row.created_at.slice(0, 10)})`)
  }
  console.log(
    `eligible: ${result.eligible.length}  rejected: ${result.rejected.length}  mailed: ${result.emailed}  failed: ${result.failed.length}`,
  )
  if (result.dryRun) console.log('dry run: nothing was written and no notice was sent')
  for (const failure of result.failed) console.log(`notice failed for ${failure.login}: ${failure.error}`)
} finally {
  store.close()
}
