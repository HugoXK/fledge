import type { Config } from '../config.js'
import type { Store, TrialExpiryCandidate } from '../db.js'
import { trialExpiredEmail } from '../email/templates.js'
import type { Mailer } from '../email/mailer.js'
import { log } from '../lib/log.js'
import { TRIAL_DAYS } from '../lib/trials.js'

// #265: the recurring preview-trial sweep. One writer, one rule: an approved
// account that never connected a repository loses access after TRIAL_DAYS, is
// audited with `trial.expired`, and is told once. The audit row is the
// idempotency record — the console (#279) already reads it, so there is no
// second timestamp column and no state bit that can drift.

export interface TrialSweepOptions {
  now?: Date
  dryRun?: boolean
  login?: string
}

export interface TrialSweepResult {
  dryRun: boolean
  cutoff: string
  eligible: TrialExpiryCandidate[]
  rejected: string[]
  emailed: number
  failed: Array<{ login: string; error: string }>
}

export function trialCutoff(now: Date): string {
  return new Date(now.getTime() - TRIAL_DAYS * 86_400_000).toISOString()
}

export async function sweepExpiredTrials(
  store: Store,
  mailer: Mailer,
  config: Config,
  options: TrialSweepOptions = {},
): Promise<TrialSweepResult> {
  const now = options.now ?? new Date()
  const cutoff = trialCutoff(now)
  const eligible = store.trialExpiryCandidates(cutoff, options.login)
  const result: TrialSweepResult = { dryRun: options.dryRun === true, cutoff, eligible, rejected: [], emailed: 0, failed: [] }
  if (result.dryRun) return result

  for (const row of eligible) {
    // Reject and audit before the mail: if the notice fails the account is still
    // ended and recorded, and the next run cannot mail it a second time.
    store.setUserStatus(row.id, 'rejected', 'trial.sweep')
    store.audit(row.id, 'trial.expired', `no repository within ${TRIAL_DAYS} days of approval`)
    result.rejected.push(row.login)

    const user = store.userById(row.id)
    if (user === undefined) continue
    try {
      await mailer.send({ to: user.email ?? config.mail.adminEmail, ...trialExpiredEmail(user, config.baseUrl) })
      result.emailed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failed.push({ login: row.login, error: message })
      log.warn('trial expiry notice failed', { login: row.login, error: message })
    }
  }

  return result
}
