#!/usr/bin/env node
// #265: operator entry point for the preview-trial sweep. Prints the login and
// the registration date only — no address, no token — so the output can be
// pasted into a ticket.
//
// #690: `--purge-dry-run` prints the purge candidates and their counts without
// deleting anything. It is a dry run of the whole sweep, because a preview that
// still rejected and mailed accounts would be a write dressed as a report.
import { loadConfig } from '../src/config.js'
import { openStore } from '../src/db.js'
import { createMailer } from '../src/email/mailer.js'
import { TRIAL_DAYS } from '../src/lib/trials.js'
import { sweepExpiredTrials } from '../src/users/trial.js'

const usage = 'usage: npm run trial:sweep -- [--dry-run] [--purge-dry-run] [--login <github-login>]'
const args = process.argv.slice(2)
const known = new Set<string>()
let dryRun = false
let purgeDryRun = false
let login: string | undefined

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]!
  if (arg === '--dry-run') {
    dryRun = true
    known.add(arg)
    continue
  }
  if (arg === '--purge-dry-run') {
    // The purge preview reads the same store, so it is the same dry run: nothing
    // is rejected, mailed, or deleted.
    purgeDryRun = true
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
  // #823: state the scope before anything is written, so a hand-run sweep says
  // which accounts it may touch before the deletions happen, not after.
  if (login !== undefined) console.log(`scope: login=${login} — only this account is considered by both phases`)
  const result = await sweepExpiredTrials(store, mailer, config, { dryRun, purgeDryRun, login })
  console.log(`trial: approved accounts registered before ${result.cutoff} with no repository (${TRIAL_DAYS} days)`)
  for (const row of result.eligible) {
    console.log(`${result.dryRun ? 'would end' : 'ends'}: ${row.login} (registered ${row.created_at.slice(0, 10)})`)
  }
  console.log(
    `eligible: ${result.eligible.length}  rejected: ${result.rejected.length}  mailed: ${result.emailed}  failed: ${result.failed.length}`,
  )
  if (result.dryRun) console.log('dry run: nothing was written and no notice was sent')
  for (const failure of result.failed) console.log(`notice failed for ${failure.login}: ${failure.error}`)

  // #690: the purge phase. The grace window is measured from the rejection's
  // audit row, so these are accounts rejected at least `graceHours` ago.
  const purge = result.purge
  console.log(`purge: rejected accounts past ${purge.graceHours}h, erased unless they used the platform`)
  for (const row of purge.candidates) {
    const used = row.repos + row.jobs + row.instances + row.installations > 0
    const counts = `repos ${row.repos}, jobs ${row.jobs}, instances ${row.instances}, installations ${row.installations}`
    console.log(`${purge.dryRun ? 'would purge' : used ? 'keeps' : 'purges'}: ${row.login} (${counts})`)
  }
  console.log(`purge candidates: ${purge.candidates.length}  purged: ${purge.purged.length}  skipped: ${purge.skipped.length}  failed: ${purge.failed.length}`)
  for (const skip of purge.skipped) console.log(`kept ${skip.login}: ${skip.reason}`)
  for (const failure of purge.failed) console.log(`purge failed for ${failure.login}: ${failure.error}`)
} finally {
  store.close()
}
