// #814: the reporter-facing side of the triage lifecycle. The Lead writes a
// decision through the token-authenticated API; this module delivers the
// in-app/email update and, when the running version catches up with
// `fixed_version`, the final "now live" message once.
import type { Store } from '../db.js'
import type { Mailer } from '../email/mailer.js'
import { notifyEmail } from '../email/recipient.js'
import { feedbackUpdateMail } from '../email/templates.js'
import { compareVersions } from '../releases/release.js'
import { log } from '../lib/log.js'
import { redact } from '../lib/secrets.js'
import { nowIso } from '../lib/time.js'
import { VERSION } from '../version.js'

export async function notifyFeedbackReporter(input: {
  store: Store
  mailer: Mailer
  ref: string
  userId: string | null
  status: string
  userMessage: string
  issueUrl?: string | null
  prUrl?: string | null
  releasedVersion?: string | null
}): Promise<void> {
  if (input.userId === null || input.userMessage.trim() === '') return
  input.store.notify(input.userId, 'feedback', input.userMessage.slice(0, 500), `feedback:${input.status}`)
  const user = input.store.userById(input.userId)
  const to = user === undefined ? '' : notifyEmail(user)
  if (to !== '') {
    try {
      await input.mailer.send({
        to,
        ...feedbackUpdateMail({
          ref: input.ref,
          status: input.status,
          userMessage: input.userMessage,
          issueUrl: input.issueUrl ?? null,
          prUrl: input.prUrl ?? null,
          releasedVersion: input.releasedVersion ?? null,
        }),
      })
    } catch (error) {
      log.warn('feedback update mail failed', { ref: input.ref, error: redact(String(error)) })
    }
  }
  input.store.updateFeedbackTriage(input.ref, { last_notified_status: input.status, notified_at: nowIso() })
}

export async function notifyReleasedFeedback(input: {
  store: Store
  mailer: Mailer
  currentVersion?: string
}): Promise<number> {
  const current = input.currentVersion ?? VERSION
  let sent = 0
  for (const row of input.store.listFeedbackForRelease(50)) {
    if (row.fixed_version === null) continue
    try {
      if (compareVersions(row.fixed_version, current) > 0) continue
    } catch {
      continue
    }
    if (!input.store.markFeedbackReleased(row.ref, current)) continue
    const message = `你反馈的问题已在 v${current} 修复并上线。${row.issue_url === null ? '' : ` issue：${row.issue_url}`}${row.pr_url === null ? '' : ` PR：${row.pr_url}`}`
    await notifyFeedbackReporter({
      store: input.store,
      mailer: input.mailer,
      ref: row.ref,
      userId: row.user_id,
      status: 'released',
      userMessage: message,
      issueUrl: row.issue_url,
      prUrl: row.pr_url,
      releasedVersion: current,
    })
    input.store.addFeedbackEvent(row.ref, 'released', `v${current}`, 'system')
    sent += 1
  }
  return sent
}
