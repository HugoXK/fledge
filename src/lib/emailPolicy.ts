/**
 * The one place that decides whether a finished job produces its own mail.
 *
 * The per-job message is the flood: a repository on a 15–60 minute cadence sent
 * one "任务完成" or "任务失败" mail per run, so a repository that failed every
 * fifteen minutes filled the owner's inbox overnight. The decision is pure so
 * the whole matrix can be asserted without a store, a mailer or a clock.
 *
 * The rules:
 *
 * - A scheduled success belongs to the daily digest. The owner can opt into a
 *   per-job success message, and the switch defaults off, so an existing user
 *   sees no change until they ask for one.
 * - A run a person started always mails. That is not the trigger: `followup`
 *   is also what a due repository's continuation produces (`decideNextJob()`
 *   returns it for any open work item, and `tick()` enqueues it), so ownership
 *   is recorded when the run is enqueued and read back from the row.
 * - A failure that already queued a transient retry mails nothing; the retry's
 *   result is the one worth reading, and the retry can fail again.
 * - Failures for one repository coalesce inside `cooldownMinutes`. A success
 *   closes the window whether or not it produced a mail, because the repository
 *   is healthy again and the next failure is news.
 *
 * The caller owns persistence: it reads the last failure mail for the
 * repository, passes it in, clears the window when `clearWindow` is set, and
 * records `nowMs` after a failure mail. That keeps this file free of the store
 * and of `Date.now()`.
 */

export type JobEmailStatus = 'succeeded' | 'failed'

export type JobEmailSkipReason =
  /** A scheduled success is carried by the daily digest and by nothing else. */
  | 'scheduled-success'
  /** The attempt queued a transient retry; wait for the retry's result. */
  | 'retry-pending'
  /** Another failure for this repository already mailed inside the window. */
  | 'cooldown'

export interface JobEmailInput {
  status: JobEmailStatus
  /** `jobs.trigger`: `manual`, `schedule` or `followup`. */
  trigger: string
  /**
   * `jobs.owner_started === 1`: a person enqueued this run from the console
   * (a manual run, or the retry/resume button). A `followup` a schedule started
   * carries no mark, because nobody acted.
   */
  ownerStarted: boolean
  /** True when this failed attempt queued a retry, so this is not the last word. */
  retryPending: boolean
  /** `users.email_job_success === 1`. Defaults off for every existing user. */
  successEmailEnabled: boolean
  /** When the last failure mail for this repository went out, epoch ms, or null. */
  lastFailureMailAtMs: number | null
  nowMs: number
  cooldownMinutes: number
  /**
   * When the user's quiet-hours window ends, epoch ms, or null when no window
   * contains `nowMs`. The caller computes it with `quietHoursDueAt`; a
   * scheduled mail that would otherwise send is deferred to this instant.
   */
  quietHoursEndsAtMs?: number | null
}

export type JobEmailDecision =
  | { send: true; template: 'success' | 'failure'; clearWindow: boolean }
  | { send: false; reason: JobEmailSkipReason; clearWindow: boolean }
  /**
   * The mail exists but its send is held until the quiet-hours window ends.
   * `template` and `clearWindow` carry what an immediate send would have done.
   */
  | { send: false; reason: 'quiet-hours'; template: 'success' | 'failure'; clearWindow: boolean; dueAtMs: number }


/**
 * `manual` is a person by construction: every enqueue of it is a console route.
 * `followup` is not — `tick()` reaches it through `decideNextJob()` — so it is
 * only a person's run when the caller marked it (`jobs.owner_started`), which is
 * what the retry/resume button does. Keeping `manual` here also keeps rows
 * written before the mark existed on the owner's side of the policy.
 */
export function isOwnerStartedRun(input: { trigger: string; ownerStarted: boolean }): boolean {
  return input.ownerStarted || input.trigger === 'manual'
}

/** Strict `HH:MM` in 24-hour form; anything that does not parse is not a window. */
function clockMinutes(value: string): number | null {
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value)
  if (match === null) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/** The local wall clock in `timeZone`, as seconds since that day's midnight. */
function localSecondsOfDay(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(new Date(nowMs))
    const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value ?? Number.NaN)
    const hour = part('hour')
    const minute = part('minute')
    const second = part('second')
    if (![hour, minute, second].every((value) => Number.isFinite(value))) return null
    return hour * 3600 + minute * 60 + second
  } catch {
    return null
  }
}

/**
 * #1069: the instant a quiet-hours window ends when `nowMs` sits inside it,
 * or null when the window is absent, malformed or does not contain `nowMs`.
 *
 * The window is wall-clock time in `timeZone` (the digest's zone, because that
 * is the clock the user already reads). A start equal to the end is "no window"
 * rather than a full day, and a malformed value never holds a mail: a bad
 * setting must not become a permanent mute.
 */
export function quietHoursDueAt(input: {
  nowMs: number
  start: string
  end: string
  timeZone: string
}): number | null {
  const start = clockMinutes(input.start)
  const end = clockMinutes(input.end)
  if (start === null || end === null || start === end) return null
  const local = localSecondsOfDay(input.nowMs, input.timeZone)
  if (local === null) return null

  const startSeconds = start * 60
  const endSeconds = end * 60
  const inside = start < end
    ? local >= startSeconds && local < endSeconds
    : local >= startSeconds || local < endSeconds
  if (!inside) return null

  let deltaSeconds = endSeconds - local
  if (deltaSeconds <= 0) deltaSeconds += 24 * 3600
  return input.nowMs + deltaSeconds * 1000
}

function quietHoursDeferral(
  input: JobEmailInput,
  template: 'success' | 'failure',
  clearWindow: boolean,
): { send: false; reason: 'quiet-hours'; template: 'success' | 'failure'; clearWindow: boolean; dueAtMs: number } | null {
  const dueAtMs = input.quietHoursEndsAtMs
  if (dueAtMs === null || dueAtMs === undefined || !Number.isFinite(dueAtMs)) return null
  return { send: false, reason: 'quiet-hours', template, clearWindow, dueAtMs }
}

export function jobEmailDecision(input: JobEmailInput): JobEmailDecision {
  if (input.status === 'succeeded') {
    if (isOwnerStartedRun(input)) return { send: true, template: 'success', clearWindow: true }
    if (!input.successEmailEnabled) return { send: false, reason: 'scheduled-success', clearWindow: true }
    const deferred = quietHoursDeferral(input, 'success', true)
    return deferred ?? { send: true, template: 'success', clearWindow: true }
  }
  // The retry is the next word, so this failure is not the one to send.
  if (input.retryPending) return { send: false, reason: 'retry-pending', clearWindow: false }
  // The owner acted himself and wants to know the result; a coalescing window
  // must never swallow a run he started by hand.
  if (isOwnerStartedRun(input)) return { send: true, template: 'failure', clearWindow: false }
  const since = input.lastFailureMailAtMs
  // A non-positive or absent window is "coalescing off", not "suppress
  // everything": a bad setting must never silence a failure.
  const windowMs = Number.isFinite(input.cooldownMinutes) && input.cooldownMinutes > 0 ? input.cooldownMinutes * 60_000 : 0
  if (windowMs > 0 && since !== null && input.nowMs - since < windowMs) {
    return { send: false, reason: 'cooldown', clearWindow: false }
  }
  const deferred = quietHoursDeferral(input, 'failure', false)
  return deferred ?? { send: true, template: 'failure', clearWindow: false }
}
