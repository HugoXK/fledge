import type { Config } from '../config.js'
import { log } from './log.js'
import { nowIso } from './time.js'

export async function sendNotificationWebhook(config: Config, event: string, payload: Record<string, unknown>): Promise<void> {
  if (config.notifyWebhookUrl === '') return
  try {
    const text = typeof payload.text === 'string' ? payload.text : `${event}: ${JSON.stringify(payload).slice(0, 500)}`
    await fetch(config.notifyWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'fledge/0.2',
        ...(config.notifyWebhookSecret === '' ? {} : { authorization: `Bearer ${config.notifyWebhookSecret}` }),
      },
      body: JSON.stringify({ event, at: nowIso(), text, ...payload }),
      signal: AbortSignal.timeout(5_000),
    })
  } catch (error) {
    log.warn('notification webhook failed', { event, error: String(error) })
  }
}
