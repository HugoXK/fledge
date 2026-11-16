// #544 slice 7: the two transports behind the notification outbox.
//
// An email row names an account, not an address: the address is resolved again
// at delivery so a queued notification follows the user's current setting, and
// a revoked account receives nothing even if the row was written while it was
// approved. A webhook row carries no destination at all; the configured URL is
// read at send time for the same reason.
import type { Config } from '../config.js'
import type { Mailer } from '../email/mailer.js'
import { notifyEmail } from '../email/recipient.js'
import { NotificationWebhookError, postNotificationWebhook, type WebhookSafetyOptions } from '../lib/webhook.js'
import type { NotificationOutboxRow, Store } from '../db.js'
import type { OutboxSendResult, OutboxTransport } from './outbox.js'

interface EmailPayload {
  subject?: unknown
  text?: unknown
  html?: unknown
  replyTo?: unknown
}

function parsePayload(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * SMTP failures are classified by what the server actually said. A 4xx greeting
 * or content refusal is transient; a 5xx rejection is a permanent decision by
 * the server; anything else (a socket timeout, a connection reset) may have
 * crossed the commit boundary, so it is `unknown` rather than a guess.
 */
export function classifyEmailError(error: unknown): 'retry' | 'dead' | 'unknown' {
  const code = typeof error === 'object' && error !== null
    ? Number((error as { responseCode?: unknown }).responseCode)
    : Number.NaN
  if (Number.isFinite(code) && code >= 400 && code < 500) return 'retry'
  if (Number.isFinite(code) && code >= 500 && code < 600) return 'dead'
  return 'unknown'
}

export function emailTransport(store: Store, mailer: Mailer): OutboxTransport {
  return {
    async send(row: NotificationOutboxRow): Promise<OutboxSendResult> {
      const user = row.user_id === null ? undefined : store.userById(row.user_id)
      if (user === undefined || user.status !== 'approved') return { state: 'blocked', error: 'recipient-inactive' }
      const to = notifyEmail(user)
      if (to === '') return { state: 'blocked', error: 'recipient-missing' }
      const payload = parsePayload(row.payload_json) as EmailPayload | null
      const subject = text(payload?.subject)
      const body = text(payload?.text)
      if (payload === null || subject === undefined || body === undefined) {
        return { state: 'dead', error: 'invalid-payload' }
      }
      const html = text(payload.html)
      const replyTo = text(payload.replyTo)
      try {
        await mailer.send({
          to,
          subject,
          text: body,
          ...(html === undefined ? {} : { html }),
          ...(replyTo === undefined ? {} : { replyTo }),
        })
        return { state: 'sent' }
      } catch (error) {
        return { state: classifyEmailError(error), error: String(error) }
      }
    },
  }
}

/** 2xx accepted it; 429/5xx are transient; every other answer is a refusal. */
export function classifyWebhookStatus(status: number): 'sent' | 'retry' | 'dead' {
  if (status >= 200 && status < 300) return 'sent'
  if (status === 429 || status >= 500) return 'retry'
  return 'dead'
}

export function webhookTransport(config: Config, options: WebhookSafetyOptions = {}): OutboxTransport {
  return {
    async send(row: NotificationOutboxRow): Promise<OutboxSendResult> {
      if (config.notifyWebhookUrl === '') return { state: 'blocked', error: 'destination-unset' }
      const payload = parsePayload(row.payload_json)
      if (payload === null) return { state: 'dead', error: 'invalid-payload' }
      const event = text(payload.event) ?? 'notification'
      try {
        return { state: classifyWebhookStatus(await postNotificationWebhook(config, event, payload, options)) }
      } catch (error) {
        if (error instanceof NotificationWebhookError) {
          return { state: error.kind, error: error.message }
        }
        return { state: 'retry', error: String(error) }
      }
    },
  }
}
