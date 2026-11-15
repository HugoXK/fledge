import type { Config } from '../config.js'
import type { Store, TrialExpiryCandidate, TrialPurgeCandidate } from '../db.js'
import { trialExpiredEmail } from '../email/templates.js'
import type { Mailer } from '../email/mailer.js'
import { log } from '../lib/log.js'
import { TRIAL_DAYS } from '../lib/trials.js'

// #265: the recurring preview-trial sweep. One writer, one rule: an approved
// account that never connected a repository loses access after TRIAL_DAYS, is
// audited with `trial.expired`, and is told once. The audit row is the
// idempotency record — the console (#279) already reads it, so there is no
// second timestamp column and no state bit that can drift.
//
// #690: the same sweep then erases the account once the rejection is old enough,
// under owner option 2 from #689 — every row that names the account goes and one
// non-PII retention row stays. Still no state column: the retention row is the
// record, exactly as the rejection row is.

export interface TrialSweepOptions {
  now?: Date
  dryRun?: boolean
  login?: string
  /** #690: report the purge candidates without deleting anything. */
  purgeDryRun?: boolean
}

/** #690: why an expired account was left in place. No login, email or token. */
export interface TrialPurgeSkip {
  login: string
  reason: string
  repos: number
  jobs: number
  instances: number
  installations: number
}

export interface TrialPurgePhaseResult {
  dryRun: boolean
  graceHours: number
  cutoff: string
  candidates: TrialPurgeCandidate[]
  purged: string[]
  skipped: TrialPurgeSkip[]
  failed: Array<{ login: string; error: string }>
}

export interface TrialSweepResult {
  dryRun: boolean
  cutoff: string
  eligible: TrialExpiryCandidate[]
  rejected: string[]
  emailed: number
  failed: Array<{ login: string; error: string }>
  /** #690: the purge phase that follows the rejection phase in the same run. */
  purge: TrialPurgePhaseResult
}

export function trialCutoff(now: Date): string {
  return new Date(now.getTime() - TRIAL_DAYS * 86_400_000).toISOString()
}

function blockersOf(counts: { repos: number; jobs: number; instances: number; installations: number }): number {
  return counts.repos + counts.jobs + counts.instances + counts.installations
}

// The skip detail names the blocking resources and their counts, never the
// account: the audit row already carries the id while the account still exists.
function skipReason(counts: { repos: number; jobs: number; instances: number; installations: number }): string {
  const parts: string[] = []
  if (counts.repos > 0) parts.push(`${counts.repos} repo(s)`)
  if (counts.jobs > 0) parts.push(`${counts.jobs} job(s)`)
  if (counts.instances > 0) parts.push(`${counts.instances} instance(s)`)
  if (counts.installations > 0) parts.push(`${counts.installations} installation(s)`)
  return `used the platform: ${parts.join(', ')}`
}

// #690: the purge phase. It runs after the rejection phase so a freshly rejected
// account is not erased in the same pass — the grace window is measured from the
// `trial.expired` row. Selection offers used accounts with their counts, because
// an account that gained a repository inside the window must be skipped with a
// recorded reason instead of silently disappearing from the list; the guard here
// re-reads the counts so usage that arrived after selection also wins.
export function purgeExpiredTrialAccounts(
  store: Store,
  config: Config,
  options: { now?: Date; dryRun?: boolean; login?: string } = {},
): TrialPurgePhaseResult {
  const now = options.now ?? new Date()
  const graceHours = config.trialPurgeGraceHours
  const cutoff = new Date(now.getTime() - graceHours * 3_600_000).toISOString()
  const offered = store.trialPurgeCandidates(now.toISOString(), graceHours)
  // #823: a run scoped with `--login` writes only for that login. The filter sits
  // on the selected candidates so the global timer path keeps its exact query and
  // a scoped run cannot reach an account it was not asked about.
  const candidates = options.login === undefined ? offered : offered.filter((row) => row.login === options.login)
  const result: TrialPurgePhaseResult = {
    dryRun: options.dryRun === true,
    graceHours,
    cutoff,
    candidates,
    purged: [],
    skipped: [],
    failed: [],
  }
  if (result.dryRun) return result

  for (const row of candidates) {
    const blockers = store.purgeBlockers(row.id)
    if (blockersOf(blockers) > 0) {
      const reason = skipReason(blockers)
      store.audit(row.id, 'trial.purge_skipped', JSON.stringify({ reason, counts: blockers }))
      result.skipped.push({ login: row.login, reason, ...blockers })
      continue
    }
    // Every step is idempotent by user id, so a run that dies here is retried by
    // the next sweep: the account is still a candidate until its rows are gone.
    try {
      store.purgeUserRows(row.id, { reason: 'trial.expired', operator: 'trial.sweep' })
      result.purged.push(row.login)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failed.push({ login: row.login, error: message })
      log.warn('trial purge failed', { login: row.login, error: message })
    }
  }

  return result
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
  const result: TrialSweepResult = {
    dryRun: options.dryRun === true,
    cutoff,
    eligible,
    rejected: [],
    emailed: 0,
    failed: [],
    purge: { dryRun: true, graceHours: config.trialPurgeGraceHours, cutoff: '', candidates: [], purged: [], skipped: [], failed: [] },
  }
  if (result.dryRun) {
    // A dry run writes nothing: report the purge candidates the same way the
    // rejection list is reported.
    result.purge = purgeExpiredTrialAccounts(store, config, { now, dryRun: true, login: options.login })
    return result
  }

  for (const row of eligible) {
    // Reject and audit as one write, before the mail: a restart between two
    // autocommitted statements would leave a rejected account with no
    // `trial.expired` row — `inactive` in the console, nothing to explain it and
    // nobody to mail. The mail stays outside the transaction, so the row is
    // committed before the notice leaves and a failed send still cannot cause a
    // second rejection on the next run.
    store.transaction(() => {
      store.setUserStatus(row.id, 'rejected', 'trial.sweep')
      store.audit(row.id, 'trial.expired', `no repository within ${TRIAL_DAYS} days of registration`)
    })
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

  result.purge = purgeExpiredTrialAccounts(store, config, { now, dryRun: options.purgeDryRun === true, login: options.login })
  return result
}
