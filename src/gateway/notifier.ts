import type { Config } from '../config.js'
import type { Store, UserRow } from '../db.js'
import type { Mailer } from '../email/mailer.js'
import { quotaExhaustedEmail } from '../email/templates.js'
import { log } from '../lib/log.js'

export class QuotaNotifier {
  constructor(
    private readonly store: Store,
    private readonly mailer: Mailer,
    private readonly config: Config,
  ) {}

  async notify(user: UserRow): Promise<void> {
    const today = new Date().toISOString().slice(0, 10)
    const key = `quota_notified:${user.id}`
    if (this.store.getSetting(key) === today) return
    this.store.setSetting(key, today)
    this.store.notify(user.id, 'quota', '平台额度已用完，请到 Settings → Model 配置你自己的模型 API。')
    if (user.email === null || user.email === '') return
    try {
      await this.mailer.send({ to: user.email, ...quotaExhaustedEmail(user) })
    } catch (error) {
      log.warn('quota notice failed', { user: user.login, error: String(error) })
    }
  }
}
